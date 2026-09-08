import { schemas } from './gateway.js';
import type { AgentKernelEvent, AgentRunErrorCode, RunOptions, RunResult } from './types.js';

export class HostError extends Error { constructor(readonly code: AgentRunErrorCode) { super(code); } }
/** Shared policy/fence only: the candidate SDK owns every model/tool iteration. */
export class RunHost {
  readonly controller = new AbortController();
  readonly events: AgentKernelEvent[] = [];
  readonly contextSizes: number[] = [];
  readonly maxSteps: number;
  readonly recentTurns: number;
  steps = 0;
  finished = false;
  error?: AgentRunErrorCode;
  private used = false;
  private timer?: ReturnType<typeof setTimeout>;
  private started = performance.now();
  private parentAbort: () => void;
  constructor(readonly options: RunOptions) {
    this.maxSteps = options.maxSteps ?? 10; this.recentTurns = options.recentTurns ?? 2;
    this.parentAbort = () => this.controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', this.parentAbort, { once: true });
    this.controller.signal.addEventListener('abort', () => {
      // Explicit mock capability invalidation, not a promise race pretending to cancel a mutation.
      const gateway = options.gateway as { invalidate?: () => void }; gateway.invalidate?.();
    });
    if (options.signal?.aborted) this.parentAbort();
    this.timer = setTimeout(() => this.fail('RUN_TIMEOUT'), options.timeoutMs ?? 30_000);
    this.emit({ type: 'run-start' });
  }
  emit(event: AgentKernelEvent): void { this.events.push(event); this.options.onEvent?.(event); }
  beginStep(contextSize: number): void {
    this.check();
    if (this.finished || this.steps >= this.maxSteps) throw new Error('HOST_STOP');
    this.used = false; this.steps++; this.contextSizes.push(contextSize); this.emit({ type: 'model-start', step: this.steps });
  }
  check(): void { if (this.controller.signal.aborted) throw new HostError(this.error ?? 'ABORTED'); }
  fail(code: AgentRunErrorCode): void { this.error ??= code; this.controller.abort(code); }
  async execute(name: string, input: unknown, external?: (input: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
    this.check();
    if (this.used) { this.fail('ONE_TOOL_PER_STEP'); throw new HostError('ONE_TOOL_PER_STEP'); }
    if (!Object.hasOwn(schemas, name) || (name === 'echo' && !external)) { this.fail('UNKNOWN_TOOL'); throw new HostError('UNKNOWN_TOOL'); }
    const parsed = schemas[name as keyof typeof schemas].safeParse(input);
    if (!parsed.success) { this.fail('TOOL_VALIDATION_ERROR'); throw new HostError('TOOL_VALIDATION_ERROR'); }
    this.used = true; this.emit({ type: 'tool-call', step: this.steps, tool: name });
    try {
      let result: unknown;
      if (external) result = await external(parsed.data);
      else if (name === 'observe_page') result = await this.options.gateway.observePage();
      else if (name === 'click') result = await this.options.gateway.click(parsed.data as { observationId: string; elementRef: string });
      else result = await this.options.gateway.finish(parsed.data as { summary: string });
      this.check();
      if (name === 'finish' && (result as { ok?: boolean }).ok) this.finished = true;
      this.emit({ type: 'tool-result', step: this.steps, tool: name }); return result;
    } catch (error) { if (!this.controller.signal.aborted) this.fail(external ? 'MCP_ERROR' : 'TOOL_EXECUTION_ERROR'); throw error; }
  }
  async settle(task: Promise<unknown>, abortNative?: () => void): Promise<RunResult> {
    const aborted = () => { abortNative?.(); };
    this.controller.signal.addEventListener('abort', aborted, { once: true });
    let wake!: () => void;
    const abortedPromise = new Promise<void>(resolve => { wake = resolve; });
    this.controller.signal.addEventListener('abort', wake, { once: true });
    if (this.controller.signal.aborted) { aborted(); wake(); }
    try { await Promise.race([task, abortedPromise]); }
    catch (error) {
      if (!this.controller.signal.aborted && !this.finished && this.steps < this.maxSteps) {
        const name = error instanceof Error ? error.name : '';
        this.error = /InvalidToolInput|InvalidArgument|Validation/.test(name) ? 'TOOL_VALIDATION_ERROR' : /NoSuchTool|ToolNotFound/.test(name) ? 'UNKNOWN_TOOL' : 'MODEL_PROTOCOL_ERROR';
      }
    } finally {
      clearTimeout(this.timer); this.options.signal?.removeEventListener('abort', this.parentAbort);
      this.controller.signal.removeEventListener('abort', wake); this.controller.signal.removeEventListener('abort', aborted);
    }
    const reason: RunResult['reason'] = this.error ? 'error' : this.options.signal?.aborted ? (this.options.signal.reason === 'human_takeover' ? 'paused_by_human' : 'aborted') : this.finished ? 'completed' : this.steps >= this.maxSteps ? 'budget_exhausted' : 'completed';
    if (this.error) this.emit({ type: 'run-error', code: this.error });
    else if (reason === 'aborted') this.emit({ type: 'run-error', code: 'ABORTED' });
    this.emit({ type: 'run-finish', reason });
    // No pending candidate may issue another operation after the host has returned.
    this.controller.abort('host_finished');
    return { reason, error: this.error, steps: this.steps, events: [...this.events], contextSizes: [...this.contextSizes], durationMs: performance.now() - this.started };
  }
}
