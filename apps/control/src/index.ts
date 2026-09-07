import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { CreateSessionRequest, SubscriptionSchema, WorkerMessageSchema, type Session, type SessionEvent, type ServerMessage, type WorkerCommand } from '@repropath/protocol';
import { fixturePage } from './fixture.js';

const port = Number(process.env.CONTROL_PORT ?? 4310);
const workerUrl = process.env.WORKER_URL ?? 'ws://127.0.0.1:4311/worker';
const webOrigin = process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173';
const sessions = new Map<string, { session: Session; events: SessionEvent[] }>();
const subscriptions = new Map<WebSocket, string>();
let worker: WebSocket;
let stopping = false;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let workerAlive = true;
function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.close(1013, 'Slow consumer; reconnect to recover history'); return; }
  socket.send(JSON.stringify(message));
}
function broadcast(id: string, message: ServerMessage): void {
  for (const [socket, subscribedId] of subscriptions) if (subscribedId === id) send(socket, message);
}
function connectWorker(): void {
  worker = new WebSocket(workerUrl, { maxPayload: 4 * 1024 * 1024 });
  worker.on('open', () => { workerAlive = true; console.log('Browser Worker connected'); });
  worker.on('pong', () => { workerAlive = true; });
  worker.on('message', raw => {
    try {
      const message = WorkerMessageSchema.parse(JSON.parse(raw.toString()));
      const id = message.type === 'state' ? message.session.id : message.event.sessionId;
      const record = sessions.get(id);
      if (!record || ['failed', 'closed'].includes(record.session.status)) return;
      if (message.type === 'state') record.session = message.session;
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
    for (const [id, record] of sessions) {
      if (!['starting', 'running'].includes(record.session.status)) continue;
      record.session = { ...record.session, status: 'failed', error: 'Browser Worker disconnected' };
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
  if (request.method === 'GET' && ['/test-page', '/test-page/next'].includes(path)) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(fixturePage(path.endsWith('/next'))); return;
  }
  if (request.method === 'GET' && path === '/fixture/api/user') { json(response, 200, { id: 'fixture-user', name: 'Local Test User' }); return; }
  if (request.method === 'POST' && path === '/sessions') {
    if (!request.headers['content-type']?.startsWith('application/json')) { json(response, 415, { error: 'Use Content-Type: application/json' }); return; }
    let input: unknown;
    try { input = await body(request); } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : 'Invalid JSON' }); return; }
    const parsed = CreateSessionRequest.safeParse(input);
    if (!parsed.success) { json(response, 400, { error: 'Provide a valid http:// or https:// URL without credentials' }); return; }
    if (worker.readyState !== WebSocket.OPEN) { json(response, 503, { error: 'Browser Worker is unavailable; retry shortly' }); return; }
    if (sessions.size >= 100) {
      const expired = [...sessions].find(([, value]) => ['closed', 'failed'].includes(value.session.status));
      if (expired) sessions.delete(expired[0]);
      else { json(response, 429, { error: 'Session limit reached; close a session first' }); return; }
    }
    const session: Session = { id: randomUUID(), status: 'starting', requestedUrl: parsed.data.url,
      currentUrl: '', pageTitle: '', createdAt: new Date().toISOString() };
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
  socket.on('message', raw => {
    try {
      const message = SubscriptionSchema.parse(JSON.parse(raw.toString()));
      const record = sessions.get(message.sessionId);
      if (!record) { send(socket, { type: 'error', message: 'Session not found' }); return; }
      subscriptions.set(socket, message.sessionId);
      // Same event-loop turn: snapshot is enqueued before any live events, with no subscription gap.
      send(socket, { type: 'snapshot', session: record.session, events: record.events });
    } catch { send(socket, { type: 'error', message: 'Invalid subscribe message' }); }
  });
  socket.on('close', () => subscriptions.delete(socket));
  socket.on('error', error => console.error('WebSocket client:', error.message));
});
const heartbeat = setInterval(() => {
  if (worker.readyState !== WebSocket.OPEN) return;
  if (!workerAlive) { worker.terminate(); return; }
  workerAlive = false; worker.ping();
}, 5000);
connectWorker();
server.listen(port, '127.0.0.1', () => console.log(`Control API http://127.0.0.1:${port}`));
function shutdown(): void {
  stopping = true; clearInterval(heartbeat); clearTimeout(reconnect); worker.close();
  for (const socket of wss.clients) socket.close();
  wss.close(); server.close();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('message', message => { if (message === 'shutdown') { shutdown(); process.disconnect?.(); } });
