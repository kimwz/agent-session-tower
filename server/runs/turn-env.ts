import { delimiter } from 'node:path';
import type { Session } from '../../shared/types.js';
import { providerDirectories } from '../providers/discovery.js';
import { LAUNCH_MARKS_ENV } from '../sessions/launch-marks.js';
import { CALLER_CAPABILITY_ENV, type RunTools } from './session-mcp.js';
import { withoutKeys } from './subscription.js';

/**
 * Folder of the `claude`/`codex` shims put first in every turn's PATH, and where their marks go: a helper the turn starts
 * notes who started it, so it is never shown as the owner's own session even when detached (see launch-marks.ts).
 */
export interface LaunchMarks { shims: string; marks: string }

/** Puts the launch shims first in `env`'s PATH and tells them where to leave their marks. */
export function markLaunches(env: NodeJS.ProcessEnv, launch: LaunchMarks | undefined): void {
  if (!launch) return;
  env.PATH = [launch.shims, ...(env.PATH ?? '').split(delimiter).filter(dir => dir && dir !== launch.shims)].join(delimiter);
  env[LAUNCH_MARKS_ENV] = launch.marks;
}

/**
 * The environment a command run for a conversation gets, so a `claude`/`codex` it starts is recorded as that
 * conversation's own run, as if its agent had started it: the launch shims first on PATH, and the conversation's id.
 */
export function sessionEnv(env: NodeJS.ProcessEnv, session: Session | undefined, launch: LaunchMarks | undefined): NodeJS.ProcessEnv {
  const next = { ...env };
  markLaunches(next, launch);
  // The id the provider itself sets for its own tools: the bare native id, as the shims expect it.
  if (session?.nativeId) next[session.provider === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_CODE_SESSION_ID'] = session.nativeId;
  return next;
}

/**
 * A provider turn's environment, the same for Codex and Claude: the provider's folders on PATH, the launch shims first,
 * a caller capability only from the turn's own tools, and no marker of a provider this worker itself may run inside.
 * The master's turns never see API keys (see subscription.ts).
 */
export function turnEnv(base: NodeJS.ProcessEnv | undefined, master: boolean, tools: RunTools, launch: LaunchMarks | undefined): NodeJS.ProcessEnv {
  const env = master ? withoutKeys({ ...process.env, ...base }) : { ...process.env, ...base };
  env.PATH = providerDirectories(env).join(delimiter);
  markLaunches(env, launch);
  delete env[CALLER_CAPABILITY_ENV];
  Object.assign(env, tools.env);
  // The web server may itself have been started from inside Claude Code.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  return env;
}
