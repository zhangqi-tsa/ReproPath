import type { Page } from 'playwright';
import { inputSummary, type BrowserInput, type HumanInputPayload, type InputResult } from '@repropath/protocol';

export class PageInput {
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private resetPending?: Promise<void>;
  private buttons = new Set<'left' | 'middle' | 'right'>();
  private keys = new Set<string>();
  private leaseId = '';
  private sequence = 0;
  constructor(private page: () => Page | undefined, private active: () => { running: boolean; pageId: string | null; width: number; height: number },
    private audit: (summary: HumanInputPayload) => void) {}
  private run<T>(action: () => Promise<T>): Promise<T> {
    this.pending++;
    const promise = this.tail.then(action).finally(() => { this.pending--; });
    this.tail = promise.catch(() => {}); return promise;
  }
  apply(message: BrowserInput): Promise<InputResult> {
    const token = this.epoch;
    const base = { type: 'input-result' as const, sessionId: message.sessionId, leaseId: message.leaseId, inputSequence: message.inputSequence };
    if (this.pending >= 64) return Promise.resolve({ ...base, ok: false, code: 'INPUT_BACKPRESSURE', message: 'Worker 输入队列已满' });
    return this.run(async (): Promise<InputResult> => {
      const state = this.active(); const page = this.page();
      if (token !== this.epoch) return { ...base, ok: false, code: 'CONTROL_NOT_OWNED', message: '输入已被控制释放屏障取消' };
      if (!state.running || !page || page.isClosed()) return { ...base, ok: false, code: 'SESSION_NOT_RUNNING', message: 'Session 未运行' };
      if (message.pageId !== state.pageId) return { ...base, ok: false, code: 'STALE_PAGE', message: '不是当前活动 Page' };
      const input = message.input;
      if ('x' in input && (input.x < 0 || input.y < 0 || input.x >= state.width || input.y >= state.height || !Number.isFinite(input.x) || !Number.isFinite(input.y))) {
        return { ...base, ok: false, code: 'INVALID_INPUT', message: '无效坐标' };
      }
      if (this.leaseId === message.leaseId && message.inputSequence <= this.sequence) return { ...base, ok: false, code: 'INPUT_OUT_OF_ORDER', message: '重复或乱序输入' };
      if (input.type === 'key' && /^(Key|Digit)/.test(input.key) && !input.modifiers.some(key => ['Control', 'Meta', 'Alt'].includes(key))) {
        return { ...base, ok: false, code: 'INVALID_INPUT', message: '普通文本必须使用 text commit' };
      }
      this.leaseId = message.leaseId; this.sequence = message.inputSequence;
      try {
        const summary = inputSummary(message); if (summary) this.audit(summary);
        const valid = () => token === this.epoch && this.active().running;
        if (input.type === 'text') await page.keyboard.insertText(input.text);
        else if (input.type === 'key') {
          const key = input.key === 'Space' ? ' ' : input.key;
          if (input.action === 'up') { await page.keyboard.up(key); this.keys.delete(key); }
          else {
            const temporary: string[] = [];
            for (const modifier of input.modifiers) {
              if (!valid()) break;
              if (!this.keys.has(modifier)) { temporary.push(modifier); this.keys.add(modifier); await page.keyboard.down(modifier); }
            }
            if (valid()) {
              this.keys.add(key); await page.keyboard.down(key);
              if (input.action === 'press') { await page.keyboard.up(key); this.keys.delete(key); }
            }
            if (input.action === 'press') for (const modifier of temporary.reverse()) { await page.keyboard.up(modifier); this.keys.delete(modifier); }
          }
        } else {
          await page.mouse.move(input.x, input.y);
          if (valid()) {
            if (input.type === 'pointer-down') { this.buttons.add(input.button); await page.mouse.down({ button: input.button }); }
            if (input.type === 'pointer-up') { await page.mouse.up({ button: input.button }); this.buttons.delete(input.button); }
            if (input.type === 'wheel') await page.mouse.wheel(input.deltaX, input.deltaY);
          }
        }
        return { ...base, ok: true };
      } catch {
        // Playwright call logs can include insertText arguments. Never forward/log them.
        return { ...base, ok: false, code: 'INPUT_REJECTED', message: '浏览器未能执行输入' };
      }
    });
  }
  reset(): Promise<void> {
    this.epoch++; this.leaseId = ''; this.sequence = 0;
    this.resetPending ??= this.run(async () => {
      const page = this.page();
      if (page && !page.isClosed()) {
        if (this.buttons.size) await page.mouse.move(-1, -1).catch(() => {});
        for (const button of this.buttons) await page.mouse.up({ button }).catch(() => {});
        for (const key of this.keys) await page.keyboard.up(key).catch(() => {});
      }
      this.buttons.clear(); this.keys.clear();
    }).finally(() => { this.resetPending = undefined; });
    return this.resetPending;
  }
}
