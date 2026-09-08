import type { BrowserInput } from '@repropath/protocol';

/** Coalesce only consecutive moves: never move an input across down/up/text/key boundaries. */
export class InputBuffer {
  private queue: BrowserInput[] = [];
  private replaced = 0;
  constructor(private capacity = 128) {}
  offer(input: BrowserInput): boolean {
    const last = this.queue.at(-1);
    if (input.input.type === 'pointer-move' && last?.input.type === 'pointer-move') {
      this.queue[this.queue.length - 1] = input; this.replaced++; return true;
    }
    if (this.queue.length >= this.capacity) {
      const move = this.queue.findIndex(value => value.input.type === 'pointer-move');
      if (move >= 0) this.queue.splice(move, 1);
      else return false;
    }
    this.queue.push(input); return true;
  }
  take(): BrowserInput | undefined { return this.queue.shift(); }
  clear(): void { this.queue.length = 0; }
  get stats(): { pending: number; replaced: number } { return { pending: this.queue.length, replaced: this.replaced }; }
}
