import { randomUUID } from 'node:crypto';
import type { StorageClient } from '../storage/client.js';
import { bootstrapRuns, holdRunsEvidence } from './storage-transfer.js';
import type { StorageUpdateInput } from '../link/storage-update.js';
import { RunsRepository } from './storage-repository.js';
import { canonical, type RunDocuments, type RunRow, type RunChange } from './storage-codec.js';
import type { Run, RunInstructions } from '../../shared/types.js';
import { nativeContextObservation } from '../sessions/context.js';
import { attachmentMetadata } from '../stores/attachments.js';
import { parseRunOrigin } from './origin.js';
import { restorePermissionRun } from './permission-continuation.js';
import { FINISHED, finishedTime, MAX_OUTPUT, MAX_PROMPT, notAdmitted, RunError, RunAdmissionUncertain, admissionUncertain } from './run-records.js';
import { isSavedRun, type CreatedSession } from './saved-state.js';
import { checkedInstructions } from './turn-notes.js';

/** Finished runs kept; unfinished runs, and runs an automation still has to report, are never dropped for this. */
export const MAX_RUNS = 100;
const MAX_RETAINED = 50;
/** A retained finished run keeps what its result notice uses. */
const RETAINED_OUTPUT = 20_000;
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
 * SQL run authority and its ordered owner operations. Historical JSON bytes are handled by the transfer/export codec.
 */
export class RunHistory {
  private readonly triggerLinks = new Map<string, import('../triggers/storage-commands.js').TriggerAdmissionLink>();
  linkTrigger(runId: string, link: import('../triggers/storage-commands.js').TriggerAdmissionLink): void {
    if (!this.database || !this.repository) throw notAdmitted(new RunError('Atomic trigger admission requires database authority.','unavailable'));
    if (this.triggerLinks.has(runId)) throw new Error('Trigger admission already reserved.');
    this.triggerLinks.set(runId,structuredClone(link));
  }
  forgetTrigger(runId: string): void { this.triggerLinks.delete(runId); }
  private repository?: RunsRepository;
  private bootstrap?: () => Promise<void>;
  bootstrapStorage(update: () => Promise<StorageUpdateInput>): Promise<void> {
    if (!this.repository) throw new Error('Runs storage is unavailable.');
    this.bootstrap ??= bootstrapRuns(this.repository, this.stateDir, update);
    return this.bootstrap();
  }
  private database = false;
  private current?: RunDocuments;
  private readonly rows = new Map<string, RunRow>();
  private readonly failedRuns = new Set<string>();
  private readonly failedCreated = new Set<string>();
  private rememberRows(rows: readonly RunRow[]): void {
    this.rows.clear();
    for (const row of rows) this.rows.set(canonical([row.kind, row.id]), row);
  }
  private unknown?: RunAdmissionUncertain;
  private readonly newAdmissions = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private persistenceError?: Error;
  /** Queued runs accepted while Tower switched workers; a restart keeps them queued (see KEEP_QUEUED). */
  readonly carried = new Set<string>();
  /** Runs saved as retained: kept until the automations that know which runs they need are loaded (`markReady`). */
  readonly restoredRetained = new Set<string>();
  private retained: () => Iterable<string> = () => [];

  constructor(private readonly stateDir: string, storage?: StorageClient) {
    if (storage) this.repository = new RunsRepository(storage);
  }

  /** Bind exactly the worker's SDK, before restoration. The repository survives its close/reopen. */
  useStorage(storage: StorageClient): void {
    if (this.repository && this.repository.storage !== storage) throw new Error('Runs already belongs to another storage owner.');
    this.repository ??= new RunsRepository(storage);
  }
  private async readDatabase(): Promise<void> {
    if (!this.repository) { await holdRunsEvidence(this.stateDir); throw new Error('Runs storage is unavailable; SQL authority is required.'); }
    this.database = await this.repository.databaseAuthority();
    if (!this.database) { await holdRunsEvidence(this.stateDir); throw new Error('Runs SQL authority is missing.'); }
    if (this.database && !this.current) {
      const current = await this.repository.exportCurrent();
      this.current = current.documents; this.rememberRows(current.rows);
    }
  }
  /** Known refusals retain their exact touched identities for the owner's next corrective operation. */
  retryRows(): { runIds: string[]; createdIds: string[] } {
    return this.unknown ? { runIds: [], createdIds: [] } : { runIds: [...this.failedRuns], createdIds: [...this.failedCreated] };
  }
  pendingAdmission(): { commandId: string; sha256: string } | undefined { return this.unknown?.identity; }
  reservingAdmission(id: string): boolean { return this.newAdmissions.has(id); }
  async resolveAdmission(): Promise<{ disposition: 'committed' | 'not-committed'; runIds: Set<string>; newRunIds: string[]; newRuns: Map<string, Run>; touchedRunIds: string[]; touchedCreatedIds: string[] }> {
    if (!this.unknown || !this.repository) throw new Error('No uncertain runs admission.');
    await this.writes;
    const result = await this.repository.resolvePending();
    if (result === 'unknown') throw this.unknown;
    const current = await this.repository.exportCurrent();
    this.unknown = undefined; this.persistenceError = undefined;
    this.current = current.documents; this.rememberRows(current.rows);
    const newRunIds = [...this.newAdmissions];
    const newRuns = new Map<string, Run>();
    for (const run of current.documents.runs) if (this.newAdmissions.has(run.id)) {
      const admitted = { ...run, ...(current.documents.instructions[run.id] ? { instructions: current.documents.instructions[run.id] } : {}) };
      for (const marker of [NEEDS_INSTRUCTIONS, KEEP_QUEUED, RETAIN]) delete (admitted as unknown as Record<string, unknown>)[marker];
      newRuns.set(run.id, admitted);
    }
    this.newAdmissions.clear();
    for (const id of newRunIds) this.triggerLinks.delete(id);
    const touchedRunIds = [...this.failedRuns], touchedCreatedIds = [...this.failedCreated];
    this.failedRuns.clear(); this.failedCreated.clear();
    return { disposition: result, runIds: new Set(current.documents.runs.map(run => run.id)), newRunIds, newRuns, touchedRunIds, touchedCreatedIds };
  }

  /** Runtime reads only the imported SQL authority; JSON belongs to transfer/export. */
  async readCreated(): Promise<unknown> {
    await this.readDatabase();
    return structuredClone(this.current!.created);
  }

  async restore(): Promise<Run[]> {
    await this.readDatabase();
    const kept = new Map(Object.entries(this.current!.instructions).map(([id, value]) => [id, { ...checkedInstructions(value), required: true }]));
    const restored = restoreRuns(this.current!.runs, kept);
    for (const id of restored.restoredRetained) this.restoredRetained.add(id);
    for (const id of restored.carried) this.carried.add(id);
    return restored.runs;
  }
  /** Startup reconciliation includes rows dropped by restore's bounded pruning. */
  storedRunIds(): string[] { return [...new Set([...this.current!.runs.map(run => run.id), ...Object.keys(this.current!.instructions)])]; }

  /** Runs an automation still has to report: kept through pruning and restarts. */
  setRetained(retained: () => Iterable<string>): void { this.retained = retained; }

  /** The retained runs that are still here, newest first, at most MAX_RETAINED; and the permission `receipts`. */
  retainedIds(runs: ReadonlyMap<string, Run>, receipts: readonly string[]): Set<string> {
    const ids = [...new Set([...this.restoredRetained, ...this.retained()])].map(id => runs.get(id)).filter((run): run is Run => !!run)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_RETAINED).map(run => run.id);
    return new Set([...ids, ...receipts]);
  }

  /** One owner operation: snapshot only its touched rows before joining the ordered write queue. */
  saveRows(input: { runs: readonly Run[]; deleted: readonly string[]; created: readonly CreatedSession[];
    deletedCreated: readonly string[]; retained: ReadonlySet<string> }): void {
    if (!this.database || !this.repository) throw notAdmitted(new RunError('Runs SQL authority is required.', 'unavailable'));
    if (!input.runs.length && !input.deleted.length && !input.created.length && !input.deletedCreated.length) return;
    const snapshots: RunRow[] = [], removals: { kind: RunRow['kind']; id: string }[] = [];
    for (const run of input.runs) {
      if (run.status !== 'queued') this.carried.delete(run.id);
      if (!this.rows.has(canonical(['run', run.id]))) this.newAdmissions.add(run.id);
      snapshots.push({ kind: 'run', id: run.id, json: canonical(savedRun(run, {
        required: Boolean(run.instructions?.required), carried: this.carried.has(run.id), retained: input.retained.has(run.id),
      })) });
      if (run.instructions?.required && !FINISHED.has(run.status)) snapshots.push({ kind: 'instruction', id: run.id, json: canonical(run.instructions) });
      else removals.push({ kind: 'instruction', id: run.id });
    }
    for (const value of input.created) snapshots.push({ kind: 'created', id: value.session.id, json: canonical(value) });
    for (const id of input.deleted) { removals.push({ kind: 'run', id }, { kind: 'instruction', id }); this.carried.delete(id); }
    for (const id of input.deletedCreated) removals.push({ kind: 'created', id });
    const touchedRuns = [...input.runs.map(run => run.id), ...input.deleted];
    const touchedCreated = [...input.created.map(value => value.session.id), ...input.deletedCreated];
    this.writes = this.writes.then(async () => {
      if (this.unknown) throw this.unknown;
      const id = `runs-${randomUUID()}`;
      const changes: RunChange[] = [];
      for (const row of snapshots) {
        const previous = this.rows.get(canonical([row.kind, row.id]));
        // Compare only the explicitly touched identity; never enumerate history to discover mutations.
        if (row.json !== previous?.json) changes.push({ ...row, previous: previous?.json ?? null });
      }
      for (const key of removals) {
        const previous = this.rows.get(canonical([key.kind, key.id]));
        if (previous) changes.push({ ...previous, previous: previous.json, remove: true });
      }
      const triggerLinks = changes.filter(row => row.kind === 'run' && row.previous === null && !row.remove)
        .flatMap(row => { const link = this.triggerLinks.get(row.id); return link ? [link] : []; });
      try { await this.repository!.update(changes, 'update', id, triggerLinks.length ? triggerLinks : undefined); }
      catch (error) {
        if (admissionUncertain(error)) {
          this.unknown = new RunAdmissionUncertain('Run admission has an uncertain durable result. Resolve its fixed receipt before starting or resending.',
            this.repository!.lastIntent!, this.repository!.pending()?.finalSent && (error as { disposition?: string }).disposition === 'committed' ? 'committed' : 'unknown', error);
          throw this.unknown;
        }
        throw error;
      }
      for (const row of changes) {
        const key = canonical([row.kind, row.id]);
        if (row.remove) this.rows.delete(key); else this.rows.set(key, { kind: row.kind, id: row.id, json: row.json });
      }
      for (const runId of touchedRuns) { this.newAdmissions.delete(runId); this.triggerLinks.delete(runId); }
      this.current = undefined;
      for (const runId of touchedRuns) this.failedRuns.delete(runId);
      for (const createdId of touchedCreated) this.failedCreated.delete(createdId);
      if (!this.failedRuns.size && !this.failedCreated.size) this.persistenceError = undefined;
    }).catch((error: Error) => {
      for (const runId of touchedRuns) this.failedRuns.add(runId);
      for (const createdId of touchedCreated) this.failedCreated.add(createdId);
      this.persistenceError = error;
    });
  }

  /** Waits for every queued save; a failed one refuses, so nothing is acknowledged that is not on disk. */
  async flush(): Promise<void> {
    await this.writes;
    if (this.unknown) throw this.unknown;
    if (this.persistenceError) throw notAdmitted(new RunError(`Cannot save the instruction queue: ${this.persistenceError.message}`, 'unavailable'));
  }

  /** After a flush: refuses when instructions of turns still to run are not on disk, as a handoff would lose them. */
  checkInstructionsSaved(): void {
    if (this.unknown) throw this.unknown;
    if (this.persistenceError) throw new RunError(`Cannot save instructions of turns still to run: ${this.persistenceError.message}`, 'unavailable');
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
/** SQL row projection; historical size limiting is exclusively the export codec below. */
export function savedRun(run: Run, marks: { required: boolean; carried: boolean; retained: boolean }, finishedOutput?: number): Record<string, unknown> {
  const { approvals: _approvals, canSteer: _canSteer, steerBlocked: _steerBlocked, instructions: _instructions, ...saved } = run;
  const value: Record<string, unknown> = { ...saved };
  if (finishedOutput !== undefined && FINISHED.has(run.status)) value.output = run.output.slice(-finishedOutput);
  if (marks.required && !FINISHED.has(run.status)) value[NEEDS_INSTRUCTIONS] = true;
  if (marks.carried) value[KEEP_QUEUED] = true;
  if (marks.retained && FINISHED.has(run.status)) { value[RETAIN] = true; value.output = run.output.slice(-RETAINED_OUTPUT); }
  return value;
}

export function serializeRuns(listed: readonly Run[], marks: { required(id: string): boolean; carried: ReadonlySet<string>; retained: ReadonlySet<string> }): string {
  const serialize = (finishedOutput?: number) => JSON.stringify(listed.map(run => savedRun(run, {
    required: marks.required(run.id), carried: marks.carried.has(run.id), retained: marks.retained.has(run.id),
  }, finishedOutput)));
  const data = serialize();
  return Buffer.byteLength(data) > LEGACY_SAVED_BYTES ? serialize(2_000) : data;
}
