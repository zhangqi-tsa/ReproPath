import { z } from 'zod';
import type { AgentToolGateway, PageObservation, ToolResult } from './types.js';
export const ObserveInput = z.object({}).strict();
export const ClickInput = z.object({ observationId: z.string(), elementRef: z.string() }).strict();
export const FinishInput = z.object({ summary: z.string().min(1).max(2000) }).strict();
export const EchoInput = z.object({ text: z.string().max(2000) }).strict();
export const schemas = { observe_page: ObserveInput, click: ClickInput, finish: FinishInput, echo: EchoInput };
export const descriptions = { observe_page: '获取最新页面与 observationId。', click: '使用最新 observationId 和 elementRef 点击按钮。', finish: '观察到充分信息后结束并总结。', echo: '本地 MCP echo。' };

/** Deterministic in-memory fixture. No browser, credentials or production imports. */
export class MockGateway implements AgentToolGateway {
  clickCount = 0;
  observeCount = 0;
  finishCount = 0;
  calls: string[] = [];
  private latest?: string;
  private observedAfterClick = false;
  private epoch = 0;
  constructor(private options: { clickDelayMs?: number; observeDelayMs?: number; throwOnClick?: boolean } = {}) {}
  // Host takeover invalidates outstanding capabilities before a new run begins.
  invalidate(): void { this.epoch++; this.latest = undefined; this.observedAfterClick = false; }
  private async wait(ms: number): Promise<boolean> {
    const epoch = this.epoch;
    if (ms) await new Promise(resolve => setTimeout(resolve, ms));
    return epoch === this.epoch;
  }
  async observePage(): Promise<PageObservation> {
    this.calls.push('observe_page');
    if (!await this.wait(this.options.observeDelayMs ?? 0)) throw new Error('GATEWAY_INVALIDATED');
    this.latest = `obs-${++this.observeCount}`; this.observedAfterClick = this.clickCount > 0;
    return { observationId: this.latest, page: { url: 'https://fixture.test/login', title: 'Login' },
      elements: [{ ref: 'E1', role: 'textbox', name: 'Username' }, { ref: 'E2', role: 'textbox', name: 'Password' }, { ref: 'E3', role: 'button', name: 'Login' }],
      ...(this.clickCount ? { alert: '登录服务异常' } : {}),
      findings: this.clickCount ? [{ kind: 'HTTP_5XX', severity: 'high', title: 'HTTP 500 · POST /login' }] : [],
    };
  }
  async click(input: { observationId: string; elementRef: string }): Promise<ToolResult> {
    this.calls.push('click');
    if (input.observationId !== this.latest) return { ok: false, code: 'STALE_OBSERVATION' };
    if (input.elementRef !== 'E3') return { ok: false, code: 'ELEMENT_NOT_CLICKABLE' };
    if (!await this.wait(this.options.clickDelayMs ?? 0)) return { ok: false, code: 'GATEWAY_INVALIDATED' };
    if (this.options.throwOnClick) throw new Error('fixture execution failure');
    this.clickCount++; this.latest = undefined; this.observedAfterClick = false;
    return { ok: true };
  }
  async finish(input: { summary: string }): Promise<ToolResult> {
    this.calls.push('finish');
    if (!this.observedAfterClick) return { ok: false, code: 'OBSERVE_AFTER_CLICK_REQUIRED' };
    this.finishCount++; return { ok: true, summary: input.summary };
  }
}
