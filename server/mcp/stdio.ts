import { request } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { MAX_RPC_BYTES, runnerPaths } from '../runs/runner-protocol.js';

export interface ToolBridge {
  name: string;
  listTools(): Promise<unknown[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Newline-delimited JSON-RPC over stdio, as Claude Code and Codex speak to local MCP servers. */
export async function serveToolBridge(bridge: ToolBridge, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const respond = (value: unknown) => output.write(JSON.stringify(value) + '\n');
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer) > 1_000_000) throw new Error('MCP input is too large.');
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let frame: any;
      try { frame = JSON.parse(line); } catch { respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
      if (!frame || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string') { respond({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); continue; }
      if (frame.id === undefined) continue;
      if (typeof frame.id !== 'string' && typeof frame.id !== 'number') { respond({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request ID' } }); continue; }
      const answer = (result: unknown) => respond({ jsonrpc: '2.0', id: frame.id, result });
      if (frame.method === 'initialize') answer({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(frame.params?.protocolVersion) ? frame.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: bridge.name, version: '1.0.0' } });
      else if (frame.method === 'ping') answer({});
      else if (frame.method === 'tools/list') {
        try { answer({ tools: await bridge.listTools() }); }
        catch (error) { respond({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: error instanceof Error ? error.message : 'Tools are unavailable.' } }); }
      } else if (frame.method === 'tools/call') {
        try {
          const name = frame.params?.name;
          if (typeof name !== 'string') throw new Error('A tool name is required.');
          const args = frame.params?.arguments ?? {};
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
          const value = await bridge.callTool(name, args);
          answer({ content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }] });
        } catch (error) { answer({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool failed.' }] }); }
      } else respond({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
}

/**
 * Sends one tool request to the execution worker with this server's capability. The capability comes
 * from the environment the worker gave this process; the worker's own RPC credential is never read.
 */
export async function callWorkerTools(stateDir: string, capability: string | undefined, body: Record<string, unknown>): Promise<unknown> {
  if (!capability || !/^[a-f\d]{64}$/.test(capability)) throw new Error('This tool server was started without a Tower capability. Tower tools are available only in turns Tower starts.');
  const paths = await runnerPaths(stateDir);
  const payload = JSON.stringify(body);
  const reply = await new Promise<{ result?: unknown; error?: { message: string } }>((resolve, reject) => {
    const req = request({ socketPath: paths.socket, method: 'POST', path: '/mcp', headers: { authorization: `Capability ${capability}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_RPC_BYTES) res.destroy(new Error('Tool response too large.')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid Tower tool response.')); } });
    });
    req.setTimeout(60_000, () => req.destroy(new Error('Tool delivery is uncertain. No automatic retry was made; check the same requestKey before sending again.')));
    req.on('error', () => reject(new Error('Tower connection failed. The operation was not retried; check before trying again.')));
    req.end(payload);
  });
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}
