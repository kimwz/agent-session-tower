import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Proof of which agent session started a helper run, written by the run itself as it starts. Tower puts a small shim for
 * `claude` and `codex` first in the PATH of every turn it runs. Claude Code and Codex export their own session id to every
 * command (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`) and a child keeps it even when it is detached from its parent, which
 * the process tree cannot show. A non-interactive new Claude run gets its session id from the shim, so the mark names the
 * exact child; any other run is matched by pid and process start time while it is alive.
 */
export interface LaunchMark { pid: number; startedAt?: number; provider: 'claude' | 'codex'; launcher: string; child?: string; at: number; file: string }

export const LAUNCH_MARKS_ENV = 'TOWER_LAUNCH_MARKS';
const MOST_MARKS = 2000;
const MARK_BYTES = 4096;
/** A mark naming its child waits this long for Tower to see that child. */
export const MARK_TTL_MS = 24 * 60 * 60_000;
const ID = /^[A-Za-z0-9-]{1,200}$/;

export const launchMarksDir = (stateDir: string) => join(stateDir, 'launch-marks');
export const launchShimsDir = (stateDir: string) => join(stateDir, 'runtime', 'launch-shims');

/**
 * The shim for one program. It never changes what runs: it finds the real program on the PATH without its own folder and
 * `exec`s it with the same environment (itself still first in the PATH, so a helper's own helpers are marked too).
 */
export function launchShim(name: 'claude' | 'codex'): string {
  // Each argument on its own, so an option's name inside a prompt never counts; nothing after `--` is an option.
  const inject = name === 'claude' ? `
new_id=''
print=''; own=''
# A subcommand (\`claude mcp …\`, \`claude update\`) never gets a session id.
case "\${1:-}" in -*) ;; *) own=1 ;; esac
for arg in "$@"; do
  case "$arg" in
    --) break ;;
    -p|--print) print=1 ;;
    --session-id|--session-id=*|-r|--resume|--resume=*|-c|--continue|--fork-session) own=1 ;;
  esac
done
if [ -n "$print" ] && [ -z "$own" ]; then
  new_id=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null)
  new_id=$(printf %s "$new_id" | tr 'A-Z' 'a-z' | tr -cd 'a-f0-9-')
  [ \${#new_id} -eq 36 ] || new_id=''
fi` : `
new_id=''`;
  return `#!/bin/sh
# Agent Session Tower: notes which agent session started this ${name} run, then runs the real ${name}.
# Every Tower's shim folder is skipped, and so is any program this chain already handed off to (a wrapper script that
# runs \`${name}\` again finds the next one), so two shims or a wrapper never hand off to each other forever.
real=''
used=\${TOWER_SHIM_USED:-}
old_ifs=$IFS; IFS=:
for dir in $PATH; do
  [ -n "$dir" ] || continue
  resolved=$(CDPATH= cd -- "$dir" 2>/dev/null && pwd -P) || continue
  case "$resolved" in */runtime/launch-shims) continue ;; esac
  case "|$used|" in *"|$resolved/${name}|"*) continue ;; esac
  if [ -x "$dir/${name}" ] && [ ! -d "$dir/${name}" ]; then real="$dir/${name}"; used="$used|$resolved/${name}"; break; fi
done
IFS=$old_ifs
if [ -z "$real" ]; then echo "${name}: command not found" >&2; exit 127; fi
TOWER_SHIM_USED=$used; export TOWER_SHIM_USED
${inject}
launcher=''
clean() { printf %s "$1" | tr -cd 'A-Za-z0-9-' | cut -c1-200; }
claude_id=$(clean "\${CLAUDE_CODE_SESSION_ID:-}")
codex_id=$(clean "\${CODEX_THREAD_ID:-}")
if [ -n "$claude_id" ]; then launcher="claude:$claude_id"; elif [ -n "$codex_id" ]; then launcher="codex:$codex_id"; fi
marks=\${${LAUNCH_MARKS_ENV}:-}
if [ -n "$launcher" ] && [ -n "$marks" ] && [ -d "$marks" ] && [ ! -L "$marks" ]; then
  started=$(LC_ALL=C ps -o lstart= -p $$ 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//')
  child=''
  [ -n "$new_id" ] && child="claude:$new_id"
  tmp="$marks/.$$.tmp"
  if { printf '{"pid":%s,"provider":"%s","launcher":"%s","child":"%s","started":"%s","at":%s}\\n' "$$" "${name}" "$launcher" "$child" "$started" "$(date +%s)" > "$tmp"; } 2>/dev/null; then
    mv -f "$tmp" "$marks/$$.json" 2>/dev/null || rm -f "$tmp"
  fi
fi
if [ -n "$new_id" ]; then exec "$real" --session-id "$new_id" "$@"; fi
exec "$real" "$@"
`;
}

/** Writes the shims where Tower's turns find them first; rewritten only when their text changed. Returns their folder. */
export async function installLaunchShims(stateDir: string): Promise<string> {
  const dir = launchShimsDir(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(launchMarksDir(stateDir), { recursive: true, mode: 0o700 });
  await chmod(launchMarksDir(stateDir), 0o700);
  for (const name of ['claude', 'codex'] as const) {
    const path = join(dir, name), text = launchShim(name);
    if (await readFile(path, 'utf8').catch(() => '') === text) continue;
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, text, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, path);
  }
  return dir;
}

/** The marks runs left, oldest first; broken, oversized and expired ones are removed. */
export async function readLaunchMarks(dir: string, now = Date.now()): Promise<LaunchMark[]> {
  const info = await lstat(dir).catch(() => undefined);
  // Only a folder of this account that nobody else can write to holds marks worth believing.
  if (!info?.isDirectory() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022)) return [];
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => /^\d{1,10}\.json$/.test(name));
  const marks: LaunchMark[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const mark = await readMark(file);
    if (!mark || now - mark.at > MARK_TTL_MS) { await rm(file, { force: true }).catch(() => {}); continue; }
    marks.push(mark);
  }
  marks.sort((a, b) => a.at - b.at);
  // A folder that grew past its limit loses its oldest marks.
  for (const mark of marks.splice(0, Math.max(0, marks.length - MOST_MARKS))) await rm(mark.file, { force: true }).catch(() => {});
  // Temporary files a shim left when it was stopped half way.
  for (const name of (await readdir(dir).catch(() => [] as string[])).filter(name => /^\.\d{1,10}\.tmp$/.test(name))) {
    const file = join(dir, name);
    const age = now - ((await stat(file).catch(() => undefined))?.mtimeMs ?? now);
    if (age > 60_000) await rm(file, { force: true }).catch(() => {});
  }
  return marks;
}

async function readMark(file: string): Promise<LaunchMark | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MARK_BYTES) return undefined;
    const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const pid = Number(value.pid), at = Number(value.at);
    const provider = value.provider === 'claude' || value.provider === 'codex' ? value.provider : undefined;
    const launcher = typeof value.launcher === 'string' ? value.launcher : '';
    const [kind, id] = launcher.split(/:(.*)/s);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isFinite(at) || !provider || (kind !== 'claude' && kind !== 'codex') || !ID.test(id ?? '')) return undefined;
    const child = typeof value.child === 'string' && /^claude:[a-f0-9-]{36}$/.test(value.child) ? value.child : undefined;
    const started = typeof value.started === 'string' && value.started ? Date.parse(value.started) : NaN;
    return { pid, provider, launcher, ...(child ? { child } : {}), ...(Number.isFinite(started) ? { startedAt: started } : {}), at: at * 1000, file };
  } catch { return undefined; }
}

/**
 * Which session each mark proves was launched by whom. A mark naming its child needs nothing else. Any other mark needs its
 * process alive with the same start time, so a pid used again by an unrelated program is never taken for the helper.
 * Returns the proofs and the marks that were used (to be removed).
 */
export function matchLaunchMarks(marks: LaunchMark[], owners: ReadonlyMap<number, readonly string[]>, started: ReadonlyMap<number, number>, known: ReadonlySet<string>, parents: ReadonlyMap<number, number> = new Map()): { proofs: Map<string, string>; used: LaunchMark[] } {
  const proofs = new Map<string, string>();
  const used: LaunchMark[] = [];
  for (const mark of marks) {
    // Kept until its child's record exists: a proof for a session not listed yet would be dropped as gone.
    if (mark.child) {
      if (!known.has(mark.child)) continue;
      if (mark.child !== mark.launcher) proofs.set(mark.child, mark.launcher);
      used.push(mark);
      continue;
    }
    const start = started.get(mark.pid);
    // Its process is gone (or another program has its pid) and it named no child: it can never prove anything now.
    if (started.size && (start === undefined || (mark.startedAt !== undefined && Math.abs(start - mark.startedAt) > 1000))) { used.push(mark); continue; }
    if (mark.startedAt === undefined || start === undefined || Math.abs(start - mark.startedAt) > 1000) continue;
    // A launcher script (npm's `codex`) may start the native program as its own child: its sessions count too.
    const pids = [mark.pid, ...[...parents].filter(([, parent]) => parent === mark.pid).map(([pid]) => pid)];
    const sessions = pids.flatMap(pid => owners.get(pid) ?? []).filter(session => session !== mark.launcher && session.startsWith(`${mark.provider}:`));
    // Kept until every session it proves is listed, like a mark naming its child.
    if (!sessions.length || sessions.some(session => !known.has(session))) continue;
    for (const session of sessions) proofs.set(session, mark.launcher);
    used.push(mark);
  }
  return { proofs, used };
}
