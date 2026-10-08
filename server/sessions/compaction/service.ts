/**
 * Compaction of a conversation on the owner's request (the chat's compact button). The worker owns it, so a web restart
 * never cuts one short and a worker handoff waits for it: it reads the conversation's own history, every page and never
 * its sub-sessions, has the `sessions.compactor` model summarize it without tools, and starts one new session of the same
 * provider, folder, model and effort whose first message carries the summary as Tower's hidden instructions. The
 * original conversation and its records are never changed, stopped or closed.
 *
 * One compaction of what a conversation says creates at most one session: the attempt is recorded before the session is
 * created and its result right after, so a retry (after a lost answer, a worker handoff or a crash) gets the same session.
 * A compacted session's own summary is read back from its first message (parseMessages' full read), so compacting it
 * again carries everything on without a copy kept here.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChatMessage, CreateSessionRequest, Run, Session, SessionCompaction } from '../../../shared/types.js';
import { COMPACTION_ACTIVE, REFUSAL_MESSAGES, compactionRefusal } from '../../../shared/compaction.js';
import { TowerError } from '../../../shared/errors.js';
import type { ResolvedModel } from '../../../shared/models.js';
import type { AutoPromptModelRequest } from '../../auto-prompt/native.js';
import { resolveModel } from '../../models/settings.js';
import { CLAUDE_EFFORT_LEVELS, validEffort, validModelId } from '../../providers/models.js';
import type { RunAdmission } from '../../runs/manager.js';
import { readPrivateJson, writePrivateJson } from '../../stores/private-json.js';
import { outcomeMark } from '../outcomes.js';
import { MERGE_SYSTEM, NOTES_SYSTEM, SUMMARY_SCHEMA, SUMMARY_SYSTEM, parseSummary, renderSummary, startInstructions, visiblePrompt, type CompactionSummary } from './summary.js';
import { PART_BYTES, packParts, transcriptLines } from './transcript.js';

const FILE = 'session-compactions.json';
const PAGE = 200;
/** Past these the conversation is too large to compact; its start is never dropped to make it fit. */
const MAX_MESSAGES = 50_000;
const MAX_PARTS = 80;
/** One model call; the whole call, a wait for a CLI update included, gives up a minute later. */
const CALL_MS = 5 * 60_000;
const CALL_LIMIT_MS = CALL_MS + 60_000;
/** A whole compaction: a little for reading and creating, plus a minute per part; never more than 90 minutes. */
const jobMs = (parts: number) => Math.min(90, 10 + parts) * 60_000;
const CONCURRENT_CALLS = 2;
const ACTIVE_JOBS = 2;
const KEPT_JOBS = 200;
/** What the file may grow to: what `load` reads back. Its records are small, so this is far off. */
const FILE_BYTES = 64_000_000;

export interface SessionCompactionDependencies {
  stateDir: string;
  /** The conversation by Tower or native ID, resolved as every request about it is. */
  session(id: string): Session | undefined;
  runs(): readonly Run[];
  /** A page of the conversation's own history in the full read (see parseMessages), oldest first: the latest, or the one before `before`. */
  history(session: Session, before: number | undefined, limit: number): Promise<{ messages: readonly ChatMessage[]; hasMore: boolean; nextBefore?: number; skipped?: number } | undefined>;
  model(request: AutoPromptModelRequest, options: { timeoutMs: number }): Promise<unknown>;
  create(input: CreateSessionRequest, admission: RunAdmission): Promise<{ session: Session }>;
  /** Why this conversation cannot be continued in another session (a Slack or GitHub coordinator), if so. */
  refuse?(session: Session): string | undefined;
  /** The conversation holds outside content (Slack, GitHub, HTTP), which its continuation must stay marked for. */
  untrusted?(session: Session): boolean;
  /**
   * What this computer shares with controllers: read again (the conversation's folders and its parents') before a
   * controller's compaction creates anything; `visible` is the sharing rule every controller request follows.
   */
  remote?: { prepare(session: Session): Promise<void>; visible(session: Session): boolean };
  now?(): number;
  /** For tests: the file size past which a new attempt is refused. */
  maxFileBytes?: number;
}

type Continuation = NonNullable<SessionCompaction['continuation']>;
/** Why a compaction was stopped from outside: the owner cancelled it, the worker closed or is updating, or it ran out of time. */
type Stop = 'cancelled' | 'closed' | 'held' | 'timeout';
interface Entry { job: SessionCompaction; revision: string; controller: AbortController; running?: Promise<void> }
/**
 * One record per compacted conversation: its last compaction that began creating a session. `prompt` names the
 * compaction, so the turn that creates the session is recognized by it alone.
 */
interface Attempt { jobId: string; revision: string; at: string; state: 'creating' | 'done'; newSessionId?: string; prompt: string }

const UNCERTAIN = '이전 압축이 새 세션을 만들었는지 확인할 수 없어(실행 워커가 중간에 멈춤) 다시 만들지 않았습니다. 세션 목록에서 「(이어서)」 세션을 확인하세요. 원래 세션에서 대화가 더 이어지면 다시 압축할 수 있습니다.';
const active = (entry: Entry | undefined) => !!entry && COMPACTION_ACTIVE.has(entry.job.state);
/** What a conversation has said so far; a change while it is summarized means the summary is already behind. */
const revision = outcomeMark;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const SUFFIX = ' (이어서)';

/** The new session's title: the original's, marked as its continuation once. */
export function continuedTitle(title: string): string {
  const base = title.replace(/\s+/g, ' ').trim().replace(/ \(이어서\)$/, '') || '이전 세션';
  return `${clip(base, 120 - SUFFIX.length)}${SUFFIX}`;
}

/**
 * The model and effort the conversation's latest answer actually ran with: the native record first, then Tower's latest
 * turn for it while that turn is the conversation's latest (it completed after the last request the record shows),
 * else the CLI's own default (unset). A context variant the request named (`claude-opus-5-5[1m]`) is kept. Tower's
 * defaults for new chats never apply here.
 */
export function continuationModel(session: Session, runs: readonly Run[]): Continuation {
  // Only a turn that ran to its end answered: a cancelled or failed request says nothing about what ran.
  const last = runs.filter(run => run.sessionId === session.id && run.status === 'completed').reduce<Run | undefined>((latest, run) => !latest || run.createdAt > latest.createdAt ? run : latest, undefined);
  const current = last?.finishedAt && (!session.lastRequestAt || last.finishedAt >= session.lastRequestAt) ? last : undefined;
  const effortOk = (value: unknown): value is string => validEffort(value) && (session.provider !== 'claude' || CLAUDE_EFFORT_LEVELS.includes(value));
  const observed = validModelId(session.model) ? session.model : undefined;
  const model = observed && validModelId(current?.model) && current.model.startsWith(`${observed}[`) ? { model: current.model, modelSource: 'lastRun' as const }
    : observed ? { model: observed, modelSource: 'observed' as const }
    : validModelId(current?.model) ? { model: current.model, modelSource: 'lastRun' as const } : { modelSource: 'default' as const };
  const effort = effortOk(session.effort) ? { effort: session.effort, effortSource: 'observed' as const }
    : effortOk(current?.effort) ? { effort: current.effort, effortSource: 'lastRun' as const } : { effortSource: 'default' as const };
  return { provider: session.provider, ...model, ...effort };
}

/** Why the conversation cannot be compacted now, or undefined. */
function blocked(session: Session, runs: readonly Run[]): string | undefined {
  const refusal = compactionRefusal(session, runs);
  return refusal && REFUSAL_MESSAGES[refusal];
}

/** A compaction known only from its saved attempt (an earlier worker ran it). */
function savedJob(sessionId: string, attempt: Attempt): SessionCompaction {
  const base = { id: attempt.jobId, sessionId, createdAt: attempt.at, updatedAt: attempt.at };
  return attempt.state === 'done' ? { ...base, state: 'done', ...(attempt.newSessionId ? { newSessionId: attempt.newSessionId } : {}) } : { ...base, state: 'failed', error: UNCERTAIN };
}

export class SessionCompactions {
  private readonly path: string;
  /** The latest compaction of each conversation this worker ran, by its Tower ID. */
  private readonly jobs = new Map<string, Entry>();
  /** By the compacted conversation's Tower ID. */
  private readonly attempts = new Map<string, Attempt>();
  private persist = true;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  /** A forced update is waiting for work to wrap up: nothing new starts. */
  private held = false;

  constructor(private readonly dependencies: SessionCompactionDependencies) {
    this.path = join(dependencies.stateDir, FILE);
  }

  private now(): number { return this.dependencies.now?.() ?? Date.now(); }

  /**
   * Reads the attempts and settles any a crash left `creating`, once, before anything asks: `runs.create` saves the
   * turn that names the compaction before it answers, so that turn found means the session exists. Without it the
   * attempt stays unsettled, and no second session is made for what the conversation says then. Runs are loaded first.
   */
  async load(): Promise<void> {
    let saved: unknown;
    try { saved = await readPrivateJson(this.path, FILE_BYTES); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Never written over, so nothing in it is lost; without it a retry cannot be matched to an earlier compaction, so
      // compacting waits until the file can be read.
      this.persist = false;
      console.error(`Session compactions could not be read; compacting is unavailable until it can be: ${message(error)}`);
      return;
    }
    const sources = record(saved) && record(saved.sources) ? saved.sources : {};
    for (const [id, value] of Object.entries(sources)) {
      if (record(value) && typeof value.jobId === 'string' && typeof value.revision === 'string' && typeof value.at === 'string' && (value.state === 'creating' || value.state === 'done')
        && typeof value.prompt === 'string' && (value.newSessionId === undefined || typeof value.newSessionId === 'string')) {
        this.attempts.set(id, { jobId: value.jobId, revision: value.revision, at: value.at, state: value.state, prompt: value.prompt, ...(value.newSessionId ? { newSessionId: value.newSessionId } : {}) });
      }
    }
    let settled = false;
    for (const id of this.attempts.keys()) if (this.attempts.get(id)!.state === 'creating' && this.settle(id)) settled = true;
    if (settled) await this.save();
  }

  /** A compaction is reading, summarizing or creating: an ordinary worker handoff waits for it. */
  inFlight(): boolean { return [...this.jobs.values()].some(active); }
  /** A compaction is creating its session this instant: even a forced update waits for that, never longer. */
  creating(): boolean { return [...this.jobs.values()].some(entry => entry.job.state === 'creating'); }
  /**
   * A forced update is draining: nothing new starts, and a compaction still reading or summarizing stops now, so none
   * can begin creating a session while the worker hands off. One already creating is waited for (`creating`).
   */
  hold(): void {
    this.held = true;
    for (const entry of this.jobs.values()) if (active(entry) && entry.job.state !== 'creating') entry.controller.abort('held' satisfies Stop);
  }
  release(): void { this.held = false; }
  flush(): Promise<void> { return this.writes; }

  /** The conversation's latest compaction: one this worker ran, else the last one that began creating a session. */
  get(sessionId: string): SessionCompaction | undefined {
    const id = this.dependencies.session(sessionId)?.id ?? sessionId;
    const entry = this.jobs.get(id);
    const job = entry ? structuredClone(entry.job) : this.attempts.has(id) ? savedJob(id, this.attempts.get(id)!) : undefined;
    // A finished compaction whose session can no longer carry the work is not offered as the way on.
    return job?.state === 'done' && !this.usable(job.newSessionId) ? undefined : job;
  }

  /**
   * Starts compacting, or answers with the compaction that already covers this request: one running for the
   * conversation, or a finished one for exactly what the conversation says now whose session is still there to use.
   */
  start(sessionId: string, options: { title?: string }, admission: RunAdmission): SessionCompaction {
    const refuse = (text: string) => new TowerError('unavailable', text, { disposition: 'not-admitted' });
    if (this.closed) throw refuse('Tower가 실행 워커를 바꾸는 중입니다. 잠시 후 다시 시도하세요.');
    if (this.held) throw refuse('Tower가 실행 워커 업데이트를 준비하고 있어 지금은 압축을 시작하지 않습니다. 업데이트가 끝난 뒤 다시 시도하세요.');
    if (!this.persist) throw refuse('압축 기록 파일(session-compactions.json)을 읽지 못해 압축할 수 없습니다. 같은 압축이 두 번 만들어지지 않도록, 파일을 고친 뒤 Tower 실행 워커가 다시 시작되면 압축할 수 있습니다.');
    const session = this.dependencies.session(sessionId);
    if (!session) throw new TowerError('not-found', '세션을 찾을 수 없습니다.');
    const now = revision(session);
    const kept = this.jobs.get(session.id);
    if (active(kept) || (kept?.job.state === 'done' && kept.revision === now && this.usable(kept.job.newSessionId))) return structuredClone(kept!.job);
    const attempt = this.attempts.get(session.id);
    if (attempt?.revision === now) {
      if (attempt.state === 'creating') throw new TowerError('conflict', UNCERTAIN, { disposition: 'not-admitted' });
      if (this.usable(attempt.newSessionId)) return savedJob(session.id, attempt);
    }
    const problem = blocked(session, this.dependencies.runs()) ?? this.dependencies.refuse?.(session);
    if (problem) throw new TowerError('conflict', problem);
    if ([...this.jobs.values()].filter(active).length >= ACTIVE_JOBS) throw new TowerError('rate-limited', '다른 세션을 압축하고 있습니다. 끝난 뒤 다시 시도하세요.');
    const at = new Date(this.now()).toISOString();
    const entry: Entry = { job: { id: randomUUID(), sessionId: session.id, state: 'reading', createdAt: at, updatedAt: at }, revision: now, controller: new AbortController() };
    this.jobs.delete(session.id);
    this.jobs.set(session.id, entry);
    for (const [id, old] of this.jobs) { if (this.jobs.size <= KEPT_JOBS) break; if (!active(old)) this.jobs.delete(id); }
    const title = options.title?.trim() || session.customTitle || session.title;
    entry.running = this.run(entry, session, title, admission);
    return structuredClone(entry.job);
  }

  /** Stops a compaction that has not begun creating the new session; nothing is created. */
  cancel(sessionId: string): SessionCompaction {
    const id = this.dependencies.session(sessionId)?.id ?? sessionId;
    const entry = this.jobs.get(id);
    if (!entry) throw new TowerError('not-found', '진행 중인 압축이 없습니다.');
    if (entry.job.state === 'creating') throw new TowerError('conflict', '새 세션을 만드는 중이라 취소할 수 없습니다.');
    if (active(entry)) { entry.controller.abort('cancelled' satisfies Stop); this.update(entry, { state: 'cancelled', progress: undefined }); }
    return structuredClone(entry.job);
  }

  /** Ends compactions underway (the worker is closing): one still reading or summarizing stops, nothing half-made is created. */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.jobs.values()) if (active(entry) && entry.job.state !== 'creating') entry.controller.abort('closed' satisfies Stop);
    // `run` settles every compaction itself and never rejects.
    await Promise.all([...this.jobs.values()].map(entry => entry.running));
    await this.writes;
  }

  /** A session made by a compaction that can still carry the work: one gone, or whose start failed for good, cannot. */
  private usable(id: string | undefined): boolean {
    const session = id ? this.dependencies.session(id) : undefined;
    return !!session && (session.resumable || !!session.creationPending);
  }

  /**
   * Settles the conversation's `creating` attempt by the turn that names it: found, the session exists and the attempt
   * is done; `dropMissing` (this worker's own creation just failed, so nothing else can still make it) forgets one
   * whose turn is not there. Answers whether the attempt changed.
   */
  private settle(sourceId: string, dropMissing = false): boolean {
    const attempt = this.attempts.get(sourceId);
    if (attempt?.state !== 'creating') return false;
    const run = this.dependencies.runs().find(item => item.prompt === attempt.prompt);
    if (run) { this.attempts.set(sourceId, { ...attempt, state: 'done', newSessionId: this.dependencies.session(run.sessionId)?.id ?? run.sessionId }); return true; }
    if (dropMissing) { this.attempts.delete(sourceId); return true; }
    return false;
  }

  private update(entry: Entry, patch: Partial<SessionCompaction>): void {
    // A cancelled or finished compaction keeps its end.
    if (!active(entry)) return;
    Object.assign(entry.job, patch, { updatedAt: new Date(this.now()).toISOString() });
    for (const key of Object.keys(patch) as (keyof SessionCompaction)[]) if (patch[key] === undefined) delete entry.job[key];
  }

  /** Why the new session must not be created now, looked at again right before it is. */
  private lastLook(sourceId: string, expected: string, admission: RunAdmission): string | undefined {
    const latest = this.dependencies.session(sourceId);
    if (!latest) return '원래 세션을 찾을 수 없어 새 세션을 만들지 않았습니다.';
    const problem = blocked(latest, this.dependencies.runs()) ?? this.dependencies.refuse?.(latest);
    if (problem) return problem;
    if (revision(latest) !== expected) return '압축하는 동안 원래 세션에 새 대화가 생겨 새 세션을 만들지 않았습니다. 다시 압축하세요.';
    if (admission.origin?.controllerId && (!this.dependencies.remote || !this.dependencies.remote.visible(latest))) return '이 폴더는 이제 공유되지 않아 새 세션을 만들지 않았습니다.';
    return undefined;
  }

  private async run(entry: Entry, source: Session, title: string, admission: RunAdmission): Promise<void> {
    const signal = entry.controller.signal;
    const limit = (ms: number) => { const next = setTimeout(() => entry.controller.abort('timeout' satisfies Stop), ms); next.unref?.(); return next; };
    // Until the parts are counted, the limit of a conversation that fits one call.
    let timer = limit(jobMs(1));
    let recorded = false;
    try {
      const read = await this.read(source, signal);
      const compactor = await resolveModel(this.dependencies.stateDir, 'sessions.compactor');
      this.update(entry, { compactor: { provider: compactor.provider, ...(compactor.model ? { model: compactor.model } : {}), ...(compactor.effort ? { effort: compactor.effort } : {}) } });
      const parts = packParts(read.lines);
      if (!parts.length) throw new Error('압축할 대화 내용이 없습니다.');
      if (parts.length > MAX_PARTS) throw new Error('대화가 너무 길어 압축할 수 없습니다. 앞부분을 버리지 않고는 정해진 호출 수 안에 읽을 수 없습니다.');
      clearTimeout(timer);
      timer = limit(jobMs(parts.length) - (this.now() - Date.parse(entry.job.createdAt)));
      this.update(entry, { state: 'summarizing', progress: { done: 0, total: parts.length > 1 ? parts.length + 1 : 1 } });
      const header = [`Conversation "${clip(title, 200)}" in ${source.cwd} (${source.provider === 'claude' ? 'Claude Code' : 'Codex'}).`,
        ...(read.skipped ? [`${read.skipped} records of it could not be read and are missing below.`] : [])].join(' ');
      const summary = renderSummary(await this.summarize(entry, compactor, header, parts));
      signal.throwIfAborted();
      const early = this.lastLook(source.id, entry.revision, admission);
      if (early) throw new Error(early);
      // Nothing waits from here to `creating`: a hold or a close that came first has stopped the compaction.
      if (this.held || this.closed) throw new Error('압축이 중단되었습니다.');
      const latest = this.dependencies.session(source.id)!;
      const continuation = continuationModel(latest, this.dependencies.runs());
      const prompt = visiblePrompt(title, entry.job.id);
      // Creating is never stopped midway: neither the time limit nor a cancel applies from here.
      clearTimeout(timer);
      this.update(entry, { state: 'creating', continuation, progress: undefined });
      // Recorded before the session exists, so no retry can make a second one (see `settle`).
      this.attempts.delete(source.id);
      this.attempts.set(source.id, { jobId: entry.job.id, revision: entry.revision, at: new Date(this.now()).toISOString(), state: 'creating', prompt });
      recorded = true;
      await this.save(true);
      const created = await this.dependencies.create({
        provider: latest.provider, cwd: latest.cwd, prompt, title: continuedTitle(title),
        ...(continuation.model ? { model: continuation.model } : {}), ...(continuation.effort ? { effort: continuation.effort } : {}),
      }, { ...admission, instructions: { text: startInstructions({ title, id: latest.id }, summary), required: true }, createFolder: false,
        ...(this.dependencies.untrusted?.(latest) ? { untrustedInput: true } : {}),
        // A controller's sharing is read again as the very last wait before `validate` judges it.
        ...(admission.origin?.controllerId && this.dependencies.remote ? { refresh: () => this.dependencies.remote!.prepare(latest) } : {}),
        // Runs right before the session is registered, after every wait in creating it.
        validate: () => {
          admission.validate?.();
          const problem = this.lastLook(source.id, entry.revision, admission);
          if (problem) throw new TowerError('conflict', problem);
        } });
      this.attempts.set(source.id, { ...this.attempts.get(source.id)!, state: 'done', newSessionId: created.session.id });
      await this.save();
      this.update(entry, { state: 'done', newSessionId: created.session.id });
    } catch (error) {
      const stop = signal.aborted ? signal.reason as Stop : undefined;
      // A part still being summarized beside the one that failed is not needed any more.
      entry.controller.abort();
      if (stop === 'cancelled') return;
      // A creation that failed after saving its session still made it: that session is the compaction's result.
      if (recorded) {
        this.settle(source.id, true);
        await this.save();
        const made = this.attempts.get(source.id);
        // One that cannot carry the work (its first turn failed) is no result; a new compaction may replace it.
        if (made?.state === 'done' && made.newSessionId && this.usable(made.newSessionId)) { this.update(entry, { state: 'done', newSessionId: made.newSessionId }); return; }
      }
      const reason = stop === 'closed' ? 'Tower 실행 워커가 바뀌어 압축을 멈췄습니다. 새 세션은 만들지 않았습니다. 다시 시도하세요.'
        : stop === 'held' ? 'Tower 실행 워커 업데이트로 압축을 멈췄습니다. 새 세션은 만들지 않았습니다. 업데이트가 끝난 뒤 다시 시도하세요.'
        : stop === 'timeout' ? '압축이 제한 시간 안에 끝나지 않아 중단했습니다. 새 세션은 만들지 않았습니다.' : message(error);
      this.update(entry, { state: 'failed', error: reason, progress: undefined });
    } finally { clearTimeout(timer); }
  }

  /**
   * Every page of the conversation's own history as transcript lines, oldest first. Each page becomes lines as it is
   * read (tool output already excerpted), and reading stops as soon as the lines outgrow what the calls may take.
   */
  private async read(session: Session, signal: AbortSignal): Promise<{ lines: string[]; skipped: number }> {
    const pages: string[][] = [];
    let count = 0;
    let bytes = 0;
    let skipped = 0;
    let before: number | undefined;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.dependencies.history(session, before, PAGE);
      if (!page) throw new Error('대화 기록을 읽지 못했습니다. 원본 기록이 이동되었을 수 있습니다.');
      const lines = page.messages.flatMap(transcriptLines);
      pages.unshift(lines);
      count += page.messages.length;
      for (const line of lines) bytes += Buffer.byteLength(line) + 2;
      skipped += page.skipped ?? 0;
      if (count > MAX_MESSAGES || bytes > MAX_PARTS * PART_BYTES) throw new Error('대화가 너무 길어 압축할 수 없습니다. 앞부분을 버리지 않고는 정해진 호출 수 안에 읽을 수 없습니다.');
      if (!page.hasMore || page.nextBefore === undefined) break;
      // Each page must lie before the last one, or the reading would never end.
      if (before !== undefined && page.nextBefore >= before) throw new Error('대화 기록을 끝까지 읽지 못했습니다.');
      before = page.nextBefore;
    }
    return { lines: pages.flat(), skipped };
  }

  /**
   * One call when the conversation fits; otherwise notes per part, then merges of the notes in order until one call
   * holds them all. Later parts win where they disagree.
   */
  private async summarize(entry: Entry, compactor: ResolvedModel, header: string, parts: string[]): Promise<CompactionSummary> {
    if (parts.length === 1) return this.call(entry, compactor, SUMMARY_SYSTEM, [header, `The conversation, oldest first:\n${parts[0]}`]);
    const notes = await inOrder(parts, (part, index) => this.call(entry, compactor, NOTES_SYSTEM, [header, `Part ${index + 1} of ${parts.length}, oldest first:\n${part}`]));
    let texts = notes.map((note, index) => `Notes from part ${index + 1} of ${parts.length}:\n${renderSummary(note)}`);
    for (;;) {
      const groups = byBudget(texts, PART_BYTES);
      if (groups.length === 1) return this.call(entry, compactor, MERGE_SYSTEM, [header, groups[0].join('\n\n')]);
      if (groups.length === texts.length) throw new Error('요약이 너무 길어 하나로 합칠 수 없습니다.');
      this.update(entry, { progress: { done: entry.job.progress?.done ?? 0, total: (entry.job.progress?.total ?? 0) + groups.length } });
      const merged = await inOrder(groups, group => this.call(entry, compactor, MERGE_SYSTEM, [header, group.join('\n\n')]));
      texts = merged.map((note, index) => `Merged notes ${index + 1} of ${merged.length}, oldest first:\n${renderSummary(note)}`);
    }
  }

  private async call(entry: Entry, compactor: ResolvedModel, systemPrompt: string, sections: string[]): Promise<CompactionSummary> {
    let result: unknown;
    try {
      result = await this.dependencies.model({ ...compactor, systemPrompt, prompt: sections.filter(Boolean).join('\n\n'), schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
        signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(CALL_LIMIT_MS)]) }, { timeoutMs: CALL_MS });
    } catch (error) {
      if (entry.controller.signal.aborted) throw error;
      throw new Error(`압축 모델(${compactor.provider}${compactor.model ? ` ${compactor.model}` : ''}) 호출이 실패했습니다: ${message(error)}`);
    }
    const summary = parseSummary(result);
    const progress = entry.job.progress;
    if (progress) this.update(entry, { progress: { done: progress.done + 1, total: Math.max(progress.total, progress.done + 1) } });
    return summary;
  }

  /** Saves the attempts; `strict` rejects when the file could not be written. Every attempt is kept: forgetting one would let a retry create a second session. */
  private save(strict = false): Promise<void> {
    const data = `${JSON.stringify({ version: 1, sources: Object.fromEntries(this.attempts) })}\n`;
    // A file past what `load` reads back would turn compaction off for good: the attempt about to create is refused instead.
    if (strict && Buffer.byteLength(data) > (this.dependencies.maxFileBytes ?? FILE_BYTES)) return Promise.reject(new Error('압축 기록 파일이 너무 커서 새 세션을 만들지 않았습니다.'));
    const write = this.writes.then(() => writePrivateJson(this.path, data));
    this.writes = write.catch(error => console.error(`Session compactions were not saved: ${message(error)}`));
    return strict ? write : this.writes;
  }
}

/** Runs `work` over the items, at most a few at a time, with the results in the items' order; stops at a failure. */
async function inOrder<T, R>(items: readonly T[], work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index], index); } catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_CALLS, items.length) }, lane));
  return results;
}

/** Consecutive texts grouped so each group stays within `maxBytes`. */
function byBudget(texts: readonly string[], maxBytes: number): string[][] {
  const groups: string[][] = [];
  let size = 0;
  for (const text of texts) {
    const bytes = Buffer.byteLength(text) + 2;
    if (groups.length && size + bytes <= maxBytes) { groups.at(-1)!.push(text); size += bytes; }
    else { groups.push([text]); size = bytes; }
  }
  return groups;
}
