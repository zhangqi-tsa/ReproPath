import { Agent } from '@mastra/core/agent';
import { createTool, noopObserve } from '@mastra/core/tools';
import { MCPClient } from '@mastra/mcp';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { schemas, descriptions } from '../common/gateway.js';
import { RunHost } from '../common/host.js';
import { recentHistory } from '../common/context.js';
import { INSTRUCTIONS, GOAL, type KernelAdapter } from '../common/types.js';

export const adapter: KernelAdapter = { name: 'mastra', async run(options) {
  const host = new RunHost(options); let mcp: MCPClient | undefined;
  const task = (async () => {
    let echo: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
    if (options.mcpURL) {
      mcp = new MCPClient({ id: crypto.randomUUID(), servers: { local: { url: new URL(options.mcpURL) } }, timeout: 2000 });
      const discovered = await mcp.listTools(); const allowed = discovered.local_echo;
      if (!allowed?.execute) throw new Error('MCP echo missing');
      echo = async input => { const result = await allowed.execute!(input, { abortSignal: host.controller.signal, observe: noopObserve }); if ((result as { isError?: boolean }).isError) throw new Error('MCP_ERROR'); return result; };
    }
    const names = options.mcpURL ? ['echo'] as const : ['observe_page', 'click', 'finish'] as const;
    const tools = Object.fromEntries(names.map(name => [name, createTool({ id: name, description: descriptions[name], inputSchema: schemas[name], execute: input => host.execute(name, input, name === 'echo' ? echo : undefined) })]));
    const provider = createOpenAICompatible({ name: 'bakeoff', baseURL: options.model.baseURL, apiKey: options.model.apiKey });
    const agent = new Agent({ id: 'bakeoff', name: 'bakeoff', instructions: INSTRUCTIONS, model: provider.chatModel(options.model.model), tools });
    const result = await agent.stream(GOAL, { abortSignal: host.controller.signal, maxSteps: host.maxSteps,
      modelSettings: { maxRetries: 0 }, providerOptions: { bakeoff: { parallelToolCalls: false } },
      stopWhen: () => host.finished || !!host.error,
      prepareStep: ({ messages, rotateResponseMessageId }) => { const bounded = recentHistory(messages, host.recentTurns); host.beginStep(bounded.length); return { messages: bounded, messageId: rotateResponseMessageId?.() }; },
      onError: () => { if (!host.controller.signal.aborted) host.fail('MODEL_PROTOCOL_ERROR'); },
    });
    for await (const part of result.fullStream) {
      if (host.controller.signal.aborted) break;
      if (part.type === 'text-delta') host.emit({ type: 'message', text: part.payload.text });
      if (part.type === 'tool-call') {
        if (!names.includes(part.payload.toolName as never)) host.fail('UNKNOWN_TOOL');
        else if (!schemas[part.payload.toolName as keyof typeof schemas].safeParse(part.payload.args).success) host.fail('TOOL_VALIDATION_ERROR');
      }
      if (part.type === 'tool-error') host.fail(names.includes(part.payload.toolName as never) ? 'TOOL_VALIDATION_ERROR' : 'UNKNOWN_TOOL');
    }
  })();
  const result = await host.settle(task);
  await mcp?.disconnect(); return result;
} };
