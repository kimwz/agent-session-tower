import { execFile } from 'node:child_process';
import { findExecutable } from '../providers/discovery.js';

export type GitRunner = (cwd: string, args: string[], timeoutMs: number) => Promise<string>;

/**
 * Git as Tower runs it beside the owner's agents: never prompts for credentials, never starts
 * background maintenance, and never takes the index lock only to refresh stat information.
 */
export function gitRunner(env: NodeJS.ProcessEnv = process.env): GitRunner {
  let executable: Promise<string> | undefined;
  const environment = { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
  return async (cwd, args, timeoutMs) => {
    executable ??= findExecutable('git', env).then(found => found ?? 'git');
    const file = await executable;
    return new Promise((resolve, reject) => {
      execFile(file, ['-C', cwd, '--no-optional-locks', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
        { env: environment, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) { resolve(stdout); return; }
          const detail = String(stderr).trim().split('\n').filter(Boolean).at(-1);
          reject(new Error(error.killed ? `git ${args[0]} timed out` : detail || error.message));
        });
    });
  };
}

export interface LocalStatus {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: number;
}

/** Reads `git status --porcelain=v2 --branch`. */
export function parseStatus(output: string): LocalStatus {
  const status: LocalStatus = { ahead: 0, behind: 0, changes: 0 };
  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14);
      if (head !== '(detached)') status.branch = head;
    } else if (line.startsWith('# branch.upstream ')) status.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const match = /^\+(\d+) -(\d+)$/.exec(line.slice(12));
      if (match) { status.ahead = Number(match[1]); status.behind = Number(match[2]); }
    } else if (/^[12u] /.test(line)) status.changes++;
  }
  return status;
}
