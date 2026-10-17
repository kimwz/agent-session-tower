import { request } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { lockOwners } from '../instance/state-lock.js';
import { MAX_RPC_BYTES, runnerPaths } from '../runs/runner-protocol.js';

export interface ToolBridge {
  name: string;
  listTools(): Promise<unknown[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

type RpcReply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

/**
 * One JSON-RPC message to a tool server, answered the same over stdio and HTTP. Notifications and responses (no id)
 * get no answer.
 */
export async function answerRpc(bridge: ToolBridge, frame: any): Promise<RpcReply | undefined> {
  // A response to something the server asked (it asks nothing) is taken without an answer, like a notification.
  if (frame && typeof frame === 'object' && frame.jsonrpc === '2.0' && frame.method === undefined && ('result' in frame || 'error' in frame)) return undefined;
  if (!frame || typeof frame !== 'object' || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  if (frame.id === undefined) return undefined;
  if (typeof frame.id !== 'string' && typeof frame.id !== 'number') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request ID' } };
  const answer = (result: unknown): RpcReply => ({ jsonrpc: '2.0', id: frame.id, result });
  if (frame.method === 'initialize') return answer({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(frame.params?.protocolVersion) ? frame.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: bridge.name, version: '1.0.0' } });
  if (frame.method === 'ping') return answer({});
  if (frame.method === 'tools/list') {
    try { return answer({ tools: await bridge.listTools() }); }
    catch (error) { return { jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: error instanceof Error ? error.message : 'Tools are unavailable.' } }; }
  }
  if (frame.method === 'tools/call') {
    try {
      const name = frame.params?.name;
      if (typeof name !== 'string') throw new Error('A tool name is required.');
      const args = frame.params?.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
      const value = await bridge.callTool(name, args);
      return answer({ content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }] });
    } catch (error) { return answer({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool failed.' }] }); }
  }
  return { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } };
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
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
      const reply = await answerRpc(bridge, frame);
      if (reply) respond(reply);
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

/** Where the web of this state directory answered last; looked for again when it stops answering (a restart). */
const webPorts = new Map<string, number>();

/**
 * Sends one tool request to this computer's Tower web with a standing key (`TodoKey`), for tools whose data the web
 * keeps (the todos). The web is found through the state directory's lock, again after a restart moved it; a request
 * is never sent twice, so a lost answer is reported as uncertain.
 */
export async function callWebTools(stateDir: string, path: string, key: string, body: Record<string, unknown>,
  ports: () => Promise<number[]> = async () => (await lockOwners(stateDir)).map(owner => owner.port)): Promise<unknown> {
  const payload = JSON.stringify(body);
  const send = (port: number) => new Promise<{ status: number; reply: { result?: unknown; error?: { message?: string } } }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { authorization: `TodoKey ${key}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_RPC_BYTES) res.destroy(new Error('Tool response too large.')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, reply: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { resolve({ status: res.statusCode ?? 0, reply: {} }); }
      });
    });
    req.setTimeout(60_000, () => req.destroy(Object.assign(new Error('Tower did not answer in time. The change may or may not have been made; read the todos before trying again.'), { sent: true })));
    req.on('error', error => reject((error as { sent?: boolean }).sent ? error : Object.assign(new Error('connect'), { unreached: true })));
    req.end(payload);
  });
  const known = webPorts.get(stateDir);
  const candidates = [...new Set([...(known ? [known] : []), ...await ports().catch(() => [] as number[])])];
  for (const port of candidates) {
    let answer: Awaited<ReturnType<typeof send>>;
    try { answer = await send(port); }
    catch (error) { if ((error as { unreached?: boolean }).unreached) { if (webPorts.get(stateDir) === port) webPorts.delete(stateDir); continue; } throw error; }
    // Another program on that port, or a Tower without these tools: try the next one.
    if (answer.status === 404 || (answer.status === 403 && !answer.reply.error?.message)) continue;
    webPorts.set(stateDir, port);
    if (answer.reply.error) throw new Error(answer.reply.error.message ?? 'Tower refused the request.');
    if (answer.status !== 200) throw new Error(`Tower answered ${answer.status}.`);
    return answer.reply.result;
  }
  throw new Error('Agent Session Tower is not running on this computer, so the todos cannot be reached now.');
}
