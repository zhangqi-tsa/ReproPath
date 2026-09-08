import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { ModelConfig } from './types.js';
export interface Reply { calls?: { name: string; args: unknown }[]; text?: string; delayMs?: number; protocolError?: boolean }
export const normalPlan: Reply[] = [
  { calls: [{ name: 'observe_page', args: {} }] },
  { calls: [{ name: 'click', args: { observationId: 'obs-1', elementRef: 'E3' } }] },
  { calls: [{ name: 'observe_page', args: {} }] },
  { calls: [{ name: 'finish', args: { summary: '点击 Login 后出现登录服务异常及 HTTP 500 Finding。' } }] },
];
export interface CapturedRequest { model: string; messages: unknown[]; tools?: { function: { name: string } }[]; stream?: boolean; parallel_tool_calls?: boolean }
/** Injected via the same OpenAI-compatible transport as a real model, entirely localhost. */
export class FakeModel {
  requests: CapturedRequest[] = [];
  private plan: Reply[] = normalPlan;
  private responses = new Set<ServerResponse>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as CapturedRequest;
    const index = this.requests.length; this.requests.push(body);
    const reply = this.plan[index] ?? { text: 'done' }; this.responses.add(res);
    res.on('close', () => this.responses.delete(res));
    const send = () => {
      if (res.destroyed) return;
      if (reply.protocolError) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"broken":true}'); return; }
      const calls = reply.calls?.map((call, i) => ({ index: i, id: `call-${index}-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }));
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: `fake-${index}`, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        chunk({ role: 'assistant', ...(calls ? { tool_calls: calls } : { content: reply.text ?? 'done' }) });
        chunk({}, calls ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `fake-${index}`, object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: calls ? null : reply.text ?? 'done', ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
    };
    if (reply.delayMs) { const timer = setTimeout(() => { this.timers.delete(timer); send(); }, reply.delayMs); this.timers.add(timer); res.on('close', () => { clearTimeout(timer); this.timers.delete(timer); }); }
    else send();
  });
  async start(): Promise<ModelConfig> { this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening'); const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('No port'); return { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fake-local-key', model: 'fixture-model' }; }
  reset(plan: Reply[] = normalPlan): void { this.plan = plan; this.requests = []; }
  async close(): Promise<void> { for (const timer of this.timers) clearTimeout(timer); for (const res of this.responses) res.destroy(); this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}
