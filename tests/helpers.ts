import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
// Independent runs must not inherit growing artifact-directory scan costs.
process.env.REPROPATH_ARTIFACT_DIR ??= resolve('test-results', `test-artifacts-${randomUUID()}`);
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { ServerMessageSchema, SessionSchema, type BrowserFrame, type ServerMessage, type Session, type SessionEvent } from '@repropath/protocol';

export async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
export async function until(check: () => boolean | Promise<boolean>, description: string, timeout = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await delay(40); }
  throw new Error(`Timed out: ${description}`);
}
export function service(file: string, env: Record<string, string>): { child: ChildProcess; stop: () => Promise<void>; logs: () => string } {
  const child = spawn(process.execPath, ['--import', 'tsx', file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '';
  child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
  return { child, logs: () => output, stop: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    if (child.connected) child.send('shutdown'); else child.kill();
    const timer = setTimeout(() => child.kill(), 5000);
    await exited; clearTimeout(timer);
  } };
}
export async function ready(base: string, worker = false): Promise<void> {
  await until(async () => {
    try {
      const response = await fetch(`${base}/health`);
      const data = await response.json() as { workerConnected?: boolean };
      return response.ok && (!worker || data.workerConnected === true);
    } catch { return false; }
  }, `${base} ready`);
}
export async function create(base: string, url: string): Promise<Session> {
  const response = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  if (response.status !== 201) throw new Error(`Create failed: ${await response.text()}`);
  return SessionSchema.parse(await response.json());
}
export async function subscribe(base: string, id: string, ackFrames = true): Promise<{ socket: WebSocket; events: SessionEvent[]; states: Session[]; frames: BrowserFrame[]; messages: ServerMessage[] }> {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/events`);
  const events: SessionEvent[] = []; const states: Session[] = []; const messages: ServerMessage[] = [];
  const frames: BrowserFrame[] = [];
  socket.on('message', raw => {
    const message = ServerMessageSchema.parse(JSON.parse(raw.toString())); messages.push(message);
    if (message.type === 'snapshot') { events.push(...message.events); states.push(message.session); }
    if (message.type === 'event') events.push(message.event);
    if (message.type === 'state') states.push(message.session);
    if (message.type === 'browser-frame') {
      frames.push(message);
      if (ackFrames) socket.send(JSON.stringify({ type: 'frame-ack', sessionId: message.sessionId, pageId: message.pageId, frameSequence: message.frameSequence }));
    }
  });
  await once(socket, 'open'); socket.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
  await until(() => messages.length > 0, 'subscription snapshot');
  return { socket, events, states, frames, messages };
}
