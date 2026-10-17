import { isAbsolute, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { serveToolBridge } from '../mcp/stdio.js';
import { MasterClient } from './client.js';
import { HEARTBEAT_TOOLS } from './heartbeat-tools.js';
import { MASTER_TOOLS } from './tools.js';
import { ISSUE_INSTANCE } from './paths.js';
import { CALLER_CAPABILITY_ENV } from '../runs/session-mcp.js';

/** The name the master session knows these tools by. */
export const MASTER_TOOLS_SERVER = 'tower_master';

/** An issue master's tool server: which master it is (`todo:<taskId>`) and its turn's reporting credential. */
export interface MasterMcpInstance { id: string; capability: string }

/**
 * The master session's page tools, started by its provider. Each call goes to the running master host, which calls
 * Tower like a page; this server never starts or replaces a host. An issue master's calls name it and carry its turn's
 * credential, so the host answers them as that master's and Tower records what they start as that turn's.
 */
export async function startMasterMcp(stateDir: string, input: Readable = process.stdin, output: Writable = process.stdout, heartbeatCapability?: string, instance?: MasterMcpInstance): Promise<void> {
  if (!isAbsolute(stateDir)) throw new Error('Invalid Tower state directory.');
  const client = new MasterClient({ stateDir, credentials: () => undefined, attachOnly: true });
  await serveToolBridge({ name: MASTER_TOOLS_SERVER, listTools: async () => heartbeatCapability ? HEARTBEAT_TOOLS : MASTER_TOOLS,
    callTool: async (name, args) => {
      try {
        return await client.call(heartbeatCapability ? 'heartbeatTool' : 'tool', { name, arguments: args, ...(heartbeatCapability ? { capability: heartbeatCapability } : {}),
          ...(instance ? { instance: instance.id, capability: instance.capability } : {}) });
      } catch (error) {
        if ((error as { hostAbsent?: boolean }).hostAbsent) throw new Error('The master host is not running. Open the master in Tower, then try again.');
        throw error;
      }
    } }, input, output);
}

/** `--master-mcp <stateDir> [--heartbeat | --instance todo:<taskId>]`, with the credential each needs in the environment. */
export async function runMasterMcp(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [stateDir, mode, id] = args;
  const plain = args.length === 1, heartbeat = args.length === 2 && mode === '--heartbeat', issue = args.length === 3 && mode === '--instance';
  if (!stateDir || (!plain && !heartbeat && !issue)) throw new Error('The master tools require a state directory.');
  if (heartbeat && !env.TOWER_HEARTBEAT_CAPABILITY) throw new Error('Heartbeat tools require a run capability.');
  const capability = env[CALLER_CAPABILITY_ENV];
  if (issue && (!ISSUE_INSTANCE.test(id) || !capability)) throw new Error('Issue master tools require their todo and a run capability.');
  await startMasterMcp(resolve(stateDir), process.stdin, process.stdout, heartbeat ? env.TOWER_HEARTBEAT_CAPABILITY : undefined, issue ? { id, capability: capability! } : undefined);
}
