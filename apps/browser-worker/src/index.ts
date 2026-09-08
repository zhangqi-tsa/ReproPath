import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { WorkerCommandSchema } from '@repropath/protocol';
import { LatestFrameSender } from '@repropath/streaming';
import { BrowserRuntime } from './runtime.js';
import { chromium } from 'playwright';
import { seedSessionAuth } from './session-auth.js';

const port = Number(process.env.WORKER_PORT ?? 4311);
const headed = process.argv.includes('--headed');
const server = createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ service: 'browser-worker', browserMode: headed ? 'headed' : 'headless' }));
});
const wss = new WebSocketServer({ server, path: '/worker', maxPayload: 64 * 1024 });
let controller: WebSocket | undefined;
let frameSender: LatestFrameSender | undefined;
const runtime = new BrowserRuntime(message => {
  if (message.type === 'browser-frame') { frameSender?.offer(message); return; }
  if (message.type === 'state' && ['failed', 'closed'].includes(message.session.status)) frameSender?.forget(message.session.id);
  if (controller?.readyState === WebSocket.OPEN) {
    if (controller.bufferedAmount > 8 * 1024 * 1024) { controller.terminate(); return; }
    controller.send(JSON.stringify(message));
  }
}, Number(process.env.NAVIGATION_TIMEOUT_MS ?? 15_000), () => chromium.launch({ headless: !headed }), seedSessionAuth);
let cleaning: Promise<void> = Promise.resolve();
wss.on('connection', socket => {
  if (controller) { socket.close(1013, 'One Control connection is supported'); return; }
  controller = socket;
  frameSender = new LatestFrameSender({ writable: () => socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 256 * 1024,
    send: frame => socket.send(JSON.stringify(frame)) }, 100);
  socket.on('message', raw => {
    try {
      const command = WorkerCommandSchema.parse(JSON.parse(raw.toString()));
      if(command.type==='agent-epoch'){runtime.agentEpoch(command.sessionId,command.epoch);return;}
      if (command.type === 'frame-ack') { frameSender?.acknowledge(command); return; }
      void cleaning.then(() => {
        if (socket !== controller || socket.readyState !== WebSocket.OPEN) return;
        if (command.type === 'browser-input') return runtime.input(command);
        if (command.type === 'agent-operation') return runtime.agentOperation(command);
        if (command.type === 'input-reset') return runtime.resetInput(command.sessionId);
        return command.type === 'start' ? runtime.start(command.session) : runtime.close(command.sessionId);
      }).catch(error => console.error('Worker command:', error));
    } catch { socket.close(1008, 'Invalid worker command'); }
  });
  socket.on('error', error => console.error('Control socket:', error.message));
  socket.on('close', () => {
    if (controller === socket) { controller = undefined; frameSender?.dispose(); frameSender = undefined; cleaning = runtime.closeAll(); }
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Browser Worker http://127.0.0.1:${port} (${headed ? 'headed: local browser input bypasses the remote control lease and human-input audit' : 'headless'})`));
async function shutdown(): Promise<void> {
  await runtime.closeAll(); frameSender?.dispose(); controller?.close(); wss.close(); server.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('message', message => { if (message === 'shutdown') void shutdown().then(() => process.disconnect?.()); });
