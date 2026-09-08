export const GOAL = '检查登录按钮提交后是否出现异常。发现足够信息后结束任务并总结观察结果。';
export const INSTRUCTIONS = `${GOAL}\n每个模型轮次最多调用一个工具。先 observe_page，再用 observationId/elementRef 点击 Login。点击后重新 observe_page，看到 HTTP_5XX Finding 后调用 finish。不能猜页面状态。工具返回 STALE_OBSERVATION 时重新 observe_page。`;
export type AgentRunErrorCode = 'MODEL_PROTOCOL_ERROR' | 'TOOL_VALIDATION_ERROR' | 'UNKNOWN_TOOL' | 'TOOL_EXECUTION_ERROR' | 'ONE_TOOL_PER_STEP' | 'ABORTED' | 'RUN_TIMEOUT' | 'MCP_ERROR';
export type AgentKernelEvent =
  | { type: 'run-start' }
  | { type: 'model-start'; step: number }
  | { type: 'tool-call'; step: number; tool: string }
  | { type: 'tool-result'; step: number; tool: string }
  | { type: 'message'; text: string }
  | { type: 'run-finish'; reason: string }
  | { type: 'run-error'; code: AgentRunErrorCode };
export interface PageObservation {
  observationId: string;
  page: { url: string; title: string };
  elements: { ref: string; role: string; name: string }[];
  alert?: string;
  findings: { kind: string; severity: string; title: string }[];
}
export type ToolResult = { ok: boolean; code?: string; summary?: string };
export interface AgentToolGateway {
  observePage(): Promise<PageObservation>;
  click(input: { observationId: string; elementRef: string }): Promise<ToolResult>;
  finish(input: { summary: string }): Promise<ToolResult>;
}
export interface ModelConfig { baseURL: string; apiKey: string; model: string }
export interface RunResult {
  reason: 'completed' | 'paused_by_human' | 'aborted' | 'budget_exhausted' | 'error';
  error?: AgentRunErrorCode;
  steps: number;
  events: AgentKernelEvent[];
  contextSizes: number[];
  durationMs: number;
}
export interface RunOptions {
  model: ModelConfig;
  gateway: AgentToolGateway;
  signal?: AbortSignal;
  maxSteps?: number;
  timeoutMs?: number;
  recentTurns?: number;
  onEvent?: (event: AgentKernelEvent) => void;
  mcpURL?: string;
}
export interface KernelAdapter { name: string; run(options: RunOptions): Promise<RunResult> }
