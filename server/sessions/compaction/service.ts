/**
 * Compaction of a conversation on the owner's request (the chat's compact button). The worker owns it, so a web restart
 * never cuts one short and a worker handoff waits for it: it reads the conversation's own history, every page and never
 * its sub-sessions, has the `sessions.compactor` model summarize it without tools, and starts one new session of the same
 * provider, folder, model and effort whose first message carries the summary as Tower's hidden instructions. The
 * original conversation and its records are never changed, stopped or closed.
 *
 * One compaction of what a conversation says creates at most one session: the attempt is recorded before the session is
 * created and its result right after, so a retry (after a lost answer, a worker handoff or a crash) gets the same session.
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChatMessage, CreateSessionRequest, Provider, Run, Session, SessionCompaction } from '../../../shared/types.js';
import { TowerError } from '../../../shared/errors.js';
import type { ResolvedModel } from '../../../shared/models.js';
import type { AutoPromptModelRequest } from '../../auto-prompt/native.js';
import { resolveModel } from '../../models/settings.js';
import { CLAUDE_EFFORT_LEVELS, validEffort, validModelId } from '../../providers/models.js';
import type { RunAdmission } from '../../runs/manager.js';
import { readPrivateJson, writePrivateJson } from '../../stores/private-json.js';
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
const JOB_MS = 30 * 60_000;
const CONCURRENT_CALLS = 2;
const ACTIVE_JOBS = 2;
const KEPT_JOBS = 200;
/**
 * Saved records, the oldest going first: attempts are small (a summary only while one is unsettled); summaries are up
 * to ~120 KB each, so the file stays well under the size it is read back with.
 */
const KEPT_ATTEMPTS = 2_000;
const KEPT_SUMMARIES = 300;
const FILE_BYTES = 64_000_000;

export interface SessionCompactionDependencies {
  stateDir: string;
  /** The conversation by Tower or native ID, resolved as every request about it is. */
  session(id: string): Session | undefined;
  runs(): readonly Run[];
  /** A page of the conversation's own history, oldest first: the latest, or the one before `before`. */
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
}

type Continuation = NonNullable<SessionCompaction['continuation']>;
interface Entry { job: SessionCompaction; requestId?: string; revision: string; controller: AbortController; cancelled?: boolean; running?: Promise<void> }
/** The summary a compacted session started with: its history hides it, so compacting that session again reads it here. */
interface Carried { sourceId: string; summary: string; createdAt: string }
/**
 * The last compaction of a conversation that began creating its session. Its `prompt` names the compaction, so the turn
 * that creates the session is recognized by it alone; `summary` is kept for that session's own later compaction.
 */
interface Attempt { jobId: string; revision: string; requestId?: string; at: string; state: 'creating' | 'done'; newSessionId?: string; prompt: string; cwd: string; provider: Provider; summary?: string }

const ACTIVE: ReadonlySet<SessionCompaction['state']> = new Set(['reading', 'summarizing', 'creating']);
const active = (entry: Entry | undefined) => !!entry && ACTIVE.has(entry.job.state);
/** What a conversation has said so far; a change while it is summarized means the summary is already behind. */
const revision = (session: Session) => createHash('sha256').update(`${session.messageCount}\u0000${session.lastMessage}`).digest('hex').slice(0, 32);
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
 * request for it, else the CLI's own default (unset). Tower's defaults for new chats never apply here.
 */
export function continuationModel(session: Session, runs: readonly Run[]): Continuation {
  const last = runs.filter(run => run.sessionId === session.id).reduce<Run | undefined>((latest, run) => !latest || run.createdAt > latest.createdAt ? run : latest, undefined);
  const effortOk = (value: unknown): value is string => validEffort(value) && (session.provider !== 'claude' || CLAUDE_EFFORT_LEVELS.includes(value));
  const model = validModelId(session.model) ? { model: session.model, modelSource: 'observed' as const }
    : validModelId(last?.model) ? { model: last.model, modelSource: 'lastRun' as const } : { modelSource: 'default' as const };
  const effort = effortOk(session.effort) ? { effort: session.effort, effortSource: 'observed' as const }
    : effortOk(last?.effort) ? { effort: last.effort, effortSource: 'lastRun' as const } : { effortSource: 'default' as const };
  return { provider: session.provider, ...model, ...effort };
}

/** Why the conversation cannot be compacted now, or undefined. */
function blocked(session: Session, runs: readonly Run[]): string | undefined {
  if (session.master || session.isSubagent || session.launchedByAgent) return '이 대화는 압축할 수 없습니다. 소유자가 이어서 작업하는 세션만 압축합니다.';
  if (session.creationPending) return '세션을 만드는 중입니다. 첫 응답이 끝난 뒤 다시 시도하세요.';
  if (!session.resumable) return '이어서 작업할 수 없는 세션은 압축할 수 없습니다.';
  if (session.messageCount === 0) return '압축할 대화가 없습니다.';
  if (session.status === 'working' || runs.some(run => run.sessionId === session.id && (run.status === 'running' || run.status === 'queued'))) {
    return '작업 중이거나 대기·예약된 요청이 있는 세션은 압축할 수 없습니다. 끝나거나 취소된 뒤 다시 시도하세요.';
  }
  return undefined;
}

export class SessionCompactions {
  private readonly path: string;
  /** The latest compaction of each conversation this worker ran, by its Tower ID. */
  private readonly jobs = new Map<string, Entry>();
  private carried = new Map<string, Carried>();
  /** By the compacted conversation's Tower ID. */
  private attempts = new Map<string, Attempt>();
  private persist = true;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly dependencies: SessionCompactionDependencies) {
    this.path = join(dependencies.stateDir, FILE);
  }

  private now(): number { return this.dependencies.now?.() ?? Date.now(); }

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
    const input = record(saved) ? saved : {};
    for (const [id, value] of Object.entries(record(input.sessions) ? input.sessions : {})) {
      if (record(value) && typeof value.sourceId === 'string' && typeof value.summary === 'string' && typeof value.createdAt === 'string') {
        this.carried.set(id, { sourceId: value.sourceId, summary: value.summary, createdAt: value.createdAt });
      }
    }
    for (const [id, value] of Object.entries(record(input.sources) ? input.sources : {})) {
      if (record(value) && typeof value.jobId === 'string' && typeof value.revision === 'string' && typeof value.at === 'string' && (value.state === 'creating' || value.state === 'done')
        && typeof value.prompt === 'string' && typeof value.cwd === 'string' && (value.provider === 'claude' || value.provider === 'codex') && (value.summary === undefined || typeof value.summary === 'string')
        && (value.newSessionId === undefined || typeof value.newSessionId === 'string') && (value.requestId === undefined || typeof value.requestId === 'string')) {
        this.attempts.set(id, { jobId: value.jobId, revision: value.revision, ...(value.requestId ? { requestId: value.requestId } : {}), at: value.at, state: value.state,
          ...(value.newSessionId ? { newSessionId: value.newSessionId } : {}), prompt: value.prompt, cwd: value.cwd, provider: value.provider, ...(value.summary ? { summary: value.summary } : {}) });
      }
    }
  }

  /** A compaction is reading, summarizing or creating: a worker handoff waits for it. */
  inFlight(): boolean { return [...this.jobs.values()].some(active); }

  /** The conversation's latest compaction: one this worker ran, else the last one that began creating a session. */
  get(sessionId: string): SessionCompaction | undefined {
    const id = this.dependencies.session(sessionId)?.id ?? sessionId;
    const entry = this.jobs.get(id);
    if (entry) return structuredClone(entry.job);
    const attempt = this.settled(id);
    return attempt && savedJob(id, attempt);
  }

  /**
   * Starts compacting, or answers with the compaction that already covers this request: one running for the
   * conversation, one for the same request ID, or a finished one for exactly what the conversation says now.
   */
  start(sessionId: string, options: { title?: string; requestId?: string }, admission: RunAdmission): SessionCompaction {
    if (this.closed) throw new TowerError('unavailable', 'Tower가 실행 워커를 바꾸는 중입니다. 잠시 후 다시 시도하세요.', { disposition: 'not-admitted' });
    if (!this.persist) throw new TowerError('unavailable', '압축 기록 파일(session-compactions.json)을 읽지 못해 압축할 수 없습니다. 같은 압축이 두 번 만들어지지 않도록 파일을 확인할 때까지 멈춥니다.');
    const session = this.dependencies.session(sessionId);
    if (!session) throw new TowerError('not-found', '세션을 찾을 수 없습니다.');
    const now = revision(session);
    const same = (requestId: string | undefined, saved: string) => saved === now || (!!options.requestId && requestId === options.requestId);
    const kept = this.jobs.get(session.id);
    if (kept && (active(kept) || (!!options.requestId && kept.requestId === options.requestId) || (kept.job.state === 'done' && kept.revision === now))) return structuredClone(kept.job);
    const attempt = this.settled(session.id);
    if (attempt && same(attempt.requestId, attempt.revision)) {
      if (attempt.state === 'done') return savedJob(session.id, attempt);
      // Whether it made a session is unknown: making another could be a duplicate. Once the conversation goes on, a
      // compaction of what it says then is a different one.
      throw new TowerError('conflict', UNCERTAIN);
    }
    const problem = blocked(session, this.dependencies.runs()) ?? this.dependencies.refuse?.(session);
    if (problem) throw new TowerError('conflict', problem);
    if ([...this.jobs.values()].filter(active).length >= ACTIVE_JOBS) throw new TowerError('rate-limited', '다른 세션을 압축하고 있습니다. 끝난 뒤 다시 시도하세요.');
    const at = new Date(this.now()).toISOString();
    const entry: Entry = { job: { id: randomUUID(), sessionId: session.id, state: 'reading', createdAt: at, updatedAt: at },
      ...(options.requestId ? { requestId: options.requestId } : {}), revision: now, controller: new AbortController() };
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
    if (active(entry)) { entry.cancelled = true; entry.controller.abort(); this.update(entry, { state: 'cancelled', progress: undefined }); }
    return structuredClone(entry.job);
  }

  /** Ends compactions underway (the worker is closing): nothing half-made is created. */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.jobs.values()) if (active(entry) && entry.job.state !== 'creating') entry.controller.abort();
    // `run` settles every compaction itself and never rejects.
    await Promise.all([...this.jobs.values()].map(entry => entry.running));
    await this.writes;
  }

  /**
   * The conversation's last attempt to create a session, settled where it can be. One left `creating` is matched to the
   * turn that names its compaction (`runs.create` saves that turn before it answers): found, the session exists. Not
   * found right after this worker's own creation failed, nothing was made and the attempt is dropped. Not found after a
   * crash, it stays `creating`: whether a session was made is unknown, and none is made again for it.
   */
  private settled(sourceId: string, ended = false): Attempt | undefined {
    const attempt = this.attempts.get(sourceId);
    if (!attempt || attempt.state === 'done') return attempt;
    if (!ended && active(this.jobs.get(sourceId))) return undefined;
    const run = this.dependencies.runs().find(item => item.prompt === attempt.prompt && item.createdAt >= attempt.at);
    if (!run) {
      if (ended) { this.attempts.delete(sourceId); void this.save(); return undefined; }
      return attempt;
    }
    const newSessionId = this.dependencies.session(run.sessionId)?.id ?? run.sessionId;
    const { summary, ...rest } = attempt;
    const done: Attempt = { ...rest, state: 'done', newSessionId };
    this.attempts.set(sourceId, done);
    if (summary) this.carried.set(newSessionId, { sourceId, summary, createdAt: attempt.at });
    void this.save();
    return done;
  }

  private update(entry: Entry, patch: Partial<SessionCompaction>): void {
    // A cancelled or finished compaction keeps its end.
    if (!ACTIVE.has(entry.job.state)) return;
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
    const timer = setTimeout(() => entry.controller.abort(), JOB_MS);
    timer.unref?.();
    let recorded = false;
    try {
      const read = await this.read(source, entry.controller.signal);
      const compactor = await resolveModel(this.dependencies.stateDir, 'sessions.compactor');
      this.update(entry, { compactor: { provider: compactor.provider, ...(compactor.model ? { model: compactor.model } : {}), ...(compactor.effort ? { effort: compactor.effort } : {}) } });
      const carried = this.carried.get(source.id)?.summary;
      const parts = packParts(read.lines);
      if (!parts.length && !carried) throw new Error('압축할 대화 내용이 없습니다.');
      if (parts.length > MAX_PARTS) throw new Error('대화가 너무 길어 압축할 수 없습니다. 앞부분을 버리지 않고는 정해진 호출 수 안에 읽을 수 없습니다.');
      this.update(entry, { state: 'summarizing', progress: { done: 0, total: parts.length > 1 ? parts.length + 1 : 1 } });
      const header = [`Conversation "${clip(title, 200)}" in ${source.cwd} (${source.provider === 'claude' ? 'Claude Code' : 'Codex'}).`,
        ...(read.skipped ? [`${read.skipped} records of it could not be read and are missing below.`] : [])].join(' ');
      const summary = renderSummary(await this.summarize(entry, compactor, header, parts, carried));
      if (entry.controller.signal.aborted) throw new Error('압축이 중단되었습니다.');
      if (admission.origin?.controllerId) await this.dependencies.remote?.prepare(source);
      const early = this.lastLook(source.id, entry.revision, admission);
      if (early) throw new Error(early);
      if (entry.controller.signal.aborted) throw new Error('압축이 중단되었습니다.');
      const latest = this.dependencies.session(source.id)!;
      const continuation = continuationModel(latest, this.dependencies.runs());
      const prompt = visiblePrompt(title, entry.job.id);
      this.update(entry, { state: 'creating', continuation, progress: undefined });
      // Recorded before the session exists, so no retry can make a second one (see `settled`).
      this.attempts.delete(source.id);
      this.attempts.set(source.id, { jobId: entry.job.id, revision: entry.revision, ...(entry.requestId ? { requestId: entry.requestId } : {}),
        at: new Date(this.now()).toISOString(), state: 'creating', prompt, cwd: latest.cwd, provider: latest.provider, summary });
      recorded = true;
      await this.save(true);
      const created = await this.dependencies.create({
        provider: latest.provider, cwd: latest.cwd, prompt, title: continuedTitle(title),
        ...(continuation.model ? { model: continuation.model } : {}), ...(continuation.effort ? { effort: continuation.effort } : {}),
      }, { ...admission, instructions: { text: startInstructions({ title, id: latest.id }, summary), required: true }, createFolder: false,
        ...(this.dependencies.untrusted?.(latest) ? { untrustedInput: true } : {}),
        // Runs right before the session is registered, after every wait in creating it.
        validate: () => {
          admission.validate?.();
          const problem = this.lastLook(source.id, entry.revision, admission);
          if (problem) throw new TowerError('conflict', problem);
        } });
      const { summary: _kept, ...attempt } = this.attempts.get(source.id)!;
      this.attempts.set(source.id, { ...attempt, state: 'done', newSessionId: created.session.id });
      this.carried.delete(created.session.id);
      this.carried.set(created.session.id, { sourceId: latest.id, summary, createdAt: new Date(this.now()).toISOString() });
      await this.save();
      this.update(entry, { state: 'done', newSessionId: created.session.id });
    } catch (error) {
      const timedOut = entry.controller.signal.aborted && !entry.cancelled && !this.closed;
      // A part still being summarized beside the one that failed is not needed any more.
      entry.controller.abort();
      if (entry.cancelled) return;
      // A creation that failed after saving its session still made it: that session is the compaction's result.
      if (recorded) {
        const made = this.settled(source.id, true);
        // The settled record is on disk before the compaction ends, so a retry right after reads it.
        await this.writes;
        if (made?.state === 'done' && made.newSessionId) { this.update(entry, { state: 'done', newSessionId: made.newSessionId }); return; }
      }
      const reason = this.closed ? 'Tower 실행 워커가 바뀌어 압축을 멈췄습니다. 새 세션은 만들지 않았습니다. 다시 시도하세요.'
        : timedOut ? '압축이 제한 시간(30분) 안에 끝나지 않아 중단했습니다. 새 세션은 만들지 않았습니다.' : message(error);
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
      if (signal.aborted) throw new Error('압축이 중단되었습니다.');
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
  private async summarize(entry: Entry, compactor: ResolvedModel, header: string, parts: string[], carried: string | undefined): Promise<CompactionSummary> {
    const earlier = carried ? [`Summary carried from the session this conversation continues (older than everything below):\n${carried}`] : [];
    if (parts.length <= 1) return this.call(entry, compactor, SUMMARY_SYSTEM, [header, ...earlier, `The conversation, oldest first:\n${parts[0] ?? '(nothing new was said)'}`]);
    const notes = await inOrder(parts, (part, index) => this.call(entry, compactor, NOTES_SYSTEM, [header, `Part ${index + 1} of ${parts.length}, oldest first:\n${part}`]));
    let texts = [...earlier, ...notes.map((note, index) => `Notes from part ${index + 1} of ${parts.length}:\n${renderSummary(note)}`)];
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

  /** Saves both kinds of record; `strict` rejects when the file could not be written. */
  private save(strict = false): Promise<void> {
    for (const old of [...this.carried.keys()].slice(0, Math.max(0, this.carried.size - KEPT_SUMMARIES))) this.carried.delete(old);
    // An unsettled attempt is never dropped: forgetting it would let a retry create a second session.
    for (const [old, attempt] of this.attempts) { if (this.attempts.size <= KEPT_ATTEMPTS) break; if (attempt.state === 'done') this.attempts.delete(old); }
    const data = `${JSON.stringify({ version: 1, sessions: Object.fromEntries(this.carried), sources: Object.fromEntries(this.attempts) })}\n`;
    // A file past what `load` reads back would turn compaction off for good: the attempt about to create is refused instead.
    if (strict && Buffer.byteLength(data) > FILE_BYTES) return Promise.reject(new Error('압축 기록 파일이 너무 커서 새 세션을 만들지 않았습니다.'));
    const write = this.writes.then(() => writePrivateJson(this.path, data));
    this.writes = write.catch(error => console.error(`Session compactions were not saved: ${message(error)}`));
    return strict ? write : this.writes;
  }
}

const UNCERTAIN = '이전 압축이 새 세션을 만들었는지 확인할 수 없어(실행 워커가 중간에 멈춤) 다시 만들지 않았습니다. 세션 목록에서 「(이어서)」 세션을 확인하세요. 원래 세션에서 대화가 더 이어지면 다시 압축할 수 있습니다.';

/** A compaction known only from its saved attempt (an earlier worker ran it). */
function savedJob(sessionId: string, attempt: Attempt): SessionCompaction {
  const base = { id: attempt.jobId, sessionId, createdAt: attempt.at, updatedAt: attempt.at };
  return attempt.state === 'done' ? { ...base, state: 'done', ...(attempt.newSessionId ? { newSessionId: attempt.newSessionId } : {}) } : { ...base, state: 'failed', error: UNCERTAIN };
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
