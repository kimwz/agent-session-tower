import { access, chmod, writeFile } from 'node:fs/promises';
import { createPrivateTemporary } from '../temporary/directories.js';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const CALLER_CAPABILITY_ENV = 'TOWER_CALLER_CAPABILITY';
export const CALLER_CAPABILITY_HEADER = 'X-Tower-Run-Capability';

/** Trusted worker configuration; never accepted from a public session request. */
export interface SessionMcpServer {
  command: string;
  args: string[];
  /** Carries the run's capability; never logged, and Claude receives it in a private file rather than argv. */
  env?: Record<string, string>;
}
export type SessionMcpServers = Record<string, SessionMcpServer>;

/**
 * Tools Tower attaches to one run. Required tools must reach the turn, so a Codex thread
 * held by the desktop app waits instead of being forwarded there without them.
 * Optional tools are dropped when the turn is forwarded to the desktop app.
 */
export interface RunTools {
  servers?: SessionMcpServers;
  /** Run-scoped reporting credentials, inherited by the provider's command tools. Never persisted. */
  env?: Record<string, string>;
  required: boolean;
  /** For an owner turn: whether Tower's own tools are attached, and if not, why. */
  towerTools?: 'attached' | 'external-input' | 'not-owner-session' | 'remote';
  /** Claude turns: whether Claude in Chrome is this turn's strong-defense browser (`--chrome`); otherwise `--no-chrome`. */
  claudeChrome?: boolean;
}
export const NO_RUN_TOOLS: RunTools = { required: false };

/** The script a tool server runs, if any; its program is the running Node itself or a packaged build. */
function serverFiles(server: SessionMcpServer): string[] {
  return server.args.filter(arg => isAbsolute(arg) && /\.[cm]?[jt]s$/.test(arg));
}

/**
 * Waits while a tool server's script is missing, as they briefly may be while this build is replaced, so a turn
 * does not start with tools that cannot connect. Required tools still missing afterwards fail the turn; optional
 * ones are attached anyway and the provider reports them unavailable.
 */
export async function awaitToolServers(tools: RunTools, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const files = [...new Set(Object.values(tools.servers ?? {}).flatMap(serverFiles))];
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  for (;;) {
    const missing = (await Promise.all(files.map(file => access(file).then(() => '', () => file)))).filter(Boolean);
    if (!missing.length) return;
    if (Date.now() >= deadline) {
      if (tools.required) throw new Error(`Tower's tools for this turn cannot start: ${missing.join(', ')} is missing.`);
      return;
    }
    await delay(options.intervalMs ?? 250);
  }
}

/**
 * A capability in a tool server's environment would be visible in the process list as an argument, so such a
 * configuration goes to a private file (0600 in its own 0700 folder) that lives only as long as the turn.
 */
export async function privateMcpConfig(mcpServers: SessionMcpServers): Promise<{ path: string; bindConsumer(pid: number): Promise<void>; remove: () => Promise<void> }> {
  const temporary = await createPrivateTemporary('mcp');
  const { directory } = temporary;
  const remove = () => temporary.release();
  try {
    await chmod(directory, 0o700);
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify({ mcpServers }), { mode: 0o600, flag: 'wx' });
    return { path, bindConsumer: pid => temporary.bindConsumer(pid), remove };
  } catch (error) { await remove(); throw error; }
}
