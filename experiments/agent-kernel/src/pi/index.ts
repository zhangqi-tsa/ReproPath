import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { Model } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { schemas, descriptions } from '../common/gateway.js';
import { RunHost } from '../common/host.js';
import { recentHistory } from '../common/context.js';
import { INSTRUCTIONS, GOAL, type KernelAdapter } from '../common/types.js';

export const adapter: KernelAdapter = { name: 'pi', async run(options) {
  const host = new RunHost(options); let agent: Agent | undefined; let mcp: Client | undefined;
  const task = (async () => {
    let echo: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
    if (options.mcpURL) {
      mcp = new Client({ name: 'pi-bakeoff', version: '1' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(options.mcpURL)));
      if (!(await mcp.listTools()).tools.some(tool => tool.name === 'echo')) throw new Error('MCP echo missing');
      echo = async input => { const result = await mcp!.callTool({ name: 'echo', arguments: input }, undefined, { signal: host.controller.signal }); if (result.isError) throw new Error('MCP_ERROR'); return result; };
    }
    const names = options.mcpURL ? ['echo'] as const : ['observe_page', 'click', 'finish'] as const;
    const tools: AgentTool[] = names.map(name => ({ name, label: name, description: descriptions[name],
      parameters: z.toJSONSchema(schemas[name]) as AgentTool['parameters'],
      execute: async (_id, input) => { const result = await host.execute(name, input, name === 'echo' ? echo : undefined); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; },
    }));
    const model: Model<'openai-completions'> = { id: options.model.model, name: options.model.model, provider: 'bakeoff', api: 'openai-completions', baseUrl: options.model.baseURL,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 };
    agent = new Agent({ initialState: { model, systemPrompt: INSTRUCTIONS, tools, thinkingLevel: 'off' },
      streamFn: (model, context, settings) => streamSimple(model as Model<'openai-completions'>, context, { ...settings, apiKey: options.model.apiKey }),
      toolExecution: 'sequential',
      transformContext: async messages => { const bounded = recentHistory(messages, host.recentTurns); host.beginStep(bounded.length); return bounded; },
      prepareNextTurnWithContext: ({ context }) => ({ context: { ...context, messages: recentHistory(context.messages, host.recentTurns) } }),
      shouldStopAfterTurn: () => host.finished || !!host.error || host.steps >= host.maxSteps,
    });
    agent.subscribe(event => {
      if (host.controller.signal.aborted) return;
      // Pi's validator coerces values; validate the original model output first.
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        for (const part of event.message.content) if (part.type === 'toolCall') {
          if (!names.includes(part.name as never)) host.fail('UNKNOWN_TOOL');
          else if (!schemas[part.name as keyof typeof schemas].safeParse(part.arguments).success) host.fail('TOOL_VALIDATION_ERROR');
        }
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') host.emit({ type: 'message', text: event.assistantMessageEvent.delta });
      if (event.type === 'tool_execution_end' && event.isError && !host.error) host.fail(names.includes(event.toolName as never) ? 'TOOL_VALIDATION_ERROR' : 'UNKNOWN_TOOL');
      if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') host.fail('MODEL_PROTOCOL_ERROR');
    });
    await agent.prompt(GOAL);
  })();
  const result = await host.settle(task, () => agent?.abort());
  await mcp?.close(); return result;
} };
