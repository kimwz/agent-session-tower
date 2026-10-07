import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export type NativeInspectionRunner = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
export interface NativeInspection { complete: boolean; activeIds: ReadonlySet<string>; issues: string[] }

/** Unlike the UI inspector, failed process discovery cannot mean an empty live set. */
export async function inspectNativeRetention(claudeHome: string, roots: { claude: readonly string[]; codex: readonly string[] }, run: NativeInspectionRunner = (file, args, options) => execute(file, args, { ...options, encoding: 'utf8' })): Promise<NativeInspection> {
  const activeIds = new Set<string>(); const issues: string[] = [];
  try {
    const processSnapshot = async () => {
      const { stdout, stderr } = await run(process.platform === 'darwin' ? '/bin/ps' : 'ps', ['-axo', 'pid=,comm='], { timeout: 2500, maxBuffer: 4_000_000 });
      if (stderr.trim()) throw new Error('Partial process inspection.');
      const result = new Map<number, string>();
      for (const line of stdout.split('\n')) { const match = line.trim().match(/^(\d+)\s+(.+)$/); if (match) result.set(Number(match[1]), match[2]!); }
      if (!result.size) throw new Error('Empty process snapshot.');
      return result;
    };
    let processes = await processSnapshot();
    const pids = [...processes].filter(([, command]) => /codex|claude|node|MainThread/i.test(command)).map(([pid]) => pid);
    if (pids.length) {
      let files = '';
      try {
        const result = await run(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-F', 'pn', '-p', pids.join(',')], { timeout: 5000, maxBuffer: 8_000_000 });
        if (result.stderr.trim()) throw new Error('Partial open-file inspection.');
        files = result.stdout;
      }
      catch (error) {
        const value = error as { code?: number | string; stdout?: string; stderr?: string };
        if (value.code === 1 && !value.stderr?.trim()) files = value.stdout || '';
        else throw new Error('Open-file inspection unavailable.');
      }
      const observed = new Set(files.split('\n').filter(line => /^p[0-9]+$/.test(line)).map(line => Number(line.slice(1))));
      if (pids.some(pid => !observed.has(pid))) {
        // lsof exit 1 can mean a PID exited, but cannot by itself prove a complete empty snapshot.
        // Verify missing ownership through a second process snapshot, including any new provider process.
        processes = await processSnapshot();
        if ([...processes].some(([pid, command]) => /codex|claude|node|MainThread/i.test(command) && !observed.has(pid))) throw new Error('Open-file inspection omitted a live provider process.');
      }
      for (const line of files.split('\n')) {
        if (!line.startsWith('n')) continue;
        const path = line.slice(1);
        for (const provider of ['claude', 'codex'] as const) if (roots[provider].some(root => path.startsWith(root + sep))) {
          const name = basename(path);
          if (provider === 'codex') { const id = name.match(/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.(?:jsonl|lock)$/i)?.[1]; if (id) activeIds.add(`codex:${id}`); }
          else if (name.endsWith('.jsonl')) activeIds.add(`claude:${name.slice(0, -6).replace(/^agent-/, '')}`);
        }
      }
    }
    let names: string[] = [];
    try { names = await readdir(join(claudeHome, 'sessions')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const name of names.filter(value => /^\d+\.json$/.test(value))) {
      try {
        const data = JSON.parse(await readFile(join(claudeHome, 'sessions', name), 'utf8')) as { pid?: number; sessionId?: string };
        if (typeof data.pid === 'number' && processes.has(data.pid) && typeof data.sessionId === 'string' && /claude|node|MainThread/i.test(processes.get(data.pid)!)) activeIds.add(`claude:${data.sessionId}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  } catch (error) { issues.push(error instanceof Error ? error.message : 'Native inspection failed.'); }
  return { complete: !issues.length, activeIds, issues };
}
