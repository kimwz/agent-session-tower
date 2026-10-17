import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { callWebTools, serveToolBridge } from '../mcp/stdio.js';
import type { SessionMcpServer } from '../runs/session-mcp.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { TODO_TOOLS_PATH, TODO_TOOLS_SERVER } from './agent-tools.js';

/**
 * The tool server that brings the Todo tools (agent-tools.ts) to a turn. The todos live in the web process, so the
 * server a provider starts asks the web, with a standing key that opens the todo tools and nothing else.
 */

const KEY_FILE = 'todo-tools-key.json';
const KEY = /^[a-f\d]{64}$/;

/** The web's standing key for these tools, made once and kept owner-only beside the todos. */
export async function todoToolsKey(stateDir: string): Promise<string> {
  const path = join(stateDir, KEY_FILE);
  try {
    const saved = await readPrivateJson(path, 4096) as { key?: unknown };
    if (typeof saved?.key === 'string' && KEY.test(saved.key)) return saved.key;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const key = randomBytes(32).toString('hex');
  await writePrivateJson(path, JSON.stringify({ key }));
  return key;
}

/** How a turn starts the tool server: this build's own entry, reading the key from the state directory. */
export function todoToolServer(stateDir: string, entry: { command: string; args: string[] }): SessionMcpServer {
  return { command: entry.command, args: [...entry.args, '--todos-mcp', stateDir] };
}

/** The tool server a provider starts. It holds no tools itself: each request goes to the web, found anew after a restart. */
export async function startTodosMcp(stateDir: string, input: Readable = process.stdin, output: Writable = process.stdout, ports?: () => Promise<number[]>): Promise<void> {
  if (!isAbsolute(stateDir)) throw new Error('Invalid Tower state directory.');
  const call = async (body: Record<string, unknown>) => {
    let key: unknown;
    try { key = ((await readPrivateJson(join(stateDir, KEY_FILE), 4096)) as { key?: unknown }).key; }
    catch { throw new Error('Agent Session Tower has not started on this computer yet, so the todos cannot be reached.'); }
    if (typeof key !== 'string' || !KEY.test(key)) throw new Error('The todo tools key is damaged; restarting Tower makes a new one.');
    return callWebTools(stateDir, TODO_TOOLS_PATH, key, body, ports);
  };
  await serveToolBridge({ name: TODO_TOOLS_SERVER,
    listTools: async () => ((await call({ method: 'tools/list' })) as { tools: unknown[] }).tools,
    callTool: (name, args) => call({ method: 'tools/call', name, arguments: args }) }, input, output);
}
