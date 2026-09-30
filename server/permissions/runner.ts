import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { providerDirectories } from '../providers/discovery.js';
import { promisify } from 'node:util';
import type { PermissionRun, PermissionRunOutput } from '../../shared/permissions.js';
import { writePrivateJson } from '../stores/private-json.js';

const exec = promisify(execFile);
/** Each stream keeps its first and last part. */
const KEEP_BYTES = 64 * 1024;
const PREVIEW_CHARS = 1_000;
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
        .finally(() => { this.running.delete(item.id); this.groups.delete(item.id); this.pump(); });
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
    try { await this.retry(() => this.options.update(id, { status: 'running', startedAt })); } catch (error) {
      // Not started: said so, if that can be saved at all.
      await this.options.update(id, { status: 'failed', startedAt, finishedAt: this.now(), error: `Tower could not record the start: ${error instanceof Error ? error.message : String(error)}` }).catch(() => {});
      return;
    }
    const stdout = new Kept();
    const stderr = new Kept();
    let child;
    try {
      // The same search path an agent's turn has, so a command it could name (gh, npm, …) is found here too.
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: providerDirectories(process.env).join(delimiter) };
      delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_THREAD_ID;
      child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (value, sig) => resolve({ code: value, signal: sig })));
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stdout!.on('data', (chunk: Buffer) => stdout.add(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.add(chunk));
    // The time limit holds from the start, whatever happens to the saves below.
    let timedOut = false;
    const grace = this.options.killGraceMs ?? KILL_GRACE_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(pid, 'SIGTERM');
      setTimeout(() => { if (groupAlive(pid)) signalGroup(pid, 'SIGKILL'); }, grace).unref();
    }, timeoutSeconds * 1000);
    const started = await processStart(pid);
    // A failed save leaves the run `running` without its process: after a restart it is unknown, never started again.
    await this.options.update(id, { status: 'running', startedAt, pid, ...(started ? { started } : {}) })
      .catch(error => console.error(`A permission run's process could not be saved: ${error instanceof Error ? error.message : String(error)}`));
    const { code, signal } = await exited;
    clearTimeout(timer);
    // The leader is done; what it left running in its group is stopped too, so a finished run leaves nothing behind
    // (and a child holding the output open does not keep the run going).
    if (groupAlive(pid)) {
      signalGroup(pid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, Math.min(grace, 1_000)));
      if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
    }
    // The rest of the output, once the group is gone; a stray holder of the pipes is not waited for long.
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2_000))]);
    const output: PermissionRunOutput = { stdout: stdout.text(), stderr: stderr.text(), truncated: stdout.truncated || stderr.truncated };
    const saved = await mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => writePrivateJson(join(this.dir, `${id}.json`), JSON.stringify(output)))
      .then(() => undefined, (error: unknown) => error instanceof Error ? error.message : String(error));
    const finished = (): Promise<void> => this.options.update(id, { ...(saved ? { error: `The command finished, but its output could not be kept: ${saved}` } : {}),
      status: 'done', startedAt, finishedAt: this.now(), pid, ...(started ? { started } : {}),
      ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}), ...(timedOut ? { timedOut: true } : {}),
      stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes, truncated: output.truncated,
      preview: { stdout: output.stdout.slice(0, PREVIEW_CHARS), stderr: output.stderr.slice(0, PREVIEW_CHARS) },
    });
    // The result is saved even when a write fails for a moment; otherwise the run would look unfinished for good.
    await this.retry(finished);
  }

  private async retry(save: () => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try { await save(); return; } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 1_000 * attempt));
      }
    }
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
      // A group keeps its id while any member lives (the id is not reused meanwhile), so what is left of it is still ours.
      if (groupAlive(run.pid)) signalGroup(run.pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 200));
      if (!groupAlive(run.pid)) return { ...run, status: 'failed', finishedAt: this.now(), error: 'Tower restarted while it ran; it was stopped.' };
    }
    return { ...run, status: 'failed', finishedAt, error: 'Tower restarted while it ran; its result is unknown and parts of it may still be running.' };
  }
}
