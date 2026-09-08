import { MAX_FRAME_DATA_LENGTH, type BrowserFrame, type FrameAck } from '@repropath/protocol';
export { InputBuffer } from './input-buffer.js';

/** One in-flight message per connection; at most one pending frame per session.
 * An application ACK is required, so a suspended renderer cannot accumulate a
 * browser WebSocket receive queue even when TCP continues accepting data.
 */
export class LatestFrameSender {
  private pending = new Map<string, BrowserFrame>();
  private inFlight?: FrameAck;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private replaced = 0;
  constructor(private transport: { writable: () => boolean; send: (frame: BrowserFrame) => void }, private maxSessions = 1) {}

  offer(frame: BrowserFrame): void {
    if (this.disposed || frame.data.length > MAX_FRAME_DATA_LENGTH) return;
    if (this.pending.has(frame.sessionId)) this.replaced++;
    else if (this.pending.size >= this.maxSessions) return;
    this.pending.set(frame.sessionId, frame);
    this.flush();
  }
  acknowledge(ack: FrameAck): void {
    if (this.inFlight?.sessionId !== ack.sessionId || this.inFlight.pageId !== ack.pageId || this.inFlight.frameSequence !== ack.frameSequence) return;
    this.inFlight = undefined;
    this.flush();
  }
  private flush(): void {
    if (this.disposed || this.inFlight || !this.pending.size) return;
    if (!this.transport.writable()) {
      this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, 50);
      return;
    }
    const entry = this.pending.entries().next().value;
    if (!entry) return;
    const [id, frame] = entry;
    this.pending.delete(id);
    this.inFlight = { type: 'frame-ack', sessionId: id, pageId: frame.pageId, frameSequence: frame.frameSequence };
    this.transport.send(frame);
  }
  forget(sessionId: string): void {
    this.pending.delete(sessionId);
    // Keep the tiny ACK token until acknowledged: already-sent bytes can't be retracted.
  }
  get stats(): { pending: number; inFlight: number; replaced: number } {
    return { pending: this.pending.size, inFlight: this.inFlight ? 1 : 0, replaced: this.replaced };
  }
  dispose(): void {
    this.disposed = true; clearTimeout(this.timer); this.timer = undefined;
    this.pending.clear(); this.inFlight = undefined;
  }
}
