import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import { MAX_ACTIONS, type ActionRecord, type BrowserInput, type SessionEvent } from '@repropath/protocol';
import { EvidenceCapture, identifyTarget } from './evidence.js';

export class ActionRecorder {
  private active?: ActionRecord;
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private pending = new Set<string>();
  private lastActivity = 0;
  private count = 0;
  private evidenceEnabled = true;
  constructor(private sessionId: string, private page: () => Page | undefined, private sequence: () => number,
    private capture: EvidenceCapture, private publish: (action: ActionRecord) => void) {}
  private run(task: () => Promise<void>): Promise<void> {
    const next = this.tail.then(task).catch(() => { this.interrupt(); }); this.tail = next; return next;
  }
  private update(action: ActionRecord): void { this.publish(structuredClone(action)); }
  observe(event: SessionEvent): void {
    const action = this.active; if (!action || !('pageId' in event) || event.pageId !== action.pageId) return;
    if (event.type === 'request' && action.networkRequestIds.length < 1000) {
      action.networkRequestIds.push(event.payload.requestId); this.pending.add(event.payload.requestId); this.lastActivity = Date.now();
    }
    if (['console', 'pageerror', 'navigation'].includes(event.type)) this.lastActivity = Date.now();
  }
  requestFinished(id: string): void { if (this.pending.delete(id)) this.lastActivity = Date.now(); }
  before(message: BrowserInput): Promise<void> {
    const input = message.input;
    // Moves and key releases are never standalone Actions.
    if (input.type === 'pointer-move' || input.type === 'pointer-up' || (input.type === 'key' && (input.action === 'up' || ['Control','Meta','Shift','Alt'].includes(input.key)))) return Promise.resolve();
    return this.run(async () => {
      clearTimeout(this.timer);
      const kind = input.type === 'text' ? 'type' : input.type === 'wheel' ? 'scroll' : input.type === 'key' ? 'key' : 'click';
      if (this.active && !((kind === 'type' || kind === 'scroll') && this.active.kind === kind)) await this.finish();
      if (this.active) return;
      const page = this.page(); if (!page || page.isClosed()) return;
      this.evidenceEnabled = ++this.count <= MAX_ACTIONS;
      const detail: ActionRecord['detail'] = input.type === 'text' ? { kind: 'type', characterCount: 0 }
        : input.type === 'wheel' ? { kind: 'scroll', totalDeltaX: 0, totalDeltaY: 0, eventCount: 0 }
        : input.type === 'key' ? { kind: 'key', key: input.key, modifiers: input.modifiers }
        : { kind: 'click', button: input.button, x: input.x, y: input.y };
      const action: ActionRecord = { id: randomUUID(), sessionId: this.sessionId, pageId: message.pageId, actor: 'human', kind, status: 'recording',
        startedAt: new Date().toISOString(), sourceFrameSequence: message.sourceFrameSequence, detail, eventSequenceStart: this.sequence() + 1, networkRequestIds: [], evidenceStatus: 'pending' };
      this.active = action; this.pending.clear(); this.update(action);
      action.target = await identifyTarget(page, 'x' in input ? input : undefined);
      action.before = await this.capture.capture(page, action, 'before', this.evidenceEnabled);
      if (action.status === 'interrupted') this.complete(action); else this.update(action);
    });
  }
  after(message: BrowserInput): void {
    const action = this.active; if (!action) return;
    const input = message.input;
    if (input.type === 'text' && action.detail.kind === 'type') action.detail.characterCount += input.text.length;
    if (input.type === 'wheel' && action.detail.kind === 'scroll') { action.detail.totalDeltaX += input.deltaX; action.detail.totalDeltaY += input.deltaY; action.detail.eventCount++; }
    if (input.type === 'pointer-up' && action.detail.kind === 'click') {
      if (Math.hypot(input.x - action.detail.x, input.y - action.detail.y) > 6) {
        action.detail = { kind: 'drag', button: action.detail.button, startX: action.detail.x, startY: action.detail.y, endX: input.x, endY: input.y }; action.kind = 'drag';
      }
      this.schedule(0);
    } else if (input.type === 'text') this.schedule(500);
    else if (input.type === 'wheel') this.schedule(250);
    else if (input.type === 'key' && action.kind === 'key' && (input.action === 'press' || input.action === 'up') && action.detail.kind === 'key' && input.key === action.detail.key) this.schedule(0);
  }
  private schedule(ms: number): void {
    clearTimeout(this.timer); const scheduled = this.active;
    this.timer = setTimeout(() => { void this.run(async () => { if (this.active === scheduled) await this.finish(); }); }, ms);
  }
  private async finish(): Promise<void> {
    clearTimeout(this.timer); const action = this.active; if (!action) return;
    const start = Date.now(); this.lastActivity = Math.max(this.lastActivity, start);
    while (this.active === action && Date.now() - start < 2000 && (Date.now() - start < 150 || this.pending.size > 0 || Date.now() - this.lastActivity < 200)) await delay(25);
    if (this.active !== action) return;
    action.settle = { timedOut: Date.now() - start >= 2000, durationMs: Date.now() - start };
    const page = this.page(); if (page && !page.isClosed()) action.after = await this.capture.capture(page, action, 'after', this.evidenceEnabled);
    if (this.active !== action) return;
    action.status = 'completed'; this.complete(action); this.active = undefined; this.pending.clear();
  }
  private complete(action: ActionRecord): void {
    action.completedAt = new Date().toISOString(); action.durationMs = Date.parse(action.completedAt) - Date.parse(action.startedAt);
    action.eventSequenceEnd = Math.max(action.eventSequenceStart, this.sequence());
    const refs = [action.before?.screenshot, action.before?.dom, action.after?.screenshot, action.after?.dom].filter(Boolean).length;
    action.evidenceStatus = refs === 4 ? 'complete' : refs > 0 || !this.evidenceEnabled ? 'partial' : 'failed'; this.update(action);
  }
  interrupt(): void {
    clearTimeout(this.timer); const action = this.active; this.active = undefined; this.pending.clear();
    if (action) { action.status = 'interrupted'; this.complete(action); }
  }
}
