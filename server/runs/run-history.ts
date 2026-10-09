import { randomUUID } from 'node:crypto';
import type { StorageClient } from '../storage/client.js';
import { bootstrapRuns, holdRunsEvidence } from './storage-transfer.js';
import type { StorageUpdateInput } from '../link/storage-update.js';
import { RunsRepository } from './storage-repository.js';
import { canonical, rowsOf, RUN_SOURCE_BYTES, type RunDocuments, type RunRow, type RunChange } from './storage-codec.js';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Run, RunInstructions } from '../../shared/types.js';
import { nativeContextObservation } from '../sessions/context.js';
import { attachmentMetadata } from '../stores/attachments.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { parseRunOrigin } from './origin.js';
import { restorePermissionRun } from './permission-continuation.js';
import { errorMessage, FINISHED, finishedTime, MAX_OUTPUT, MAX_PROMPT, notAdmitted, RunError, RunAdmissionUncertain, admissionUncertain } from './run-records.js';
import { isSavedRun, UUID } from './saved-state.js';
import { checkedInstructions } from './turn-notes.js';

/** Finished runs kept; unfinished runs, and runs an automation still has to report, are never dropped for this. */
export const MAX_RUNS = 100;
const MAX_RETAINED = 50;
/** A retained finished run keeps what its result notice uses. */
const RETAINED_OUTPUT = 20_000;
const MAX_SAVED_BYTES = RUN_SOURCE_BYTES;
/** What builds before 1.86.0 read at most. */
const LEGACY_SAVED_BYTES = 11_500_000;
/** Marks, in runs.json, a turn still to run whose instructions (kept only in memory) it cannot go without. */
const NEEDS_INSTRUCTIONS = 'needsInstructions';
/** Marks, in runs.json, a queued turn accepted while Tower switched workers: a restart keeps it queued. */
const KEEP_QUEUED = 'keepQueued';
/** Marks, in runs.json, a finished run an automation still has to report. */
const RETAIN = 'retain';
/** A scheduled continuation Tower was not running for is still delivered this long after its time. */
const SCHEDULE_GRACE_MS = 60 * 60 * 1000;
export const SCHEDULED_OUTPUT = 'Scheduled by the agent. Tower resumes this conversation at the scheduled time.';
export const UPDATE_RESUME_WAIT = 'Tower resumes this conversation on its new version.';

/**
 * The worker's run history on disk: runs.json, the created conversations' identities and the instructions of turns
 * still to run, written in that dependency order through one queue, and what is kept of finished runs. The previous
 * build's worker writes these files before it hands off and the next one reads them, so their bytes are a contract.
 */
export class RunHistory {
  private readonly runsFile: string;
  private readonly createdFile: string;
  /** Instructions a queued turn cannot go without, kept apart from runs.json so no older Tower ever shows them. */
  private readonly instructionsFile: string;
  /** The last content each file holds. Updated only inside the write queue, after a successful write. */
  private readonly saved: { runs?: string; created?: string; instructions?: string } = {};
  private repository?: RunsRepository;
  private bootstrap?: () => Promise<void>;
  bootstrapStorage(update: () => Promise<StorageUpdateInput>): Promise<void> {
    if (!this.repository) throw new Error('Runs storage is unavailable.');
    this.bootstrap ??= bootstrapRuns(this.repository, dirname(this.runsFile), update);
    return this.bootstrap();
  }
  private database = false;
  private current?: RunDocuments;
  private rows: RunRow[] = [];
  private unknown?: RunAdmissionUncertain;
  private readonly newAdmissions = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private persistenceError?: Error;
  /** The last save of required instructions failed: a handoff would lose them, so `flushState` refuses. */
  private instructionsError?: Error;
  /** Queued runs accepted while Tower switched workers; a restart keeps them queued (see KEEP_QUEUED). */
  readonly carried = new Set<string>();
  /** Runs saved as retained: kept until the automations that know which runs they need are loaded (`markReady`). */
  readonly restoredRetained = new Set<string>();
  private retained: () => Iterable<string> = () => [];

  constructor(stateDir: string, storage?: StorageClient) {
    if (storage) this.repository = new RunsRepository(storage);
    this.runsFile = join(stateDir, 'runs.json');
    this.createdFile = join(stateDir, 'created-sessions.json');
    this.instructionsFile = join(stateDir, 'run-instructions.json');
  }

  /** Bind exactly the worker's SDK, before restoration. The repository survives its close/reopen. */
  useStorage(storage: StorageClient): void {
    if (this.repository && this.repository.storage !== storage) throw new Error('Runs already belongs to another storage owner.');
    this.repository ??= new RunsRepository(storage);
  }
  private async readDatabase(): Promise<void> {
    if (!this.repository) { await holdRunsEvidence(dirname(this.runsFile)); return; }
    this.database = await this.repository.databaseAuthority();
    if (!this.database) await holdRunsEvidence(dirname(this.runsFile));
    if (this.database && !this.current) {
      const current = await this.repository.exportCurrent();
      this.current = current.documents; this.rows = current.rows;
    }
  }
  pendingAdmission(): { commandId: string; sha256: string } | undefined { return this.unknown?.identity; }
  reservingAdmission(id: string): boolean { return this.newAdmissions.has(id); }
  async resolveAdmission(): Promise<{ disposition: 'committed' | 'not-committed'; runIds: Set<string>; newRunIds: string[]; newRuns: Map<string, Run> }> {
    if (!this.unknown || !this.repository) throw new Error('No uncertain runs admission.');
    await this.writes;
    const result = await this.repository.resolvePending();
    if (result === 'unknown') throw this.unknown;
    const current = await this.repository.exportCurrent();
    this.unknown = undefined; this.persistenceError = undefined;
    this.current = current.documents; this.rows = current.rows;
    const newRunIds = [...this.newAdmissions];
    const newRuns = new Map<string, Run>();
    for (const run of current.documents.runs) if (this.newAdmissions.has(run.id)) {
      const admitted = { ...run, ...(current.documents.instructions[run.id] ? { instructions: current.documents.instructions[run.id] } : {}) };
      for (const marker of [NEEDS_INSTRUCTIONS, KEEP_QUEUED, RETAIN]) delete (admitted as unknown as Record<string, unknown>)[marker];
      newRuns.set(run.id, admitted);
    }
    this.newAdmissions.clear();
    return { disposition: result, runIds: new Set(current.documents.runs.map(run => run.id)), newRunIds, newRuns };
  }

  /** The saved created conversations, undefined when there are none yet; `noteCreated` records what was read. */
  async readCreated(): Promise<unknown> {
    await this.readDatabase();
    if (this.database) return structuredClone(this.current!.created);
    try { return await readPrivateJson(this.createdFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Without any created session, the identities file is never created.
      this.saved.created = '[]';
      return undefined;
    }
  }
  noteCreated(content: string): void { this.saved.created = content; }

  /** Required instructions of queued turns, saved apart from runs.json. A file that cannot be read keeps none. */
  private async readInstructions(): Promise<Map<string, RunInstructions>> {
    const kept = new Map<string, RunInstructions>();
    try {
      const saved = await readPrivateJson(this.instructionsFile);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [id, value] of Object.entries(saved as Record<string, unknown>)) {
          try { if (UUID.test(id)) kept.set(id, { ...checkedInstructions(value as RunInstructions), required: true }); } catch { /* An invalid entry is left out. */ }
        }
      }
      this.saved.instructions = JSON.stringify(Object.fromEntries(kept));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Saved turn instructions were not read: ${errorMessage(error)}`);
    }
    return kept;
  }

  /** The saved runs as this worker takes them over (see restoreRuns); none when nothing was saved. */
  async restore(): Promise<Run[]> {
    await this.readDatabase();
    const kept = this.database ? new Map(Object.entries(this.current!.instructions).map(([id,value]) => [id, { ...checkedInstructions(value), required: true }])) : await this.readInstructions();
    if (this.database) {
      const restored = restoreRuns(this.current!.runs, kept);
      for (const id of restored.restoredRetained) this.restoredRetained.add(id);
      for (const id of restored.carried) this.carried.add(id);
      return restored.runs;
    }
    try {
      if ((await stat(this.runsFile)).size > MAX_SAVED_BYTES) throw new Error('Saved run history is too large.');
      const saved: unknown = JSON.parse(await readFile(this.runsFile, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('Saved run history is invalid.');
      const restored = restoreRuns(saved, kept);
      for (const id of restored.restoredRetained) this.restoredRetained.add(id);
      for (const id of restored.carried) this.carried.add(id);
      return restored.runs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
  }

  /** Runs an automation still has to report: kept through pruning and restarts. */
  setRetained(retained: () => Iterable<string>): void { this.retained = retained; }

  /** The retained runs that are still here, newest first, at most MAX_RETAINED; and the permission `receipts`. */
  retainedIds(runs: ReadonlyMap<string, Run>, receipts: readonly string[]): Set<string> {
    const ids = [...new Set([...this.restoredRetained, ...this.retained()])].map(id => runs.get(id)).filter((run): run is Run => !!run)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_RETAINED).map(run => run.id);
    return new Set([...ids, ...receipts]);
  }

  /**
   * Queues a save of all three files. `listed` is the run list as the page sees it; `runs` the live records, for the
   * instructions only they hold. Instruction text never reaches runs.json, where an older Tower could show it: a turn
   * still to run records only that it needs instructions, and after a restart it is cancelled rather than started
   * without them.
   */
  save(runs: ReadonlyMap<string, Run>, listed: readonly Run[], created: string, retained: ReadonlySet<string>): void {
    if (this.database) {
      const accepted = new Set(this.current!.runs.map(run => run.id));
      for (const run of listed) if (!accepted.has(run.id)) this.newAdmissions.add(run.id);
    }
    for (const id of this.carried) if (runs.get(id)?.status !== 'queued') this.carried.delete(id);
    const data = serializeRuns(listed, { required: id => Boolean(runs.get(id)?.instructions?.required), carried: this.carried, retained });
    // Kept only for turns still to run, in a private file older Towers do not read (see instructionsFile).
    const instructions = JSON.stringify(Object.fromEntries([...runs.values()]
      .filter(run => run.instructions?.required && !FINISHED.has(run.status)).map(run => [run.id, run.instructions])));
    const id = `runs-${randomUUID()}`;
    this.writes = this.writes.then(async () => {
      if (this.unknown) throw this.unknown;
      if (this.database) {
        const documents: RunDocuments = { runs: JSON.parse(data), created: JSON.parse(created), instructions: JSON.parse(instructions) };
        const next = rowsOf(documents), before = new Map(this.rows.map(row => [canonical([row.kind,row.id]),row]));
        const changes: RunChange[] = [];
        // R6 removal boundary: canonical row diff for the old RunHistory.save API only.
        for (const row of next) {
          const key = canonical([row.kind,row.id]), previous = before.get(key);
          if (row.json !== previous?.json) changes.push({ ...row, previous: previous?.json ?? null });
          before.delete(key);
        }
        for (const row of before.values()) changes.push({ ...row, previous: row.json, remove: true });
        try { await this.repository!.update(changes,'update',id); }
        catch (error) {
          if (admissionUncertain(error)) {
            const identity = this.repository!.lastIntent!;
            this.unknown = new RunAdmissionUncertain('Run admission has an uncertain durable result. Resolve its fixed receipt before starting or resending.', identity, this.repository!.pending()?.finalSent && (error as { disposition?: string }).disposition === 'committed' ? 'committed' : 'unknown', error);
            throw this.unknown;
          }
          throw error;
        }
        this.rows = next; this.current = documents;
        for (const run of documents.runs) this.newAdmissions.delete(run.id);
        this.saved.created = created; this.saved.instructions = instructions; this.saved.runs = data;
        this.instructionsError = undefined; this.persistenceError = undefined;
        return;
      }
      // Compare inside the queue: an earlier queued write may still change what a file holds.
      // Write identities first. A crash between commits may leave an orphaned
      // placeholder, which recovery displays as failed and never submits again.
      if (created !== this.saved.created) { await writePrivateJson(this.createdFile, created); this.saved.created = created; }
      // Instructions before the runs that name them, so a saved marker always finds its text.
      // A failure here costs only those turns' restart (they are cancelled then, as before); runs.json is still saved.
      if (instructions === (this.saved.instructions ?? '{}')) this.instructionsError = undefined;
      else {
        try { await writePrivateJson(this.instructionsFile, instructions); this.saved.instructions = instructions; this.instructionsError = undefined; }
        catch (error) { this.instructionsError = error as Error; console.error(`Turn instructions were not saved: ${errorMessage(error)}`); }
      }
      if (data !== this.saved.runs) { await writePrivateJson(this.runsFile, data); this.saved.runs = data; }
      this.persistenceError = undefined;
    }).catch((error: Error) => { this.persistenceError = error; });
  }

  /** Waits for every queued save; a failed one refuses, so nothing is acknowledged that is not on disk. */
  async flush(): Promise<void> {
    await this.writes;
    if (this.unknown) throw this.unknown;
    if (this.persistenceError) throw notAdmitted(new RunError(`Cannot save the instruction queue: ${this.persistenceError.message}`, 'unavailable'));
  }

  /** After a flush: refuses when instructions of turns still to run are not on disk, as a handoff would lose them. */
  checkInstructionsSaved(): void {
    if (this.instructionsError) throw new RunError(`Cannot save instructions of turns still to run: ${this.instructionsError.message}`, 'unavailable');
  }
}

/**
 * The saved runs as a new worker takes them over. Every unfinished run and every run an automation still has to
 * report comes back; of the rest, the newest. Nothing interrupted starts again by itself: a running turn ends as an
 * error and a queued one as cancelled, except Tower's own continuations, a scheduled one still within its grace
 * period, and one accepted while Tower switched workers (`carried`).
 */
export function restoreRuns(saved: readonly unknown[], kept: ReadonlyMap<string, RunInstructions>, now = Date.now()): { runs: Run[]; restoredRetained: string[]; carried: string[] } {
  const runs: Run[] = [], restoredRetained: string[] = [], carried: string[] = [];
  const valid = saved.slice(-1000).filter(isSavedRun);
  const marked = (value: Run, key: string) => (value as unknown as Record<string, unknown>)[key] === true;
  const finished = valid.filter(value => FINISHED.has(value.status) && !marked(value, RETAIN)).sort((a, b) => finishedTime(a) - finishedTime(b));
  const dropped = new Set(finished.slice(0, Math.max(0, finished.length - MAX_RUNS)));
  for (const value of valid) {
    if (dropped.has(value)) continue;
    const run: Run = { ...value, prompt: value.prompt.slice(0, MAX_PROMPT), output: value.output.slice(-MAX_OUTPUT),
      ...(value.attachments ? { attachments: value.attachments.map(item => attachmentMetadata(item)!) } : {}) };
    // A malformed origin never reads back as owner work.
    if (value.origin !== undefined) run.origin = parseRunOrigin(value.origin) ?? { kind: 'unknown' };
    // A permission request belongs to a live process, never a restored run.
    delete run.approvals;
    delete run.instructions;
    let needsInstructions = marked(value, NEEDS_INSTRUCTIONS);
    const keepQueued = marked(value, KEEP_QUEUED);
    if (marked(value, RETAIN)) restoredRetained.push(run.id);
    for (const key of [NEEDS_INSTRUCTIONS, KEEP_QUEUED, RETAIN]) delete (run as unknown as Record<string, unknown>)[key];
    const instructions = needsInstructions && !FINISHED.has(run.status) ? kept.get(run.id) : undefined;
    if (instructions) { run.instructions = instructions; needsInstructions = false; }
    delete run.canSteer; delete run.steerBlocked;
    delete run.backgroundWait;
    if (run.steering?.state === 'sending') run.steering.state = 'uncertain';
    const context = nativeContextObservation(run.contextUsage);
    if (context) run.contextUsage = context; else delete run.contextUsage;
    // A continuation that has not started is only a time and the agent's own prompt; it waits again, unless it needed
    // instructions, which did not survive the restart.
    if (run.status === 'queued' && run.scheduled && needsInstructions) {
      run.status = 'cancelled';
      run.error = 'Agent Session Tower restarted before this continuation, and it would have run without the instructions Tower gave its turn. It was not started; send an instruction to continue.';
      run.finishedAt = new Date().toISOString();
    } else if (restorePermissionRun(run)) { /* A permission notice or continuation (see permission-continuation.ts). */ }
    else if (run.status === 'queued' && run.scheduled?.resume === 'update') run.output = UPDATE_RESUME_WAIT;
    else if (run.status === 'queued' && run.scheduled && Date.parse(run.scheduled.at) > now - SCHEDULE_GRACE_MS) run.output = SCHEDULED_OUTPUT;
    // Accepted while Tower switched to its new version: it runs here, exactly once.
    else if (run.status === 'queued' && keepQueued && !needsInstructions) carried.push(run.id);
    else if (run.status === 'running' || run.status === 'queued') {
      const missedSchedule = run.status === 'queued' && run.scheduled;
      run.status = run.status === 'running' ? 'error' : 'cancelled';
      run.error = run.steering
        ? 'Agent Session Tower stopped before this inserted instruction finished. It was not resent. Check the conversation before sending again.'
        : missedSchedule
          ? 'Agent Session Tower was not running when this scheduled continuation was due. It was not started; send an instruction to continue.'
          : 'Agent Session Tower stopped before this task finished. It was not restarted; send the instruction again to continue.';
      run.finishedAt = new Date().toISOString();
    }
    runs.push(run);
  }
  return { runs, restoredRetained, carried };
}

/**
 * runs.json's text: live-only fields left out, the markers a restore reads added. Older builds refuse a history over
 * 12 MB, so a rollback could not start: long finished output is shortened first.
 */
export function serializeRuns(listed: readonly Run[], marks: { required(id: string): boolean; carried: ReadonlySet<string>; retained: ReadonlySet<string> }): string {
  const serialize = (finishedOutput?: number) => JSON.stringify(listed.map(({ approvals: _liveApprovals, canSteer: _liveSteering, steerBlocked: _liveBlock, ...run }) => {
    const saved: Record<string, unknown> = { ...run };
    if (finishedOutput !== undefined && FINISHED.has(run.status)) saved.output = run.output.slice(-finishedOutput);
    if (marks.required(run.id) && !FINISHED.has(run.status)) saved[NEEDS_INSTRUCTIONS] = true;
    if (marks.carried.has(run.id)) saved[KEEP_QUEUED] = true;
    if (marks.retained.has(run.id) && FINISHED.has(run.status)) { saved[RETAIN] = true; saved.output = run.output.slice(-RETAINED_OUTPUT); }
    return saved;
  }));
  const data = serialize();
  return Buffer.byteLength(data) > LEGACY_SAVED_BYTES ? serialize(2_000) : data;
}
