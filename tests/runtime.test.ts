import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { chromium } from 'playwright';
import type { Session, WorkerMessage } from '@repropath/protocol';
import { BrowserRuntime } from '../apps/browser-worker/src/runtime.js';
import { until } from './helpers.js';

const state = (url: string): Session => ({ id: randomUUID(), status: 'starting', requestedUrl: url, currentUrl: '', pageTitle: '', createdAt: new Date().toISOString(), activePageId: null, viewport: { width: 1440, height: 900 }, screencast: { status: 'idle' } });
test('runtime isolation, cleanup, timeout, page crash and browser restart (real Chromium)', { timeout: 60_000 }, async t => {
  const server = createServer((request, response) => {
    if (request.url === '/hang') return;
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<title>Isolation fixture</title><h1>Local fixture</h1>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const messages: WorkerMessage[] = [];
  let browser = await chromium.launch();
  const runtime = new BrowserRuntime(message => messages.push(message), 300, async () => {
    if (!browser.isConnected()) browser = await chromium.launch();
    return browser;
  });
  t.after(() => runtime.closeAll());
  const latest = (id: string) => messages.filter(message => message.type === 'state' && message.session.id === id).at(-1);
  const status = (id: string) => { const message = latest(id); return message?.type === 'state' ? message.session.status : undefined; };
  await t.test('independent context, page, cookies and storage; dynamic page title', async () => {
    const a = state(base); const b = state(base); await Promise.all([runtime.start(a), runtime.start(b)]);
    assert.equal(browser.contexts().length, 2);
    const [contextA, contextB] = browser.contexts(); assert.ok(contextA && contextB);
    assert.notEqual(contextA.pages()[0], contextB.pages()[0]);
    await contextA.addCookies([{ name: 'private', value: 'A', url: base }]); assert.equal((await contextB.cookies()).length, 0);
    await contextA.pages()[0]!.evaluate(() => localStorage.setItem('private', 'A'));
    assert.equal(await contextB.pages()[0]!.evaluate(() => localStorage.getItem('private')), null);
    await contextA.pages()[0]!.evaluate(() => { document.title = 'Changed title'; });
    await until(() => messages.some(message => message.type === 'state' && message.session.pageTitle === 'Changed title'), 'dynamic title');
    await contextA.pages()[0]!.close();
    await until(() => [status(a.id), status(b.id)].includes('closed') && browser.contexts().length === 1, 'page close cleanup');
    await runtime.close(a.id); await runtime.close(b.id); assert.equal(browser.contexts().length, 0);
  });
  await t.test('navigation timeout releases context', async () => {
    const session = state(`${base}/hang`); await runtime.start(session);
    assert.equal(status(session.id), 'failed'); assert.equal(browser.contexts().length, 0);
  });
  await t.test('page crash produces failed state and releases context', async () => {
    const session = state(base); await runtime.start(session);
    const context = browser.contexts()[0]!; const cdp = await context.newCDPSession(context.pages()[0]!);
    void cdp.send('Page.crash').catch(() => {});
    await until(() => status(session.id) === 'failed' && browser.contexts().length === 0, 'page crash cleanup');
  });
  await t.test('browser disconnect terminates sessions and next start relaunches', async () => {
    const session = state(base); await runtime.start(session);
    const cdp = await browser.newBrowserCDPSession();
    void cdp.send('Browser.crash').catch(() => {});
    await until(() => ['closed', 'failed'].includes(status(session.id) ?? ''), 'browser disconnect terminal state');
    await until(() => !browser.isConnected(), 'browser actually crashed');
    const next = state(base); await runtime.start(next); assert.equal(status(next.id), 'running'); await runtime.close(next.id);
  });
  await t.test('closing while a session is starting does not leak its context', async () => {
    const session = state(base); const starting = runtime.start(session);
    await runtime.close(session.id); await starting;
    assert.equal(status(session.id), 'closed'); assert.equal(browser.contexts().length, 0);
  });
  await t.test('input reset releases modifiers and mouse buttons; stale Page cannot inject', async () => {
    const session = state(base); await runtime.start(session);
    const page = browser.contexts()[0]!.pages()[0]!;
    const current = latest(session.id); assert.ok(current?.type === 'state');
    const leaseId = randomUUID(); const pageId = current.session.activePageId!;
    await page.evaluate(() => {
      document.addEventListener('mousedown', event => console.log('buttons: ' + event.buttons));
      document.addEventListener('keydown', event => console.log('control-held: ' + event.ctrlKey));
    });
    await runtime.input({ type: 'browser-input', sessionId: session.id, pageId, leaseId, inputSequence: 1, input: { type: 'key', key: 'Control', action: 'down', modifiers: [] } });
    await runtime.input({ type: 'browser-input', sessionId: session.id, pageId, leaseId, inputSequence: 2, input: { type: 'pointer-down', x: 40, y: 40, button: 'left', buttons: 1 } });
    await runtime.resetInput(session.id);
    const nextLease = randomUUID();
    await runtime.input({ type: 'browser-input', sessionId: session.id, pageId, leaseId: nextLease, inputSequence: 1, input: { type: 'key', key: 'Enter', action: 'press', modifiers: [] } });
    await runtime.input({ type: 'browser-input', sessionId: session.id, pageId, leaseId: nextLease, inputSequence: 2, input: { type: 'pointer-down', x: 40, y: 40, button: 'right', buttons: 2 } });
    await until(() => messages.some(message => message.type === 'event' && message.event.type === 'console' && message.event.payload.text === 'control-held: false'), 'reset releases Control');
    await until(() => messages.some(message => message.type === 'event' && message.event.type === 'console' && message.event.payload.text === 'buttons: 2'), 'reset releases left button');
    await runtime.input({ type: 'browser-input', sessionId: session.id, pageId: 'P-stale', leaseId: nextLease, inputSequence: 3, input: { type: 'text', text: 'never-injected' } });
    assert.ok(messages.some(message => message.type === 'input-result' && message.code === 'STALE_PAGE'));
    await runtime.close(session.id); assert.equal(browser.contexts().length, 0);
  });
});
test('real launch failure is contained and reported', async () => {
  const messages: WorkerMessage[] = [];
  const runtime = new BrowserRuntime(message => messages.push(message), 1000, () => chromium.launch({ executablePath: 'missing-repropath-chromium-executable' }));
  const session = state('http://127.0.0.1/'); await runtime.start(session); await runtime.closeAll();
  assert.ok(messages.some(message => message.type === 'state' && message.session.status === 'failed' && message.session.error));
});
