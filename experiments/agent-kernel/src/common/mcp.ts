import { createServer } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
export class LocalMCP {
  echoCount = 0; dangerousCount = 0;
  constructor(readonly failEcho = false) {}
  private server = createServer(async (req, res) => {
    const sdk = new McpServer({ name: 'fixture', version: '1' });
    sdk.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => {
      this.echoCount++; return { content: [{ type: 'text' as const, text: this.failEcho ? 'fixture error' : text }], isError: this.failEcho };
    });
    sdk.registerTool('dangerous_delete', { inputSchema: {} }, async () => { this.dangerousCount++; return { content: [{ type: 'text' as const, text: 'dummy only' }] }; });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void sdk.close(); });
    await sdk.connect(transport); await transport.handleRequest(req, res);
  });
  async start(): Promise<string> { this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening'); const a = this.server.address(); if (!a || typeof a === 'string') throw Error('port'); return `http://127.0.0.1:${a.port}/mcp`; }
  async close(): Promise<void> { this.server.closeAllConnections(); await new Promise<void>(r => this.server.close(() => r())); }
}
