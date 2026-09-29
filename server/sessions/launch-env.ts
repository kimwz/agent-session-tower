import { delimiter } from 'node:path';

/**
 * Tower is often restarted from inside an agent's turn (a deploy). Its web, worker and terminal host would then inherit that
 * turn's identity and launch shims, and a `claude -p` the owner types in a Tower terminal would be marked as that agent's
 * helper. Tower's own processes start without them; each turn gets its own again.
 */
export function withoutLauncher(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  delete env.TOWER_LAUNCH_MARKS;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  if (env.PATH) env.PATH = env.PATH.split(delimiter).filter(dir => !/[\\/]runtime[\\/]launch-shims[\\/]?$/.test(dir)).join(delimiter);
  return env;
}

withoutLauncher(process.env);
