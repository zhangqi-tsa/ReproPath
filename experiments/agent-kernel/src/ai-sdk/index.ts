import { ToolLoopAgent, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createMCPClient } from '@ai-sdk/mcp';
import { schemas, descriptions } from '../common/gateway.js';
import { RunHost } from '../common/host.js';
import { recentHistory } from '../common/context.js';
import { INSTRUCTIONS, GOAL, type KernelAdapter } from '../common/types.js';

export const adapter: KernelAdapter = { name: 'ai-sdk', async run(options) {
  const host = new RunHost(options);
  let mcp: Awaited<ReturnType<typeof createMCPClient>> | undefined;
  const task = (async () => {
    const provider = createOpenAICompatible({ name: 'bakeoff', baseURL: options.model.baseURL, apiKey: options.model.apiKey });
    let echo: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
    if (options.mcpURL) {
      mcp = await createMCPClient({ transport: { type: 'http', url: options.mcpURL } });
      const discovered = await mcp.tools();
      const allowed = discovered.echo;
      if (!allowed?.execute) throw new Error('MCP echo missing');
      echo = async input => {
        const result = await allowed.execute!(input, { toolCallId: 'echo', messages: [], context: {}, abortSignal: host.controller.signal });
        if ((result as { isError?: boolean }).isError) throw new Error('MCP_ERROR');
        return result;
      };
    }
    const names = options.mcpURL ? ['echo'] as const : ['observe_page', 'click', 'finish'] as const;
    const tools = Object.fromEntries(names.map(name => [name, tool({ description: descriptions[name], inputSchema: schemas[name] as z.ZodType<Record<string, unknown>>, execute: input => host.execute(name, input, name === 'echo' ? echo : undefined) })]));
    const agent = new ToolLoopAgent({ model: provider.chatModel(options.model.model), instructions: INSTRUCTIONS, tools,
      maxRetries: 0, stopWhen: [stepCountIs(host.maxSteps), () => host.finished || !!host.error],
      providerOptions: { bakeoff: { parallelToolCalls: false } },
      prepareStep: ({ messages }) => { const bounded = recentHistory(messages, host.recentTurns); host.beginStep(bounded.length); return { messages: bounded }; },
    });
    const stream = await agent.stream({ prompt: GOAL, abortSignal: host.controller.signal });
    for await (const part of stream.fullStream) {
      if (host.controller.signal.aborted) break;
      if (part.type === 'text-delta') host.emit({ type: 'message', text: part.text });
      if (part.type === 'tool-call' && part.invalid) host.fail(Object.hasOwn(tools, part.toolName) ? 'TOOL_VALIDATION_ERROR' : 'UNKNOWN_TOOL');
      if (part.type === 'error') host.fail('MODEL_PROTOCOL_ERROR');
    }
  })();
  const result = await host.settle(task);
  await mcp?.close(); return result;
} };
