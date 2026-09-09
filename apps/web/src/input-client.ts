import type { ControlState, InputAction, InputResult } from '@repropath/protocol';
import { InputBuffer } from '@repropath/streaming';

export type ControlMode = 'VIEW ONLY' | 'REQUESTING CONTROL' | 'HUMAN CONTROL' | 'CONTROLLED BY OTHER' | 'CONTROL LOST' | 'AGENT CONTROL';
export interface ControlUiState { mode: ControlMode; error: string }
export class InputClient {
  private lease?: string;
  private sessionId = '';
  private sequence = 0;
  private queue = new InputBuffer();
  private inFlight?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private state: ControlUiState = { mode: 'VIEW ONLY', error: '' };
  constructor(private socket: () => WebSocket | undefined, private changed: (state: ControlUiState) => void) {}
  private update(mode: ControlMode, error = ''): void { this.state = { mode, error }; this.changed(this.state); }
  private send(message: unknown): boolean {
    const socket = this.socket(); if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message)); return true;
  }
  acquire(sessionId: string): void {
    this.sessionId = sessionId;
    if (this.send({ type: 'control-acquire', sessionId })) this.update('REQUESTING CONTROL');
  }
  accept(state: ControlState): void {
    this.sessionId = state.sessionId;
    if (state.heldBySelf && state.leaseId) {
      if (this.lease !== state.leaseId) { this.clear(); this.sequence = 0; }
      this.lease = state.leaseId; this.update('HUMAN CONTROL');
    } else {
      const wasControlled = Boolean(this.lease); this.clear();
      this.update(state.owner==='agent'?'AGENT CONTROL':state.status === 'controlled' ? 'CONTROLLED BY OTHER' : wasControlled ? 'CONTROL LOST' : 'VIEW ONLY', state.status === 'controlled' ? this.state.error : wasControlled ? (state.reason ?? '控制权已释放') : '');
    }
  }
  denied(message: string): void { this.update(this.state.mode === 'HUMAN CONTROL' ? 'HUMAN CONTROL' : 'CONTROLLED BY OTHER', message); }
  release(): void {
    if (this.lease) this.send({ type: 'control-release', sessionId: this.sessionId, leaseId: this.lease });
    this.clear(); this.update('VIEW ONLY');
  }
  lost(): void {
    const hadControl = Boolean(this.lease) || this.state.mode === 'REQUESTING CONTROL';
    this.clear(); this.update(hadControl ? 'CONTROL LOST' : 'VIEW ONLY', hadControl ? '连接断开，控制已停止' : '');
  }
  enqueue(sessionId: string, pageId: string, input: InputAction, sourceFrameSequence?: number): void {
    if (!this.lease || this.state.mode !== 'HUMAN CONTROL' || sessionId !== this.sessionId) return;
    if (!this.queue.offer({ type: 'browser-input', sessionId, pageId, leaseId: this.lease, inputSequence: ++this.sequence, input, sourceFrameSequence })) {
      this.release(); this.update('CONTROL LOST', '输入积压，已停止接管'); return;
    }
    if (input.type === 'pointer-move') this.timer ??= setTimeout(() => { this.timer = undefined; this.pump(); }, 33);
    else this.pump();
  }
  private pump(): void {
    if (!this.lease || this.inFlight !== undefined || !this.queue.stats.pending) return;
    const socket = this.socket();
    if (socket?.readyState !== WebSocket.OPEN) { this.lost(); return; }
    if (socket.bufferedAmount > 128 * 1024) { this.timer ??= setTimeout(() => { this.timer = undefined; this.pump(); }, 33); return; }
    clearTimeout(this.timer); this.timer = undefined;
    const message = this.queue.take(); if (!message) return;
    this.inFlight = message.inputSequence; this.send(message);
  }
  result(result: InputResult): void {
    if (result.leaseId !== this.lease || result.inputSequence !== this.inFlight) return;
    this.inFlight = undefined;
    if (!result.ok) { this.release(); this.update('CONTROL LOST', result.message ?? '输入被拒绝'); return; }
    this.pump();
  }
  private clear(): void { this.lease = undefined; this.queue.clear(); this.inFlight = undefined; clearTimeout(this.timer); this.timer = undefined; }
  dispose(): void { this.clear(); }
}
