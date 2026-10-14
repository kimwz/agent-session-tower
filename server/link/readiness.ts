import { execFile } from 'node:child_process';
import type { LoginState } from '../../shared/link.js';
import type { ProviderHealth } from '../../shared/types.js';
import { findExecutable } from '../providers/discovery.js';

/**
 * Whether new work can start on this computer, as it reports to the Towers that control it: whether Claude Code,
 * Codex and gh are signed in. Never an account, token or path.
 */

/** A provider's CLI, from what Tower already reads of it here (its account and usage): missing also when it is not installed. */
export function providerLogin(health: ProviderHealth | undefined): LoginState {
  if (!health?.available || health.usage?.reason === 'not_signed_in') return 'missing';
  if (health.account || health.usage?.windows.length || health.usage?.status === 'available') return 'ok';
  return 'unknown';
}

/** `gh auth status` by its exit code alone: its output names the account and part of the token, and is never read. */
export async function ghAuthStatus(env: NodeJS.ProcessEnv = process.env): Promise<LoginState> {
  const gh = await findExecutable('gh', env);
  if (!gh) return 'missing';
  return new Promise(resolve => {
    execFile(gh, ['auth', 'status'], { env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true }, error => {
      // gh exits 1 when no host is signed in, or a host's sign-in no longer works; anything else says nothing.
      resolve(!error ? 'ok' : error.code === 1 && !error.killed ? 'missing' : 'unknown');
    });
  });
}

/** gh's sign-in, asked again only after a few minutes: a report every minute does not start gh every minute. */
export class GhLogin {
  private last?: { at: number; state: Promise<LoginState> };
  constructor(private readonly options: { check?: () => Promise<LoginState>; now?: () => number; ttlMs?: number } = {}) {}

  state(): Promise<LoginState> {
    const now = (this.options.now ?? Date.now)();
    if (!this.last || now - this.last.at >= (this.options.ttlMs ?? 5 * 60_000)) {
      // best-effort: a check that fails says nothing about the sign-in.
      this.last = { at: now, state: (this.options.check ?? ghAuthStatus)().catch(() => 'unknown' as const) };
    }
    return this.last.state;
  }
}
