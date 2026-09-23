import { execFile } from 'node:child_process';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export interface LiveSession {
  status?: string;
  name?: string;
  updatedAt?: number;
}

export interface ProcessSnapshot {
  claude: Map<string, LiveSession>;
  codex: Set<string>;
  providerRunning: { claude: boolean; codex: boolean };
  /**
   * Sessions whose live process runs under another agent session's process, keyed by session id.
   * Each value lists the sessions that ancestor process holds. Only a running process proves this.
   */
  launchers?: Map<string, string[]>;
}

/** Only exact native files under this Codex home count as a live session. */
export function parseCodexOpenFiles(output: string, codexHome: string): Set<string> {
  return new Set([...codexSessionsByProcess(output, codexHome).values()].flatMap(ids => [...ids]));
}

/** `lsof -F pn` output: each `p<pid>` line starts the files of one process. */
export function codexSessionsByProcess(output: string, codexHome: string): Map<number, Set<string>> {
  const processes = new Map<number, Set<string>>();
  const roots = ['sessions', 'thread-writer-locks'].map((directory) => join(codexHome, directory) + sep);
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)) || 0; continue; }
    if (!line.startsWith('n')) continue;
    const path = line.slice(1);
    if (!roots.some((root) => path.startsWith(root))) continue;
    const id = basename(path).match(/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.(?:jsonl|lock)$/i)?.[1];
    if (!id) continue;
    const ids = processes.get(pid) ?? new Set<string>();
    ids.add(id);
    processes.set(pid, ids);
  }
  return processes;
}

/**
 * A session launched from inside another agent's turn (for example `codex exec` in a Claude Bash
 * call) runs in a descendant of that agent's process. The walk stops at `boundary`: everything
 * this monitor's own worker starts belongs to the user who asked for it, never to another agent.
 */
export function processLaunchers(parents: ReadonlyMap<number, number>, owners: ReadonlyMap<number, readonly string[]>, boundary: number): Map<string, string[]> {
  const launchers = new Map<string, string[]>();
  for (const [pid, sessions] of owners) {
    const seen = new Set<number>([pid]);
    for (let ancestor = parents.get(pid); ancestor && ancestor > 1 && ancestor !== boundary && !seen.has(ancestor); ancestor = parents.get(ancestor)) {
      seen.add(ancestor);
      const launcher = owners.get(ancestor);
      if (!launcher) continue;
      for (const session of sessions) if (!launcher.includes(session)) launchers.set(session, [...launcher]);
      break;
    }
  }
  return launchers;
}

/** Read only process metadata. Never reads credentials or Claude peer key files. */
export async function inspectProcesses(claudeHome: string, codexHome: string): Promise<ProcessSnapshot> {
  const snapshot: ProcessSnapshot = {
    claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false },
  };
  const commands = new Map<number, { command: string; startedAt: number }>();
  const parents = new Map<number, number>();
  const owners = new Map<number, string[]>();
  try {
    const { stdout } = await execute(process.platform === 'darwin' ? '/bin/ps' : 'ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { timeout: 2000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      if (!match) continue;
      parents.set(Number(match[1]), Number(match[2]));
      commands.set(Number(match[1]), { command: match[4]!, startedAt: Date.parse(match[3]!) });
      if (/(?:^|\/)claude(?:\s|$)/i.test(match[4]!)) snapshot.providerRunning.claude = true;
      if (/(?:^|\/)(?:codex|Codex)(?:\s|$)/.test(match[4]!)) snapshot.providerRunning.codex = true;
    }
  } catch { /* Process listing can be denied by the host sandbox. */ }

  try {
    const entries = await readdir(join(claudeHome, 'sessions'));
    await Promise.all(entries.filter((name) => /^\d+\.json$/.test(name)).map(async (name) => {
      try {
        const data = JSON.parse(await readFile(join(claudeHome, 'sessions', name), 'utf8'));
        const pid = Number(data.pid);
        if (!Number.isSafeInteger(pid) || pid <= 0 || typeof data.sessionId !== 'string') return;
        if (commands.size && !commands.has(pid)) return;
        // A stale registry entry must not attach to a recycled non-Claude PID.
        const processInfo = commands.get(pid);
        const command = processInfo?.command;
        if (command && !/claude|node/i.test(command)) return;
        if (processInfo && typeof data.updatedAt === 'number' && processInfo.startedAt > data.updatedAt + 2000) return;
        try { process.kill(pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EPERM') return;
        }
        owners.set(pid, [`claude:${data.sessionId}`]);
        snapshot.claude.set(data.sessionId, {
          status: typeof data.status === 'string' ? data.status : undefined,
          name: typeof data.name === 'string' ? data.name : undefined,
          updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : undefined,
        });
        snapshot.providerRunning.claude = true;
      } catch { /* Registry files may disappear while a process exits. */ }
    }));
  } catch { /* Claude versions before the registry are supported through logs. */ }

  try {
    // Desktop Codex holds rollout files open but does not always expose writer-lock
    // files. Both kinds identify the exact session without guessing from app liveness.
    const root = await realpath(codexHome).catch(() => resolve(codexHome));
    const { stdout } = await execute(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-F', 'pn', '-c', 'codex', '-c', 'Codex'], {
      timeout: 2500, maxBuffer: 4 * 1024 * 1024,
    });
    for (const [pid, ids] of codexSessionsByProcess(stdout, root)) {
      for (const id of ids) snapshot.codex.add(id);
      if (pid) owners.set(pid, [...(owners.get(pid) ?? []), ...[...ids].map(id => `codex:${id}`)]);
    }
    if (snapshot.codex.size) snapshot.providerRunning.codex = true;
  } catch { /* lsof is optional, including on non-macOS systems. */ }
  snapshot.launchers = processLaunchers(parents, owners, process.pid);
  return snapshot;
}
