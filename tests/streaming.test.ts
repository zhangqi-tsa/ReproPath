import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type CDPSession } from 'playwright';
import { WebSocket } from 'ws';
import { BrowserFrameSchema, SessionEventSchema, WorkerMessageSchema, type BrowserFrame, type Session, type WorkerMessage } from '@repropath/protocol';
import { LatestFrameSender } from '@repropath/streaming';
import { BrowserRuntime } from '../apps/browser-worker/src/runtime.js';
import { freePort, ready, service, until } from './helpers.js';

const initial = (url: string): Session => ({ id: randomUUID(), status: 'starting', requestedUrl: url, currentUrl: '', pageTitle: '',
  createdAt: new Date().toISOString(), activePageId: null, viewport: { width: 1440, height: 900 }, screencast: { status: 'idle' } });
async function fixture() {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Live transport test</title><body style="background:#145a50;color:white"><h1 id="tick">0</h1><script>
      let tick = 0; setInterval(() => { document.querySelector('#tick').textContent = ++tick; }, 50);
      console.warn('warning retained');
    </script></body>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

test('CDP ACKs keep producing real frames under backpressure; bounded latest-frame sender; listener cleanup', { timeout: 30_000 }, async t => {
  const local = await fixture(); t.after(local.close);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const cdps: CDPSession[] = [];
  const realNewContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await realNewContext(options);
    const realCDP = context.newCDPSession.bind(context);
    context.newCDPSession = async page => { const cdp = await realCDP(page); cdps.push(cdp); return cdp; };
    return context;
  };
  const sent: BrowserFrame[] = []; const frames: BrowserFrame[] = []; const messages: WorkerMessage[] = [];
  let writable = false;
  const sender = new LatestFrameSender({ writable: () => writable, send: frame => sent.push(frame) });
  t.after(() => sender.dispose());
  const runtime = new BrowserRuntime(message => {
    if (message.type === 'browser-frame') { frames.push(message); sender.offer(message); } else messages.push(message);
  }, 3000, async () => browser);
  t.after(() => runtime.closeAll());
  const session = initial(local.url); await runtime.start(session);
  const context = browser.contexts()[0]!; const page = context.pages()[0]!;
  await until(() => frames.length >= 8, 'CDP keeps emitting with blocked transport');
  assert.equal(sent.length, 0); assert.equal(sender.stats.pending, 1); assert.equal(sender.stats.inFlight, 0);
  assert.ok(sender.stats.replaced >= 7);
  writable = true;
  await until(() => sent.length === 1, 'transport unblocks');
  const first = sent[0]!;
  await until(() => frames.length >= 16, 'CDP still emits without application ACK');
  assert.equal(sent.length, 1); assert.equal(sender.stats.pending, 1); assert.equal(sender.stats.inFlight, 1);
  // Stress replacement using a real Chromium JPEG; the transport queue remains one slot.
  const realFrame = frames.at(-1)!;
  for (let i = 0; i < 10_000; i++) sender.offer({ ...realFrame, frameSequence: realFrame.frameSequence + i });
  assert.equal(sender.stats.pending, 1); assert.equal(sender.stats.inFlight, 1);
  sender.acknowledge({ type: 'frame-ack', sessionId: first.sessionId, pageId: first.pageId, frameSequence: first.frameSequence });
  assert.equal(sent.length, 2); assert.equal(sent[1]?.frameSequence, realFrame.frameSequence + 9999);
  assert.equal(cdps.length, 1);
  const cdp = cdps[0]!;
  assert.ok('listenerCount' in cdp && typeof cdp.listenerCount === 'function');
  assert.equal(cdp.listenerCount('Page.screencastFrame'), 1);
  await runtime.close(session.id);
  assert.equal(browser.contexts().length, 0); assert.ok(page.isClosed()); assert.equal(context.pages().length, 0);
  assert.equal(cdp.listenerCount('Page.screencastFrame'), 0);
  const count = frames.length; await delay(250); assert.equal(frames.length, count);
  assert.ok(messages.some(message => message.type === 'state' && message.session.screencast.status === 'stopped'));
  assert.equal(SessionEventSchema.safeParse(realFrame).success, false);
  const request = messages.find(message => message.type === 'event' && message.event.type === 'request');
  assert.ok(request?.type === 'event');
  const { pageId: _pageId, ...withoutPage } = request.event as Extract<typeof request.event, { type: 'request' }>;
  assert.equal(SessionEventSchema.safeParse(withoutPage).success, false, 'Page identity is required at protocol boundary');
});

test('real Worker link drops frames for a slow Control, and Control disconnect stops the runtime', { timeout: 30_000 }, async t => {
  const local = await fixture(); t.after(local.close);
  const port = await freePort(); const worker = service('apps/browser-worker/src/index.ts', { WORKER_PORT: String(port) });
  t.after(() => worker.stop()); await ready(`http://127.0.0.1:${port}`);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/worker`); t.after(() => socket.close());
  const frames: BrowserFrame[] = []; const messages: WorkerMessage[] = [];
  socket.on('message', raw => {
    const message = WorkerMessageSchema.parse(JSON.parse(raw.toString()));
    if (message.type === 'browser-frame') frames.push(message); else messages.push(message);
  });
  await once(socket, 'open'); const session = initial(local.url);
  socket.send(JSON.stringify({ type: 'start', session }));
  await until(() => frames.length === 1, 'Worker first frame');
  await delay(700); assert.equal(frames.length, 1, 'only one frame in flight to Control');
  const first = frames[0]!;
  socket.send(JSON.stringify({ type: 'frame-ack', sessionId: first.sessionId, pageId: first.pageId, frameSequence: first.frameSequence }));
  await until(() => frames.length === 2, 'Worker latest frame after ACK');
  assert.ok(frames[1]!.frameSequence > first.frameSequence + 1, 'CDP ACKs continued while Control withheld ACK');
  assert.ok(BrowserFrameSchema.safeParse(frames[1]).success);
  const closed = once(socket, 'close'); socket.close(); await closed;
  // Reconnect starts only after cleanup, and must never deliver frames from the old Session.
  const nextSocket = new WebSocket(`ws://127.0.0.1:${port}/worker`); t.after(() => nextSocket.close());
  const nextMessages: WorkerMessage[] = [];
  nextSocket.on('message', raw => nextMessages.push(WorkerMessageSchema.parse(JSON.parse(raw.toString()))));
  await once(nextSocket, 'open'); const next = initial(local.url);
  nextSocket.send(JSON.stringify({ type: 'start', session: next }));
  await until(() => nextMessages.some(message => message.type === 'browser-frame'), 'new Session after disconnect');
  assert.ok(nextMessages.every(message => message.type === 'state' ? message.session.id === next.id : message.type === 'event' ? message.event.sessionId === next.id : message.sessionId === next.id));
  nextSocket.send(JSON.stringify({ type: 'close', sessionId: next.id }));
  await until(() => nextMessages.some(message => message.type === 'state' && message.session.status === 'closed'), 'worker closes new session');
});
