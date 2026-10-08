import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { serveToolBridge } from '../mcp/stdio.js';
import { MasterClient } from './client.js';
import { HEARTBEAT_TOOLS } from './heartbeat-tools.js';
import { MASTER_TOOLS } from './tools.js';

/** The name the master session knows these tools by. */
export const MASTER_TOOLS_SERVER = 'tower_master';

/**
 * The master session's page tools, started by its provider. Each call goes to the running master host, which calls
 * Tower like a page; this server never starts or replaces a host.
 */
export async function startMasterMcp(stateDir: string, input: Readable = process.stdin, output: Writable = process.stdout, heartbeatCapability?: string): Promise<void> {
  if (!isAbsolute(stateDir)) throw new Error('Invalid Tower state directory.');
  const client = new MasterClient({ stateDir, credentials: () => undefined, attachOnly: true });
  await serveToolBridge({ name: MASTER_TOOLS_SERVER, listTools: async () => heartbeatCapability ? HEARTBEAT_TOOLS : MASTER_TOOLS,
    callTool: async (name, args) => {
      try { return await client.call(heartbeatCapability ? 'heartbeatTool' : 'tool', { name, arguments: args, ...(heartbeatCapability ? { capability: heartbeatCapability } : {}) }); }
      catch (error) {
        if ((error as { hostAbsent?: boolean }).hostAbsent) throw new Error('The master host is not running. Open the master in Tower, then try again.');
        throw error;
      }
    } }, input, output);
}
