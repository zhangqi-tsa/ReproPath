import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { BrowserInput, ControlState, InputErrorCode, InputResult, ServerMessage, Session, WorkerCommand } from '@repropath/protocol';
import { InputBuffer } from '@repropath/streaming';

interface Lease {
  id: string; socket?: WebSocket; runId?: string; lastSequence: number; queue: InputBuffer;
  inFlight?: number; timeout?: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout>;
}
export class ControlAuthority {
  onAgentRevoked?: (sessionId:string,runId:string,reason:string)=>void;
  private leases = new Map<string, Lease>();
  constructor(private dependencies: {
    session: (id: string) => Session | undefined;
    subscribers: Map<WebSocket, string>;
    ready: () => boolean; writable: () => boolean;
    send: (socket: WebSocket, message: ServerMessage) => void;
    worker: (command: WorkerCommand) => void;
  }) {}
  state(sessionId: string, socket: WebSocket, reason?: string): void {
    const lease = this.leases.get(sessionId);
    const state: ControlState = { type: 'control-state', sessionId, status: lease ? 'controlled' : 'available', heldBySelf: lease?.socket === socket, reason, owner:lease ? lease.runId?'agent':'human':undefined };
    if (lease?.socket === socket) state.leaseId = lease.id;
    this.dependencies.send(socket, state);
  }
  private broadcast(id: string, reason?: string): void {
    for (const [socket, sessionId] of this.dependencies.subscribers) if (sessionId === id) this.state(id, socket, reason);
  }
  acquire(sessionId: string, socket: WebSocket): void {
    const { session, ready, subscribers, send } = this.dependencies;
    if (session(sessionId)?.status !== 'running' || !ready() || subscribers.get(socket) !== sessionId) {
      send(socket, { type: 'control-error', sessionId, code: 'SESSION_NOT_RUNNING', message: 'Session 尚未运行或连接不可用' }); return;
    }
    if(this.leases.get(sessionId)?.runId)this.revoke(sessionId,'human_takeover');
    const current = this.leases.get(sessionId);
    if (current) {
      if (current.socket !== socket) send(socket, { type: 'control-error', sessionId, code: 'CONTROL_BUSY', message: '该 Session 正被另一个客户端控制' });
      this.state(sessionId, socket); return;
    }
    const lease: Lease = { id: randomUUID(), socket, lastSequence: 0, queue: new InputBuffer() };
    this.leases.set(sessionId, lease);
    // Input-reset is a transport fence, not a Worker-side ownership decision.
    this.dependencies.worker({ type: 'input-reset', sessionId });
    this.broadcast(sessionId);
  }
  release(sessionId: string, socket: WebSocket, leaseId: string): void {
    const lease = this.leases.get(sessionId);
    if (!lease || lease.socket !== socket || lease.id !== leaseId) {
      this.dependencies.send(socket, { type: 'control-error', sessionId, code: 'CONTROL_NOT_OWNED', message: '控制租约已失效' }); return;
    }
    this.revoke(sessionId, '已结束接管');
  }
  revoke(sessionId: string, reason: string, reset = true): void {
    const lease = this.leases.get(sessionId); if (!lease) return;
    this.leases.delete(sessionId); lease.queue.clear(); clearTimeout(lease.retry); clearTimeout(lease.timeout);
    if(lease.runId){this.dependencies.worker({type:'agent-epoch',sessionId,epoch:null});this.onAgentRevoked?.(sessionId,lease.runId,reason);}
    if (reset && this.dependencies.ready()) this.dependencies.worker({ type: 'input-reset', sessionId });
    this.broadcast(sessionId, reason);
  }
  disconnect(socket: WebSocket): void {
    for (const [id, lease] of this.leases) if (lease.socket === socket) this.revoke(id, '控制连接已断开');
  }
  revokeAll(reason: string, reset = true): void { for (const id of this.leases.keys()) this.revoke(id, reason, reset); }
  acquireAgent(sessionId:string,runId:string):string|undefined {
    if(this.leases.has(sessionId)||!this.dependencies.ready()||this.dependencies.session(sessionId)?.status!=='running')return;
    const id=randomUUID();this.leases.set(sessionId,{id,runId,lastSequence:0,queue:new InputBuffer()});
    this.dependencies.worker({type:'input-reset',sessionId});this.dependencies.worker({type:'agent-epoch',sessionId,epoch:id});this.broadcast(sessionId);return id;
  }
  ownedByAgent(sessionId:string,runId:string,epoch:string):boolean{const l=this.leases.get(sessionId);return l?.runId===runId&&l.id===epoch;}
  busy(sessionId:string):boolean{return this.leases.has(sessionId);}
  humanOwned(sessionId:string):boolean{return !!this.leases.get(sessionId)?.socket;}
  private reject(socket: WebSocket, input: BrowserInput, code: InputErrorCode, message: string): void {
    this.dependencies.send(socket, { type: 'input-result', sessionId: input.sessionId, leaseId: input.leaseId, inputSequence: input.inputSequence, ok: false, code, message });
  }
  input(socket: WebSocket, input: BrowserInput): void {
    const state = this.dependencies.session(input.sessionId);
    if (!state || state.status !== 'running' || !this.dependencies.ready()) { this.reject(socket, input, 'SESSION_NOT_RUNNING', 'Session 未运行'); return; }
    const lease = this.leases.get(input.sessionId);
    if (!lease || lease.id !== input.leaseId || lease.socket !== socket || this.dependencies.subscribers.get(socket) !== input.sessionId) {
      this.reject(socket, input, 'CONTROL_NOT_OWNED', '当前连接没有有效控制租约'); return;
    }
    if (input.pageId !== state.activePageId) { this.reject(socket, input, 'STALE_PAGE', '输入目标不是当前活动 Page'); return; }
    if ('x' in input.input && (input.input.x >= state.viewport.width || input.input.y >= state.viewport.height)) {
      this.reject(socket, input, 'INVALID_INPUT', '输入坐标超出浏览器 viewport'); return;
    }
    if (input.inputSequence <= lease.lastSequence) { this.reject(socket, input, 'INPUT_OUT_OF_ORDER', '重复或乱序输入'); return; }
    lease.lastSequence = input.inputSequence;
    if (!lease.queue.offer(input)) {
      this.reject(socket, input, 'INPUT_BACKPRESSURE', '离散输入积压，已停止控制以释放按键'); this.revoke(input.sessionId, '输入积压，控制已停止'); return;
    }
    this.pump(input.sessionId, lease);
  }
  private pump(sessionId: string, lease: Lease): void {
    if (this.leases.get(sessionId) !== lease || lease.inFlight !== undefined || !lease.queue.stats.pending) return;
    if (!this.dependencies.writable()) {
      lease.retry ??= setTimeout(() => { lease.retry = undefined; this.pump(sessionId, lease); }, 20); return;
    }
    const input = lease.queue.take(); if (!input) return;
    lease.inFlight = input.inputSequence;
    lease.timeout = setTimeout(() => {
      if(lease.socket)this.reject(lease.socket, input, 'INPUT_REJECTED', '输入确认超时，控制已停止'); this.revoke(sessionId, '输入确认超时');
    }, 5000);
    this.dependencies.worker(input);
  }
  result(result: InputResult): void {
    const lease = this.leases.get(result.sessionId);
    if (!lease || lease.id !== result.leaseId || lease.inFlight !== result.inputSequence) return;
    clearTimeout(lease.timeout); lease.inFlight = undefined;
    if(lease.socket)this.dependencies.send(lease.socket, result); this.pump(result.sessionId, lease);
  }
}
