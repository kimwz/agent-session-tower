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
}

/** Only exact native files under this Codex home count as a live session. */
export function parseCodexOpenFiles(output: string, codexHome: string): Set<string> {
  const ids = new Set<string>();
  const roots = ['sessions', 'thread-writer-locks'].map((directory) => join(codexHome, directory) + sep);
  for (const line of output.split('\n')) {
    if (!line.startsWith('n')) continue;
    const path = line.slice(1);
    if (!roots.some((root) => path.startsWith(root))) continue;
    const id = basename(path).match(/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.(?:jsonl|lock)$/i)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

/** Read only process metadata. Never reads credentials or Claude peer key files. */
export async function inspectProcesses(claudeHome: string, codexHome: string): Promise<ProcessSnapshot> {
  const snapshot: ProcessSnapshot = {
    claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false },
  };
  const commands = new Map<number, { command: string; startedAt: number }>();
  try {
    const { stdout } = await execute(process.platform === 'darwin' ? '/bin/ps' : 'ps', ['-axo', 'pid=,lstart=,comm='], { timeout: 2000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      if (!match) continue;
      commands.set(Number(match[1]), { command: match[3]!, startedAt: Date.parse(match[2]!) });
      if (/(?:^|\/)claude(?:\s|$)/i.test(match[3]!)) snapshot.providerRunning.claude = true;
      if (/(?:^|\/)(?:codex|Codex)(?:\s|$)/.test(match[3]!)) snapshot.providerRunning.codex = true;
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
    const { stdout } = await execute(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-F', 'n', '-c', 'codex', '-c', 'Codex'], {
      timeout: 2500, maxBuffer: 4 * 1024 * 1024,
    });
    snapshot.codex = parseCodexOpenFiles(stdout, root);
    if (snapshot.codex.size) snapshot.providerRunning.codex = true;
  } catch { /* lsof is optional, including on non-macOS systems. */ }
  return snapshot;
}
