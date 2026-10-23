import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { callWebTools, serveToolBridge } from '../mcp/stdio.js';
import type { SessionMcpServer } from '../runs/session-mcp.js';
import { slackThreadFromJson } from '../../shared/todo/slack-thread.js';
import type { TodoSlackThread } from '../../shared/todo/types.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { TODO_TOOLS_PATH, TODO_TOOLS_SERVER, todoToolList } from './agent-tools.js';

/**
 * The tool server that brings the Todo tools (agent-tools.ts) to a turn. The todos live in the web process, so the
 * server a provider starts asks the web, with a standing key that opens the todo tools and nothing else.
 */

const KEY_FILE = 'todo-tools-key.json';
/** The Slack thread of the conversation a turn is in, as JSON, for the tasks it adds (agent-tools.ts `add`). */
export const TODO_SLACK_THREAD_ENV = 'TOWER_TODO_SLACK_THREAD';
const KEY = /^[a-f\d]{64}$/;

/**
 * The web's standing key for these tools, made once and kept owner-only beside the todos. A file that cannot be read
 * as one (cut short, replaced by a link) is written anew: the tool servers read it on every call.
 */
export async function todoToolsKey(stateDir: string): Promise<string> {
  const path = join(stateDir, KEY_FILE);
  // best-effort: a key that cannot be read is replaced below; the tool servers read the new one on their next call.
  const saved = await readPrivateJson(path, 4096).catch(() => undefined) as { key?: unknown } | undefined;
  if (typeof saved?.key === 'string' && KEY.test(saved.key)) return saved.key;
  const key = randomBytes(32).toString('hex');
  await writePrivateJson(path, JSON.stringify({ key }));
  return key;
}

/**
 * How a turn starts the tool server: this build's own entry, reading the key from the state directory. A turn of a Slack
 * conversation also names its thread.
 */
export function todoToolServer(stateDir: string, entry: { command: string; args: string[] }, slackThread?: TodoSlackThread): SessionMcpServer {
  return { command: entry.command, args: [...entry.args, '--todos-mcp', stateDir], ...(slackThread ? { env: { [TODO_SLACK_THREAD_ENV]: JSON.stringify(slackThread) } } : {}) };
}

/**
 * The tool server a provider starts. It holds no tools itself: each request goes to the web, found anew after a restart,
 * with the turn's Slack thread when it has one (the web checks it).
 */
export async function startTodosMcp(stateDir: string, input: Readable = process.stdin, output: Writable = process.stdout, ports?: () => Promise<number[]>,
  env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isAbsolute(stateDir)) throw new Error('Invalid Tower state directory.');
  // A thread that cannot be read only leaves the tasks unlinked.
  const slackThread = slackThreadFromJson(env[TODO_SLACK_THREAD_ENV]);
  const origin = slackThread ? { origin: { slackThread } } : {};
  const call = async (body: Record<string, unknown>) => {
    let key: unknown;
    try { key = ((await readPrivateJson(join(stateDir, KEY_FILE), 4096)) as { key?: unknown }).key; }
    catch { throw new Error('Agent Session Tower has not started on this computer yet, or could not write its todo tools key, so the todos cannot be reached.'); }
    if (typeof key !== 'string' || !KEY.test(key)) throw new Error('The todo tools key is damaged; restarting Tower writes a new one.');
    return callWebTools(stateDir, TODO_TOOLS_PATH, key, body, ports);
  };
  await serveToolBridge({ name: TODO_TOOLS_SERVER,
    // The list is this build's own, so a turn that starts while the web restarts still has the tools.
    listTools: async () => todoToolList(),
    callTool: (name, args) => call({ method: 'tools/call', name, arguments: args, ...origin }) }, input, output);
}
