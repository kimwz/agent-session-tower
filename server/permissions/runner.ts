import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PermissionRun, PermissionRunOutput } from '../../shared/permissions.js';
import { writePrivateJson } from '../stores/private-json.js';

const exec = promisify(execFile);
/** Each stream keeps its first and last part. */
const KEEP_BYTES = 64 * 1024;
const PREVIEW_CHARS = 2_000;
const KILL_GRACE_MS = 5_000;
/** Runs at once on this computer; one conversation's run one after another. */
const MAX_RUNNING = 4;

/** What the OS reports as a process's start time; undefined when there is no such process. */
export async function processStart(pid: number): Promise<string | undefined> {
  try { return (await exec('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5_000 })).stdout.trim() || undefined; }
  catch { return undefined; }
}

const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const signalGroup = (pgid: number, signal: NodeJS.Signals) => { try { process.kill(-pgid, signal); } catch { /* gone */ } };

/** A stream kept as its first and last `KEEP_BYTES`, with the total size. */
class Kept {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  bytes = 0;
  add(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.headBytes < KEEP_BYTES) {
      const part = chunk.subarray(0, KEEP_BYTES - this.headBytes);
      this.head.push(part); this.headBytes += part.length;
      chunk = chunk.subarray(part.length);
    }
    if (!chunk.length) return;
    this.tail.push(chunk); this.tailBytes += chunk.length;
    while (this.tailBytes - this.tail[0]!.length >= KEEP_BYTES) this.tailBytes -= this.tail.shift()!.length;
  }
  get truncated(): boolean { return this.bytes > this.headBytes + Math.min(this.tailBytes, KEEP_BYTES); }
  text(): string {
    const tail = Buffer.concat(this.tail);
    const last = tail.subarray(Math.max(0, tail.length - KEEP_BYTES));
    const head = Buffer.concat(this.head).toString('utf8');
    if (!last.length) return head;
    return this.truncated ? `${head}\n… [${this.bytes - this.headBytes - last.length} bytes left out] …\n${last.toString('utf8')}` : head + last.toString('utf8');
  }
}

export interface RunnerOptions {
  stateDir: string;
  /** Saves the run's state on its request as it changes. */
  update(id: string, run: PermissionRun): Promise<void>;
  /** The run finished (done or failed). */
  finished?(id: string): void;
  killGraceMs?: number;
  now?: () => Date;
}

/**
 * Runs the one exact command a request was allowed, once, in the conversation's folder: `/bin/sh -c`, its own process
 * group, stdin closed, a time limit after which the whole group is stopped. The whole output (first and last 64 KiB of
 * each stream) goes to `<state>/permission-runs/<id>.json`; the request keeps a summary.
 */
export class PermissionRunner {
  private readonly running = new Map<string, Promise<void>>();
  private readonly queue: { id: string; command: string; cwd: string; timeoutSeconds: number; group: string }[] = [];
  private readonly groups = new Map<string, string>();
  private gate: Promise<void> | undefined;
  private readonly dir: string;

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  constructor(private readonly options: RunnerOptions) { this.dir = join(options.stateDir, 'permission-runs'); }

  inFlight(): boolean { return this.running.size > 0 || this.queue.length > 0 || this.gate !== undefined; }
  async flush(): Promise<void> {
    while (this.inFlight()) await Promise.all([...this.running.values(), this.gate, new Promise(resolve => setTimeout(resolve, 50))]);
  }
  isRunning(id: string): boolean { return this.running.has(id); }

  /** Nothing starts until `work` (the recovery of what an earlier worker left) is done. */
  hold(work: Promise<unknown>): void {
    const gate: Promise<void> = work.then(() => {}, () => {}).finally(() => { if (this.gate === gate) this.gate = undefined; this.pump(); });
    this.gate = gate;
  }

  /** Queues a run; it starts once its conversation has no other run and fewer than `MAX_RUNNING` run. */
  start(id: string, command: string, cwd: string, timeoutSeconds: number, group = id): void {
    if (this.running.has(id) || this.queue.some(item => item.id === id)) return;
    this.queue.push({ id, command, cwd, timeoutSeconds, group });
    this.pump();
  }

  private pump(): void {
    if (this.gate) return;
    const busy = new Set(this.groups.values());
    for (let index = 0; index < this.queue.length && this.running.size < MAX_RUNNING;) {
      const item = this.queue[index]!;
      if (busy.has(item.group)) { index += 1; continue; }
      this.queue.splice(index, 1);
      busy.add(item.group);
      this.groups.set(item.id, item.group);
      const work = this.execute(item.id, item.command, item.cwd, item.timeoutSeconds)
        .catch(error => console.error(`A permission run failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { this.running.delete(item.id); this.groups.delete(item.id); this.options.finished?.(item.id); this.pump(); });
      this.running.set(item.id, work);
    }
  }

  async output(id: string): Promise<PermissionRunOutput | undefined> {
    try { return JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as PermissionRunOutput; }
    catch { return undefined; }
  }

  async forget(id: string): Promise<void> { await rm(join(this.dir, `${id}.json`), { force: true }); }

  private async execute(id: string, command: string, cwd: string, timeoutSeconds: number): Promise<void> {
    const startedAt = this.now();
    // Saved before the command starts: a worker that stops from here on leaves a run whose result is unknown, never
    // one that would start again.
    await this.options.update(id, { status: 'running', startedAt });
    const stdout = new Kept();
    const stderr = new Kept();
    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], { cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      await this.options.update(id, { status: 'failed', startedAt, finishedAt: this.now(), error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const pid = child.pid;
    if (!pid) {
      const error = await new Promise<string>(resolve => child.once('error', value => resolve(value.message)));
      await this.options.update(id, { status: 'failed', startedAt, finishedAt: this.now(), error });
      return;
    }
    // Listened to at once: a quick command can be done before the waits below.
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (value, sig) => resolve({ code: value, signal: sig })));
    child.stdout!.on('data', (chunk: Buffer) => stdout.add(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.add(chunk));
    const started = await processStart(pid);
    await this.options.update(id, { status: 'running', startedAt, pid, ...(started ? { started } : {}) });
    let timedOut = false;
    const grace = this.options.killGraceMs ?? KILL_GRACE_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(pid, 'SIGTERM');
      setTimeout(() => { if (groupAlive(pid)) signalGroup(pid, 'SIGKILL'); }, grace).unref();
    }, timeoutSeconds * 1000);
    const { code, signal } = await closed;
    clearTimeout(timer);
    // The leader is done; what it left running in its group is stopped too, so a finished run leaves nothing behind.
    if (groupAlive(pid)) {
      signalGroup(pid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, Math.min(grace, 1_000)));
      if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
    }
    const output: PermissionRunOutput = { stdout: stdout.text(), stderr: stderr.text(), truncated: stdout.truncated || stderr.truncated };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writePrivateJson(join(this.dir, `${id}.json`), JSON.stringify(output));
    await this.options.update(id, {
      status: 'done', startedAt, finishedAt: this.now(), pid, ...(started ? { started } : {}),
      ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}), ...(timedOut ? { timedOut: true } : {}),
      stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes, truncated: output.truncated,
      preview: { stdout: output.stdout.slice(0, PREVIEW_CHARS), stderr: output.stderr.slice(0, PREVIEW_CHARS) },
    });
  }

  /**
   * A run a previous worker left `running`: stopped only with proof it is ours (its leader alive with the recorded start
   * time). Otherwise nothing is signalled; the result is unknown. One stopped before its process was recorded is unknown too.
   */
  async recover(run: PermissionRun): Promise<PermissionRun> {
    const finishedAt = this.now();
    if (run.pid && run.started && await processStart(run.pid) === run.started) {
      signalGroup(run.pid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, this.options.killGraceMs ?? KILL_GRACE_MS));
      if (groupAlive(run.pid) && await processStart(run.pid) === run.started) signalGroup(run.pid, 'SIGKILL');
      return { ...run, status: 'failed', finishedAt, error: 'Tower restarted while it ran; it was stopped.' };
    }
    return { ...run, status: 'failed', finishedAt, error: 'Tower restarted while it ran; its result is unknown and parts of it may still be running.' };
  }
}
