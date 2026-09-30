import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { callWorkerTools, serveToolBridge } from '../mcp/stdio.js';
import type { SessionMcpServer } from '../runs/session-mcp.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/**
 * Read-only lookups over earlier sessions that every turn Tower runs gets, whatever started it. They read nothing an
 * agent's shell could not, so no turn goes without them; only the tool-less routing and public intake calls have none.
 */
export const SESSION_TOOLS_SERVER = 'tower_sessions';
export const SESSION_TOOL_OPERATIONS: ReadonlySet<string> = new Set(['sessions.list', 'sessions.read', 'sessions.search', 'models.get']);
const KEY_FILE = 'session-tools-key.json';

/** The worker's standing credential for these tools; it opens nothing else. Made once, kept owner-only. */
export async function sessionToolsKey(stateDir: string): Promise<string> {
  const path = join(stateDir, KEY_FILE);
  try {
    const saved = await readPrivateJson(path, 4096) as { key?: unknown };
    if (typeof saved?.key === 'string' && /^[a-f\d]{64}$/.test(saved.key)) return saved.key;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const key = randomBytes(32).toString('hex');
  await writePrivateJson(path, JSON.stringify({ key }));
  return key;
}

/** How a turn starts the tool server: this build's own entry, reading the key from the state directory. */
export function sessionToolServer(stateDir: string, entry: { command: string; args: string[] }): SessionMcpServer {
  return { command: entry.command, args: [...entry.args, '--sessions-mcp', stateDir] };
}

/** The tool server a provider starts. Asks the execution worker, which answers only while Tower runs here. */
export async function startSessionsMcp(stateDir: string, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  if (!isAbsolute(stateDir)) throw new Error('Invalid Tower state directory.');
  const call = async (body: Record<string, unknown>) => {
    let key: string | undefined;
    try { key = ((await readPrivateJson(join(stateDir, KEY_FILE), 4096)) as { key?: string }).key; }
    catch { throw new Error('Agent Session Tower has not started on this computer yet, so earlier sessions cannot be looked up.'); }
    try { return await callWorkerTools(stateDir, key, body); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(/connection failed|ENOENT|ECONNREFUSED/i.test(message) ? 'Agent Session Tower is not running on this computer, so earlier sessions cannot be looked up now.' : message);
    }
  };
  await serveToolBridge({ name: SESSION_TOOLS_SERVER,
    listTools: async () => ((await call({ method: 'tools/list' })) as { tools: unknown[] }).tools,
    callTool: (name, args) => call({ method: 'tools/call', name, arguments: args }) }, input, output);
}
