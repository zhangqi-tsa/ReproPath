import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { WorkerCommandSchema } from '@repropath/protocol';
import { BrowserRuntime } from './runtime.js';

const port = Number(process.env.WORKER_PORT ?? 4311);
const server = createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ service: 'browser-worker' }));
});
const wss = new WebSocketServer({ server, path: '/worker', maxPayload: 64 * 1024 });
let controller: WebSocket | undefined;
const runtime = new BrowserRuntime(message => {
  if (controller?.readyState === WebSocket.OPEN) controller.send(JSON.stringify(message));
}, Number(process.env.NAVIGATION_TIMEOUT_MS ?? 15_000));
let cleaning: Promise<void> = Promise.resolve();
wss.on('connection', socket => {
  if (controller) { socket.close(1013, 'One Control connection is supported'); return; }
  controller = socket;
  socket.on('message', raw => {
    try {
      const command = WorkerCommandSchema.parse(JSON.parse(raw.toString()));
      void cleaning.then(() => {
        if (socket !== controller || socket.readyState !== WebSocket.OPEN) return;
        return command.type === 'start' ? runtime.start(command.session) : runtime.close(command.sessionId);
      }).catch(error => console.error('Worker command:', error));
    } catch { socket.close(1008, 'Invalid worker command'); }
  });
  socket.on('error', error => console.error('Control socket:', error.message));
  socket.on('close', () => {
    if (controller === socket) { controller = undefined; cleaning = runtime.closeAll(); }
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Browser Worker http://127.0.0.1:${port}`));
async function shutdown(): Promise<void> {
  await runtime.closeAll(); controller?.close(); wss.close(); server.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('message', message => { if (message === 'shutdown') void shutdown().then(() => process.disconnect?.()); });
