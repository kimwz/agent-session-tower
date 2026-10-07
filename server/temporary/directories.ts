import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, rmSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

const uid = () => process.getuid?.() ?? 0;
const MARKER_VERSION = 1;
const GRACE_MS = 48 * 60 * 60_000;
const LEGACY = /^(tower-terminal-host|tower-nodes-same)-[A-Za-z0-9]{6}$/;
interface Owner { version: 1; id: string; kind: 'mcp' | 'pty'; directory: string; uid: number; dev: number; ino: number; ownerPid: number; ownerStartedAt: number; consumerPids: number[]; createdAt: number }
export interface TemporaryProtection { complete: boolean; issues: string[]; paths: string[]; openedPaths?: string[] }
export interface TemporaryOverview { checkedAt?: string; examined: number; removedEmpty: number; releasedOwned: number; eligibleEmpty: number; eligibleOwned: number; deferredActive: number; deferredUnproven: number; failed: number; issues: string[]; eligiblePaths: string[]; removedPaths: string[] }
export interface PrivateTemporary { directory: string; bindConsumer(pid: number): Promise<void>; release(): Promise<void>; releaseOnExit(): void }
const blank = (): TemporaryOverview => ({ examined: 0, removedEmpty: 0, releasedOwned: 0, eligibleEmpty: 0, eligibleOwned: 0, deferredActive: 0, deferredUnproven: 0, failed: 0, issues: [], eligiblePaths: [], removedPaths: [] });
const validPid = (pid: number) => Number.isInteger(pid) && pid > 1;
function alive(pid: number): boolean { if (!validPid(pid)) return true; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
async function canonicalPath(path: string): Promise<string> { let current = resolve(path); const tail: string[] = []; for (;;) { try { return join(await realpath(current), ...tail.reverse()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(current); if (parent === current) throw error; tail.push(basename(current)); current = parent; } } }
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(b + sep) || b.startsWith(a + sep); }
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid() || (info.mode & 0o077)) throw new Error('Temporary ownership directory is not private.');
}
async function base(root: string): Promise<string> { const path = join(await realpath(root), `tower-owned-${uid()}`); await privateDirectory(path); await privateDirectory(join(path, 'data')); await privateDirectory(join(path, 'records')); return path; }
async function identity(owner: Owner): Promise<boolean> { const info = await lstat(owner.directory); return info.isDirectory() && !info.isSymbolicLink() && info.uid === owner.uid && info.dev === owner.dev && info.ino === owner.ino && !(info.mode & 0o077); }
function ownerShape(value: unknown, namespace: string): value is Owner {
  const record = value as Owner | undefined;
  return !!record && record.version === MARKER_VERSION && /^[0-9a-f-]{36}$/.test(record.id) && ['mcp', 'pty'].includes(record.kind) && record.uid === uid()
    && dirname(record.directory) === join(namespace, 'data') && /^(mcp|pty)-[A-Za-z0-9]{6}$/.test(basename(record.directory)) && resolve(record.directory) === record.directory && validPid(record.ownerPid)
    && Number.isFinite(record.ownerStartedAt) && Number.isFinite(record.createdAt) && Number.isInteger(record.dev) && Number.isInteger(record.ino)
    && Array.isArray(record.consumerPids) && record.consumerPids.every(validPid);
}
/** Allocation and its ownership evidence are written together; callers can release only the exact directory they created. */
export async function createPrivateTemporary(kind: Owner['kind'], root = tmpdir()): Promise<PrivateTemporary> {
  const namespace = await base(root), id = randomUUID();
  const directory = await mkdtemp(join(namespace, 'data', `${kind}-`));
  const info = await lstat(directory), recordPath = join(namespace, 'records', `${id}.json`);
  const owner: Owner = { version: 1, id, kind, directory, uid: uid(), dev: info.dev, ino: info.ino, ownerPid: process.pid, ownerStartedAt: Date.now() - process.uptime() * 1000, consumerPids: [], createdAt: Date.now() };
  try { await writePrivateJson(recordPath, JSON.stringify(owner), { syncDirectory: true }); } catch (error) { await rm(directory, { recursive: true }); throw error; }
  let releasing: Promise<void> | undefined;
  let binding: Promise<void> = Promise.resolve();
  return { directory,
    releaseOnExit() {
      if (owner.consumerPids.some(pid => pid !== process.pid && alive(pid))) throw new Error('Temporary consumer still alive; kept.');
      try { const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner.uid || info.dev !== owner.dev || info.ino !== owner.ino) throw new Error('Temporary identity changed; kept.'); rmSync(directory, { recursive: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { unlinkSync(recordPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    },
    // best-effort: the preceding bind rejection already reached its caller; recover the queue only so an explicit retry can persist a new binding.
    bindConsumer(pid) { if (!validPid(pid)) return Promise.reject(new Error('Invalid temporary consumer PID.')); binding = binding.catch(() => {}).then(async () => { if (releasing) throw new Error('Temporary directory is releasing.'); if (!owner.consumerPids.includes(pid)) { const next = { ...owner, consumerPids: [...owner.consumerPids, pid] }; await writePrivateJson(recordPath, JSON.stringify(next), { syncDirectory: true }); owner.consumerPids = next.consumerPids; } }); return binding; },
    release() { return releasing ??= binding.then(async () => {
      if (owner.consumerPids.some(alive)) throw new Error('Temporary consumer still alive; kept.');
      try { if (!await identity(owner)) throw new Error('Temporary directory identity changed; kept.'); await rm(directory, { recursive: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await unlink(recordPath);
    }).catch(error => { releasing = undefined; console.error('Temporary directory release failed:', error); throw error; }); },
  };
}

/** Removes only registered orphan allocations or old, empty fixtures from the two proven source namespaces. */
export class TemporaryCollector {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<TemporaryOverview>;
  private paused = false;
  private closed = false;
  private latest = blank();
  private offsets = new Map<string, number>();
  private ordered(key: string, names: string[]): string[] { const start = (this.offsets.get(key) ?? 0) % (names.length || 1); this.offsets.set(key, start + 100); return [...names.slice(start), ...names.slice(0, start)].slice(0, 100); }
  constructor(private readonly options: { protection: () => Promise<TemporaryProtection>; roots?: string[]; now?: () => number; dryRun?: boolean; resolvePath?: (path: string) => Promise<string>; inspectCandidate?: (path: string) => Promise<{ complete: boolean; open: boolean }> }) {}
  overview(): TemporaryOverview { return structuredClone(this.latest); }
  start(): void { if (this.closed || this.timer) return; this.timer = setTimeout(() => { this.timer = undefined; void this.cycle().catch(error => console.error('Temporary collection failed:', error)).finally(() => this.start()); }, 5 * 60_000); this.timer.unref(); }
  async quiesce(): Promise<void> { this.paused = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; await this.running; }
  resume(): void { if (!this.closed) { this.paused = false; this.start(); } }
  async close(): Promise<void> { this.closed = true; await this.quiesce(); }
  cycle(): Promise<TemporaryOverview> { if (this.paused || this.closed) return Promise.resolve(this.overview()); return this.running ??= this.collect().finally(() => { this.running = undefined; }); }
  private async collect(): Promise<TemporaryOverview> {
    const result = blank(), now = this.options.now?.() ?? Date.now(); result.checkedAt = new Date(now).toISOString();
    const protection = await this.options.protection(); result.issues.push(...protection.issues);
    if (!protection.complete) { result.issues.push('Process/path inspection incomplete; temporary cleanup deferred.'); return this.latest = result; }
    const roots = [...new Set(await Promise.all((this.options.roots ?? ['/tmp', tmpdir()]).map(path => realpath(path))))];
    const resolvePath = this.options.resolvePath ?? canonicalPath;
    const normalise = async (snapshot: TemporaryProtection) => {
      const paths: string[] = [], opened: string[] = []; let uncertainOpened = false;
      for (const path of snapshot.paths) {
        try { paths.push(await resolvePath(path)); }
        catch (error) { result.issues.push(`Reserved temporary path cannot be resolved: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); return { complete: false, paths, opened, uncertainOpened }; }
      }
      for (const path of snapshot.openedPaths ?? []) {
        try { opened.push(await resolvePath(path)); }
        catch (error) { uncertainOpened = true; const issue = `OS opened path requires inode inspection: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`; if (!result.issues.includes(issue)) result.issues.push(issue); }
      }
      return { complete: snapshot.complete, paths, opened, uncertainOpened };
    };
    const initial = await normalise(protection);
    if (!initial.complete) return this.latest = result;
    // NAME resolution is only an early protection signal; every OS-backed deletion also needs the fresh inode query.
    const hasOpenInside = (path: string, values: string[]) => values.some(value => value === path || value.startsWith(path + sep));
    const protectedPath = (path: string) => initial.paths.some(value => overlaps(path, value)) || hasOpenInside(path, initial.opened);
    const freshProtected = async (path: string) => {
      const snapshot = await this.options.protection();
      if (!snapshot.complete) { result.issues.push(...snapshot.issues); return true; }
      const fresh = await normalise(snapshot);
      if (!fresh.complete || fresh.paths.some(value => overlaps(path, value)) || hasOpenInside(path, fresh.opened)) return true;
      if (snapshot.openedPaths !== undefined || protection.openedPaths !== undefined) {
        const inspection = await (this.options.inspectCandidate ?? inspectTemporaryCandidate)(path);
        if (!inspection.complete) result.issues.push('Candidate open-file inode inspection incomplete; kept.');
        return !inspection.complete || inspection.open;
      }
      return false;
    };
    const stopped = () => this.paused || this.closed || result.examined >= 500 || (Date.now() - started > 5000);
    const started = Date.now();
    for (const root of roots) {
      if (stopped()) break;
      const namespace = join(root, `tower-owned-${uid()}`);
      const safeNamespace = await Promise.all([namespace, join(namespace, 'data'), join(namespace, 'records')].map(async path => { try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid() && !(info.mode & 0o077); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.issues.push(`Owned temporary namespace cannot be inspected: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`); return false; } }));
      const records = safeNamespace.every(Boolean) ? await readdir(join(namespace, 'records')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') result.issues.push(`Owned temporary records cannot be inspected: ${error.code}`); return []; }) : [];
      for (const name of this.ordered(namespace, records)) {
        if (stopped()) break;
        result.examined++;
        const file = join(namespace, 'records', name);
        try {
          const metadata = await lstat(file);
          if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid() || (metadata.mode & 0o077)) { result.deferredUnproven++; continue; }
          const value = await readPrivateJson(file);
          if (!ownerShape(value, namespace) || name !== `${value.id}.json`) { result.deferredUnproven++; continue; }
          if (alive(value.ownerPid) || value.consumerPids.some(alive) || protectedPath(value.directory) || now - value.createdAt < GRACE_MS) { result.deferredActive++; continue; }
          try { if (!await identity(value)) { result.deferredUnproven++; continue; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; result.eligibleOwned++; result.eligiblePaths.push(value.directory); if (!this.options.dryRun) { await unlink(file); result.releasedOwned++; } continue; }
          if (await freshProtected(value.directory) || stopped() || alive(value.ownerPid) || value.consumerPids.some(alive)) { result.deferredActive++; continue; }
          if (!await identity(value)) { result.deferredUnproven++; continue; }
          result.eligibleOwned++; result.eligiblePaths.push(value.directory);
          if (!this.options.dryRun) { await rm(value.directory, { recursive: true }); await unlink(file); result.releasedOwned++; result.removedPaths.push(value.directory); }
        } catch (error) { result.failed++; result.issues.push(`Owned temporary cleanup failed: ${(error as NodeJS.ErrnoException).code ?? 'invalid-record'}`); }
      }
      for (const name of this.ordered(root, (await readdir(root)).filter(name => LEGACY.test(name)))) {
        if (stopped()) break;
        if (!LEGACY.test(name)) continue;
        result.examined++;
        const path = join(root, name);
        try {
          const before = await lstat(path);
          if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid() || (before.mode & 0o022) || now - before.mtimeMs < GRACE_MS || (await readdir(path)).length) { result.deferredUnproven++; continue; }
          if (protectedPath(path)) { result.deferredActive++; continue; }
          if (await freshProtected(path) || stopped()) { result.deferredActive++; continue; }
          const after = await lstat(path);
          if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory() || after.isSymbolicLink() || after.uid !== uid()) { result.deferredUnproven++; continue; }
          result.eligibleEmpty++; result.eligiblePaths.push(path);
          if (!this.options.dryRun) { await rmdir(path); result.removedEmpty++; result.removedPaths.push(path); }
        } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === 'ENOTEMPTY' || code === 'ENOENT') result.deferredUnproven++; else { result.failed++; result.issues.push(`Empty temporary cleanup failed: ${code ?? 'unknown'}`); } }
      }
    }
    return this.latest = result;
  }
}

/** lsof +D matches directory device/inodes instead of trusting inaccessible NAME paths. */
export async function inspectTemporaryCandidate(directory: string): Promise<{ complete: boolean; open: boolean }> {
  try {
    const pending = [directory]; let entries = 0;
    while (pending.length) {
      const current = pending.pop()!;
      for (const name of await readdir(current)) {
        if (++entries > 200) return { complete: false, open: false };
        const path = join(current, name), info = await lstat(path);
        if (info.isDirectory() && !info.isSymbolicLink()) pending.push(path);
      }
    }
    try {
      const { stdout, stderr } = await promisify(execFile)(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-a', '-u', String(uid()), '+D', directory, '-F', 'f'], { timeout: 1000, maxBuffer: 1024 * 1024 });
      return { complete: !stderr.trim(), open: stdout.split('\n').some(line => line.startsWith('f')) };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
      // Exit 1 without output means no selected open inode; warnings and timeouts fail closed.
      return { complete: failure.code === 1 && !failure.killed && !failure.stdout?.trim() && !failure.stderr?.trim(), open: !!failure.stdout?.split('\n').some(line => line.startsWith('f')) };
    }
  } catch (error) { console.error('Temporary candidate inode inspection failed:', (error as NodeJS.ErrnoException).code ?? 'unknown'); return { complete: false, open: false }; }
}

/** Inspects paths only, never process arguments, configuration contents or authentication values. Partial listings fail closed. */
export async function inspectTemporaryProtection(): Promise<TemporaryProtection> {
  const paths = new Set<string>(), issues: string[] = [];
  if (process.platform === 'linux') {
    try {
      for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
        const directory = join('/proc', pid);
        try {
          if ((await lstat(directory)).uid !== uid()) continue;
          paths.add(await readlink(join(directory, 'cwd')));
          for (const fd of await readdir(join(directory, 'fd'))) {
            try { const path = await readlink(join(directory, 'fd', fd)); if (path.startsWith('/')) paths.add(path.replace(/ \(deleted\)$/, '')); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push(`Temporary process path inspection failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); }
      }
    } catch (error) { issues.push(`Temporary process directory inspection failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); }
  } else {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-a', '-u', String(uid()), '-F', 'tn'], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
      if (stderr.trim()) issues.push('Temporary open-path inspection reported warnings; completeness unproven.');
      let fileType = '';
      for (const line of stdout.split('\n')) {
        if (line.startsWith('t')) fileType = line.slice(1);
        if (!line.startsWith('n')) continue;
        if (line.startsWith('n/') && !line.includes(' -- ')) paths.add(line.slice(1));
        else if (['REG', 'DIR', 'LNK'].includes(fileType)) issues.push('Temporary filesystem NAME reporting is partial; completeness unproven.');
      }
      if (!paths.size) issues.push('Temporary open-path listing is empty.');
    } catch (error) { issues.push(`Temporary open-path inspection failed or incomplete: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); }
  }
  return { complete: issues.length === 0, issues, paths: [], openedPaths: [...paths] };
}
