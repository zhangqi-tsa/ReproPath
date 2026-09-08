import { randomUUID, createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { CreateSessionRequest, ClientMessageSchema, WorkerMessageSchema, DEFAULT_VIEWPORT, type BrowserFrame, type Session, type SessionEvent, type ServerMessage, type WorkerCommand } from '@repropath/protocol';
import { LatestFrameSender } from '@repropath/streaming';
import { fixturePage } from './fixture.js';
import { controlFixture } from './control-fixture.js';
import { HumanControl } from './human-control.js';
import { LocalArtifactStore, validArtifactId } from '@repropath/artifacts';
import { ActionStore } from './actions.js';
const actions = new ActionStore();
const artifacts = new LocalArtifactStore();

const port = Number(process.env.CONTROL_PORT ?? 4310);
const workerUrl = process.env.WORKER_URL ?? 'ws://127.0.0.1:4311/worker';
const webOrigin = process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173';
const sessions = new Map<string, { session: Session; events: SessionEvent[]; latestFrame?: BrowserFrame }>();
const subscriptions = new Map<WebSocket, string>();
const frameSenders = new Map<WebSocket, LatestFrameSender>();
const closingSessions = new Set<string>();
const clientAlive = new Map<WebSocket, boolean>();
let worker: WebSocket;
let stopping = false;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let workerAlive = true;
const controls = new HumanControl({ session: id => closingSessions.has(id) ? undefined : sessions.get(id)?.session, subscribers: subscriptions,
  ready: () => worker?.readyState === WebSocket.OPEN,
  writable: () => worker?.readyState === WebSocket.OPEN && worker.bufferedAmount < 256 * 1024,
  send, worker: command });
function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.close(1013, 'Slow consumer; reconnect to recover history'); return; }
  socket.send(JSON.stringify(message));
}
function broadcast(id: string, message: ServerMessage): void {
  for (const [socket, subscribedId] of subscriptions) if (subscribedId === id) send(socket, message);
}
function clearFrames(id: string): void {
  const record = sessions.get(id); if (record) record.latestFrame = undefined;
  for (const sender of frameSenders.values()) sender.forget(id);
}
function connectWorker(): void {
  worker = new WebSocket(workerUrl, { maxPayload: 4 * 1024 * 1024 });
  worker.on('open', () => { workerAlive = true; console.log('Browser Worker connected'); });
  worker.on('pong', () => { workerAlive = true; });
  worker.on('message', raw => {
    try {
      const message = WorkerMessageSchema.parse(JSON.parse(raw.toString()));
      if (message.type === 'input-result') { controls.result(message); return; }
      if (message.type === 'action-update') {
        if (sessions.has(message.action.sessionId)) { actions.update(message.action); broadcast(message.action.sessionId, message); }
        return;
      }
      if (message.type === 'browser-frame') {
        // ACK receipt immediately, independent of UI subscribers or their decode speed.
        command({ type: 'frame-ack', sessionId: message.sessionId, pageId: message.pageId, frameSequence: message.frameSequence });
        const record = sessions.get(message.sessionId);
        if (!record || record.session.status !== 'running' || record.session.activePageId !== message.pageId) return;
        if ((record.latestFrame?.frameSequence ?? 0) >= message.frameSequence) return;
        record.latestFrame = message;
        for (const [socket, id] of subscriptions) if (id === message.sessionId) frameSenders.get(socket)?.offer(message);
        return;
      }
      const id = message.type === 'state' ? message.session.id : message.event.sessionId;
      const record = sessions.get(id);
      if (!record || ['failed', 'closed'].includes(record.session.status)) return;
      if (message.type === 'state') {
        record.session = message.session;
        if (['closed', 'failed'].includes(message.session.status)) closingSessions.delete(id);
        if (['closed', 'failed'].includes(message.session.status)) controls.revoke(id, 'Session 已终止');
        if (['closed', 'failed'].includes(message.session.status) || message.session.screencast.status === 'unavailable') clearFrames(id);
      }
      else {
        if (message.event.sequence <= (record.events.at(-1)?.sequence ?? 0)) return;
        record.events.push(message.event);
        // Bound in-memory history; sequence numbers are never renumbered.
        if (record.events.length > 10_000) record.events.shift();
      }
      broadcast(id, message);
    } catch (error) { console.error('Invalid worker message:', error); }
  });
  worker.on('error', error => console.error('Worker connection:', error.message));
  worker.on('close', () => {
    closingSessions.clear();
    controls.revokeAll('Worker 连接已断开', false);
    for (const [id, record] of sessions) {
      if (!['starting', 'running'].includes(record.session.status)) continue;
      record.session = { ...record.session, status: 'failed', error: 'Browser Worker disconnected', screencast: { status: 'stopped' } };
      for (const action of actions.interrupt(id, record.events.at(-1)?.sequence ?? 0)) broadcast(id, { type: 'action-update', action });
      clearFrames(id);
      const event: SessionEvent = { id: randomUUID(), sessionId: id, sequence: (record.events.at(-1)?.sequence ?? 0) + 1,
        timestamp: new Date().toISOString(), type: 'lifecycle', payload: { status: 'failed', message: 'Browser Worker disconnected' } };
      record.events.push(event);
      broadcast(id, { type: 'event', event });
      broadcast(id, { type: 'state', session: record.session });
    }
    if (!stopping) reconnect = setTimeout(connectWorker, 1000);
  });
}
function command(message: WorkerCommand): void { worker.send(JSON.stringify(message)); }
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 16_384) throw new Error('Request body exceeds 16 KiB');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
  // Local tool: no remote binding, no arbitrary browser-origin API access.
  if (request.headers.origin && ![webOrigin, `http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin)) {
    json(response, 403, { error: 'Origin is not allowed' }); return;
  }
  if (request.headers.origin) response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); response.writeHead(204); response.end(); return;
  }
  if (path === '/health') { json(response, 200, { service: 'control', workerConnected: worker.readyState === WebSocket.OPEN }); return; }
  if (request.method === 'GET' && path.startsWith('/artifacts/')) {
    const id = path.slice('/artifacts/'.length); const ref = validArtifactId(id) ? actions.artifact(id) : undefined;
    if (!ref) { json(response, 404, { error: 'Artifact not found' }); return; }
    try {
      const data = await artifacts.read(id);
      if (data.length !== ref.byteLength || createHash('sha256').update(data).digest('hex') !== ref.sha256) throw new Error('Artifact integrity failure');
      response.writeHead(200, { 'Content-Type': ref.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }); response.end(data);
    } catch { json(response, 404, { error: 'Artifact unavailable' }); }
    return;
  }
  const actionPath = /^\/sessions\/([^/]+)\/actions(?:\/([^/]+))?$/.exec(path);
  if (request.method === 'GET' && actionPath?.[1]) {
    if (!sessions.has(actionPath[1])) { json(response, 404, { error: 'Session not found' }); return; }
    if (actionPath[2]) { const action = actions.get(actionPath[1], actionPath[2]); json(response, action ? 200 : 404, action ?? { error: 'Action not found' }); }
    else json(response, 200, actions.list(actionPath[1]));
    return;
  }
  if (request.method === 'GET' && path === '/test-page/control') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(controlFixture()); return;
  }
  if (request.method === 'GET' && ['/test-page', '/test-page/next', '/test-page/popup'].includes(path)) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(fixturePage(path.endsWith('/next'), path.endsWith('/popup'))); return;
  }
  if (request.method === 'GET' && path === '/fixture/api/user') { json(response, 200, { id: 'fixture-user', name: 'Local Test User' }); return; }
  if (request.method === 'GET' && ['/fixture/api/slow', '/fixture/api/late'].includes(path)) {
    const timer = setTimeout(() => json(response, 200, { ok: true }), path.endsWith('/slow') ? 1500 : 3000);
    response.on('close', () => clearTimeout(timer)); return;
  }
  if (request.method === 'POST' && path === '/sessions') {
    if (!request.headers['content-type']?.startsWith('application/json')) { json(response, 415, { error: 'Use Content-Type: application/json' }); return; }
    let input: unknown;
    try { input = await body(request); } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : 'Invalid JSON' }); return; }
    const parsed = CreateSessionRequest.safeParse(input);
    if (!parsed.success) { json(response, 400, { error: 'Provide a valid http:// or https:// URL without credentials' }); return; }
    if (worker.readyState !== WebSocket.OPEN) { json(response, 503, { error: 'Browser Worker is unavailable; retry shortly' }); return; }
    if (sessions.size >= 100) {
      const expired = [...sessions].find(([, value]) => ['closed', 'failed'].includes(value.session.status));
      if (expired) { clearFrames(expired[0]); actions.forget(expired[0]); sessions.delete(expired[0]); }
      else { json(response, 429, { error: 'Session limit reached; close a session first' }); return; }
    }
    const session: Session = { id: randomUUID(), status: 'starting', requestedUrl: parsed.data.url,
      currentUrl: '', pageTitle: '', createdAt: new Date().toISOString(), activePageId: null,
      viewport: { ...DEFAULT_VIEWPORT }, screencast: { status: 'idle' } };
    sessions.set(session.id, { session, events: [] });
    command({ type: 'start', session }); json(response, 201, session); return;
  }
  const match = /^\/sessions\/([^/]+)$/.exec(path);
  if (match?.[1]) {
    const record = sessions.get(match[1]);
    if (!record) { json(response, 404, { error: 'Session not found' }); return; }
    if (request.method === 'GET') { json(response, 200, record.session); return; }
    if (request.method === 'DELETE') {
      if (['closed', 'failed'].includes(record.session.status)) { json(response, 200, record.session); return; }
      if (worker.readyState !== WebSocket.OPEN) { json(response, 503, { error: 'Worker unavailable' }); return; }
      controls.revoke(record.session.id, '正在关闭 Session');
      // Prevent acquiring a fresh lease in the gap before Worker reports closed.
      closingSessions.add(record.session.id);
      command({ type: 'close', sessionId: record.session.id }); json(response, 202, { id: record.session.id }); return;
    }
  }
  json(response, 404, { error: 'Not found' });
}
const server = createServer((request, response) => {
  void handle(request, response).catch(error => {
    console.error('Control request:', error);
    if (!response.headersSent) json(response, 500, { error: 'Internal server error' }); else response.end();
  });
});
const wss = new WebSocketServer({ server, path: '/events', maxPayload: 16_384,
  verifyClient: (info: { origin: string }) => !info.origin || [webOrigin, `http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(info.origin),
});
wss.on('connection', socket => {
  clientAlive.set(socket, true); socket.on('pong', () => clientAlive.set(socket, true));
  const sender = new LatestFrameSender({ writable: () => socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 256 * 1024,
    send: frame => socket.send(JSON.stringify(frame)) });
  frameSenders.set(socket, sender);
  socket.on('message', raw => {
    try {
      const message = ClientMessageSchema.parse(JSON.parse(raw.toString()));
      if (message.type === 'frame-ack') { sender.acknowledge(message); return; }
      if (message.type === 'browser-input') { controls.input(socket, message); return; }
      if (message.type === 'control-acquire') { controls.acquire(message.sessionId, socket); return; }
      if (message.type === 'control-release') { controls.release(message.sessionId, socket, message.leaseId); return; }
      const record = sessions.get(message.sessionId);
      if (!record) { send(socket, { type: 'error', message: 'Session not found' }); return; }
      const previous = subscriptions.get(socket); if (previous && previous !== message.sessionId) { controls.disconnect(socket); sender.forget(previous); }
      subscriptions.set(socket, message.sessionId);
      // Same event-loop turn: snapshot is enqueued before any live events, with no subscription gap.
      send(socket, { type: 'snapshot', session: record.session, events: record.events });
      // A single current frame is sent separately, including for an unchanged/static page.
      if (record.latestFrame) sender.offer(record.latestFrame);
      controls.state(message.sessionId, socket);
    } catch { send(socket, { type: 'error', message: 'INVALID_INPUT: 无效客户端消息' }); }
  });
  socket.on('close', () => { controls.disconnect(socket); subscriptions.delete(socket); sender.dispose(); frameSenders.delete(socket); clientAlive.delete(socket); });
  socket.on('error', error => console.error('WebSocket client:', error.message));
});
const heartbeat = setInterval(() => {
  for (const [socket, alive] of clientAlive) {
    if (!alive) { socket.terminate(); continue; }
    clientAlive.set(socket, false); if (socket.readyState === WebSocket.OPEN) socket.ping();
  }
  if (worker.readyState !== WebSocket.OPEN) return;
  if (!workerAlive) { worker.terminate(); return; }
  workerAlive = false; worker.ping();
}, 5000);
connectWorker();
server.listen(port, '127.0.0.1', () => console.log(`Control API http://127.0.0.1:${port}`));
function shutdown(): void {
  controls.revokeAll('Control 正在关闭');
  stopping = true; clearInterval(heartbeat); clearTimeout(reconnect); worker.close();
  for (const socket of wss.clients) socket.close();
  for (const sender of frameSenders.values()) sender.dispose();
  wss.close(); server.close();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('message', message => { if (message === 'shutdown') { shutdown(); process.disconnect?.(); } });
