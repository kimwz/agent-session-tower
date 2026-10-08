import { randomUUID } from 'node:crypto';
import { continuedRunById } from '../runs/continuations.js';
import { join } from 'node:path';
import { MASTER_FOLDER, type MasterBinding, type MasterSpeak, type MasterTaskState, type MasterUnspoken } from '../../shared/master.js';
import type { AutoPromptJob, ChatMessage, Provider, Run, RunReply, SessionDetail, SessionOutcome, Snapshot } from '../../shared/types.js';
import type { MasterEntryData, MasterFollowState } from '../../shared/master.js';
import { quarantineFile, readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { ApiTarget } from '../tower-tools/api-target.js';
import { REPORT_MARK, VOICE_MARK, writeMasterGuide } from './guide.js';
import type { LiveState } from '../tower-tools/live-state.js';
import { replyError } from '../tower-tools/tower-client.js';
import type { Table } from '../tower-tools/read-db.js';
import type { MasterRoom } from './room.js';
import type { MasterSettingsStore } from './settings.js';
import type { TowerClient } from '../tower-tools/tower-client.js';
import { READ_CHARS } from './voice-text.js';
import { TowerError } from '../../shared/errors.js';

const FOLLOW_MS = 5_000;
/** Work Tower cannot find for this long is reported as unknown. */
const UNKNOWN_MS = 30 * 60_000;
const MASTER_RUNS = 500;
const FOLLOWED = 300;
/** Longest report message: well under what a session takes (32,000 characters), so a report is never refused for size. */
const REPORT_CHARS = 24_000;
/** A report Tower refused goes again after this long, twice as long each time, and is given up on after so many tries. */
const REPORT_RETRY_MS = 15_000;
const REPORT_TRIES = 8;
/** A report whose sending was cut off is looked for this long in the master's runs and history before it goes again. */
const RECONCILE_MS = 2 * 60_000;
const RECONCILES = 60;
/** How Tower adds attached files to a request in a session's history (`attachmentPrompt`), once spaces are folded. */
const ATTACHED = ' 첨부 파일 (사용자가 이번 메시지에 첨부한 로컬 파일):';

/**
 * Something Tower follows for the master: work it handed out (reported to it when it ends), a request the owner said
 * aloud, or a report (whose answers are read aloud when voice is on).
 */
export interface Followed {
  id: string;
  kind: 'delegated' | 'spoken' | 'report';
  title: string;
  sessionId?: string;
  runId?: string;
  /** The run that currently carries this work on after a forced worker update; `runId` stays the first one. */
  currentRunId?: string;
  /** First authenticated caller in this chain, retained even if its run leaves history. */
  rootRunId?: string;
  outcome?: SessionOutcome;
  jobId?: string;
  node?: string;
  prompt?: string;
  createdAt: string;
  state: MasterTaskState;
  /**
   * Delegated work's report. Written as "sending" before it goes; one whose outcome is unknown ("uncertain", also after
   * a restart) is looked for in the master session by its report ID and sent again only when it is surely not there.
   */
  report?: 'pending' | 'sending' | 'sent' | 'uncertain' | 'failed';
  /** How often Tower refused the report; it waits longer each time and gives up (shown as failed) in the end. */
  reportTries?: number;
  /** Tower could not take it just then (a web or worker changing over): it waits a little, without counting a try. */
  reportHeld?: true;
  /** Looks for a report in doubt that could not settle it (its history too long to read back); given up on in the end. */
  reconciles?: number;
  /** The message the report went in, named in its text, and when it was sent. */
  reportId?: string;
  reportAt?: string;
  /** A spoken request's key (from its client message ID), so the same request is sent once. */
  key?: string;
  /** Spoken or report runs that share one turn (steered into it) are read aloud once, as that turn's answer. */
  turn?: string;
  spoke?: true;
  answer?: string;
  /** Its answer was longer than kept: reading it aloud ends saying the rest is on the screen. */
  cut?: true;
  /** The voice session a spoken request (or a report while voice is on) belongs to. */
  voice?: string;
}

/**
 * A turn read aloud while the master wrote it: `started` before its first words went to speech, `stopped` when it was
 * not heard to the end, `done` when it was. Kept by turn (the run steered messages joined), so a turn is never read
 * twice, whichever request of it is looked at, and after a restart.
 */
export interface VoicedTurn { turn: string; state: 'started' | 'stopped' | 'done'; at: string }
const VOICED = 200;

interface FollowFile { version: 1; baselineAt: string; masterRuns: string[]; followed: Followed[]; voiced?: VoicedTurn[]; stoppedAt?: string }

/** What the voice gets from the master session. */
export interface VoiceSide {
  speaks(report: boolean): 'pending' | 'unspoken' | undefined;
  /** Why an answer with no voice page to read it is not read (the owner turned voice off, or no page was there). */
  quiet?(): MasterUnspoken;
  deliver(): void;
  /** The master's words for a turn so far, to read while they are written. */
  stream?(input: { turn: string; kind: 'answer' | 'report'; key: string; request?: string; voiceSession?: string; replies: readonly RunReply[] }): void;
  /** Whether a turn is being read while it is written. */
  streaming?(turn: string): boolean;
  /** The turns being read while they are written. */
  streamingTurns?(): string[];
  /** A turn with a voiced record ended: the rest is read, and its entry added (never waiting to be read again). */
  finishStream?(input: { turn: string; replies?: readonly RunReply[]; completed: boolean; data?: MasterEntryData }): void;
  timings?: { observe?(key: string | undefined, input: { runId: string; turnId: string; finishedAt?: string; replies?: readonly RunReply[] }): void; mark(key: string | undefined, field: 'request' | 'text' | 'end', at?: number, about?: { kind?: 'answer' | 'report' }): void };
}
const FINISHED_RUN = new Set<Run['status']>(['completed', 'error', 'cancelled']);

export interface MasterSessionOptions {
  stateDir: string;
  dataDir: string;
  settings: MasterSettingsStore;
  tower: TowerClient;
  live: LiveState;
  /** The voice's ledger: spoken requests and what is read aloud. */
  room: MasterRoom;
  followMs?: number;
  /** Tests shorten the wait before a refused report goes again. */
  reportRetryMs?: number;
  onChange?(): void;
}

/**
 * The master session: a Claude or Codex session Tower keeps in its own folder. The owner writes to it like to any
 * session; Tower adds the guide, follows the work it hands out and reports when it ends, and passes spoken requests
 * and their answers between the session and the voice.
 */
export class MasterSession {
  readonly folder: string;
  private file: FollowFile = { version: 1, baselineAt: new Date().toISOString(), masterRuns: [], followed: [] };
  private readonly path: string;
  /** Off while the follow file could not be read or moved aside: it is never written over. */
  private persist = true;
  private problem?: MasterFollowState;
  private voice?: VoiceSide;
  private timer?: ReturnType<typeof setInterval>;
  private following?: Promise<void>;
  private starting?: Promise<MasterBinding>;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly sending = new Set<string>();
  private closed = false;
  private followAgain = false;
  private unsubscribeLive?: () => void;
  private lookScheduled = false;

  constructor(private readonly options: MasterSessionOptions) {
    this.folder = join(options.stateDir, MASTER_FOLDER);
    this.path = join(options.dataDir, 'follow.json');
  }

  async start(): Promise<void> {
    const saved = await this.read();
    if (saved) {
      this.file = { version: 1, baselineAt: saved.baselineAt, masterRuns: saved.masterRuns.filter(id => typeof id === 'string'), followed: saved.followed.filter(item => item && typeof item.id === 'string'),
        ...(typeof saved.stoppedAt === 'string' ? { stoppedAt: saved.stoppedAt } : {}),
        voiced: (Array.isArray(saved.voiced) ? saved.voiced : []).filter(item => item && typeof item.turn === 'string')
          // What was being read when the host stopped is not read on: its place in the words is gone.
          .map(item => item.state === 'started' ? { ...item, state: 'stopped' as const } : item) };
    }
    // A report that was being sent when the host stopped may have arrived: it is looked for before it goes again. A
    // spoken request cut off the same way is not followed (nor sent again), so no late "could not answer" is read aloud.
    for (const item of this.file.followed) {
      if (item.report === 'sending') item.report = 'uncertain';
      if (item.kind === 'spoken' && !item.runId && item.state === 'running') item.state = 'unknown';
    }
    await this.save();
    await writeMasterGuide(this.folder);
    this.timer = setInterval(() => { void this.follow(); }, this.options.followMs ?? FOLLOW_MS);
    this.timer.unref();
    this.unsubscribeLive = this.options.live.subscribe?.(() => this.changed());
  }

  /**
   * Tower's state changed: the master's words so far go to the voice, and a followed turn that ended is looked at at
   * once (not at the next regular look). Once per change burst.
   */
  private changed(): void {
    if (this.lookScheduled || this.closed) return;
    this.lookScheduled = true;
    setImmediate(() => {
      this.lookScheduled = false;
      if (this.closed) return;
      const snapshot = this.options.live.snapshot();
      if (!snapshot) return;
      let ended = false;
      const seen = new Set<string>();
      /** Turns a followed request still waits on: their end is settled when that request is looked at. */
      const covered = new Set<string>();
      for (const item of this.file.followed) {
        if (item.state !== 'running' || !item.runId || item.node) continue;
        const run = continuedRunById(snapshot.runs ?? [], item.currentRunId ?? item.runId);
        if (!run) continue;
        const turn = turnOf(run, snapshot);
        covered.add(turn.id);
        if (item.kind === 'spoken' || item.kind === 'report') this.voice?.timings?.observe?.(timingKey(item), { runId: run.id, turnId: turn.id, finishedAt: turn.finishedAt, replies: turn.replies });
        if (FINISHED_RUN.has(turn.status) || FINISHED_RUN.has(run.status)) { ended = true; continue; }
        if ((item.kind !== 'spoken' && item.kind !== 'report') || seen.has(turn.id)) continue;
        seen.add(turn.id);
        if (turn.replies?.some(reply => reply.text.trim())) this.voice?.timings?.mark(timingKey(item), 'text');
        // A turn with a record is followed on only while it is being read here (not one stopped, or read before a restart).
        if (!turn.replies || (this.voiced(turn.id) && !this.voice?.streaming?.(turn.id))) continue;
        this.voice?.stream?.({ turn: turn.id, kind: item.kind === 'spoken' ? 'answer' : 'report', key: timingKey(item),
          ...(item.kind === 'spoken' && item.key ? { request: item.key } : {}), ...(item.kind === 'spoken' && item.voice ? { voiceSession: item.voice } : {}), replies: turn.replies });
      }
      // A turn being read that no followed request waits on any more (the one steered into it failed to arrive): its
      // words are still followed here, and it is settled when it ends.
      for (const turnId of this.voice?.streamingTurns?.() ?? []) {
        if (covered.has(turnId)) continue;
        const turn = (snapshot.runs ?? []).find(entry => entry.id === turnId);
        if (!turn?.replies) continue;
        if (FINISHED_RUN.has(turn.status)) this.voice?.finishStream?.({ turn: turnId, replies: turn.replies, completed: turn.status === 'completed' });
        else this.voice?.stream?.({ turn: turnId, kind: 'answer', key: turnId, replies: turn.replies });
      }
      if (ended) void this.follow();
    });
  }

  /** The voiced record of a turn, if it has one. */
  private voiced(turn: string): VoicedTurn | undefined { return this.file.voiced?.find(item => item.turn === turn); }

  /** Kept for the voice (awaited before a turn's first words go to speech). */
  async voicedState(turn: string, state: VoicedTurn['state']): Promise<void> {
    const voiced = this.file.voiced ??= [];
    const known = voiced.find(item => item.turn === turn);
    if (known) { known.state = state; known.at = new Date().toISOString(); }
    else voiced.push({ turn, state, at: new Date().toISOString() });
    if (voiced.length > VOICED) voiced.splice(0, voiced.length - VOICED);
    await this.save();
  }

  setVoice(voice: VoiceSide): void { this.voice = voice; }

  /** A detached read of tracked work, shared with the heartbeat inspector. */
  heartbeatTasks(): Followed[] { return structuredClone(this.file.followed.filter(item => item.kind === 'delegated')); }
  heartbeatStopped(): boolean { return Boolean(this.file.stoppedAt) || !this.persist; }
  async heartbeatAccepted(run: Run): Promise<void> { this.remember(run.id); await this.save(); }

  binding(): MasterBinding | undefined { return this.options.settings.current().session; }

  /** Work handed out and not reported yet. */
  activeTasks(): number { return this.file.followed.filter(item => item.kind === 'delegated' && (item.state === 'running' || (item.report !== undefined && item.report !== 'sent' && item.report !== 'failed'))).length; }
  /** Reports Tower kept refusing, which the master never got. */
  /** Why followed work may be missing: the file was moved aside, or it could not be read or moved and nothing is saved. */
  stateProblem(): MasterFollowState | undefined { return this.problem; }

  /**
   * The saved follow file. A file that cannot be parsed or has the wrong shape is moved aside and the master starts
   * fresh; one that cannot be read, or moved, is left as it is and nothing is saved over it until a restart.
   */
  private async read(): Promise<FollowFile | undefined> {
    let saved: unknown;
    try { saved = await readPrivateJson(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (!(error instanceof SyntaxError)) { this.keep(error); return undefined; }
      await this.setAside(error);
      return undefined;
    }
    const file = saved as Partial<FollowFile> | null;
    if (file?.version === 1 && Array.isArray(file.followed) && Array.isArray(file.masterRuns) && typeof file.baselineAt === 'string') return file as FollowFile;
    await this.setAside(new Error('Saved master follow state is invalid.'));
    return undefined;
  }
  private async setAside(error: unknown): Promise<void> {
    console.error('The master\'s follow state could not be read and was moved aside:', error);
    try { await quarantineFile(this.path); this.problem = 'moved-aside'; }
    catch (moveError) { this.keep(moveError); }
  }
  private keep(error: unknown): void {
    this.persist = false;
    this.problem = 'not-saved';
    console.error('The master\'s follow state could not be read or moved aside; nothing is saved until Tower restarts:', error);
  }

  failedReports(): number { return this.file.followed.filter(item => item.kind === 'delegated' && item.report === 'failed').length; }

  /** A report is on its way: a host of another build waits until it is sent. */
  busy(): boolean { return this.file.followed.some(item => item.report === 'sending'); }

  /** The work handed out, as tower_query shows it. */
  delegatedTable(): Table {
    return { name: 'delegated', columns: ['id', 'title', 'state', 'session_id', 'node', 'created_at', 'report', 'outcome'],
      rows: this.file.followed.filter(item => item.kind === 'delegated').map(item => [item.id, item.title, item.state, item.sessionId ?? null, item.node ?? null, item.createdAt, item.report ?? null, item.outcome ?? null]) };
  }

  /**
   * Starts the master session with the owner's first message: a new session in the master's folder, with its guide.
   * `replace` starts a new one in place of the current (another provider, a fresh conversation); the old one stays an
   * ordinary session. A start whose answer was lost is not tried again: the owner sees it in the session list.
   */
  begin(input: { provider: Provider; text: string; model?: string; effort?: string; replace?: boolean }): Promise<MasterBinding> {
    if (this.starting) throw new TowerError('conflict', '마스터 세션을 시작하는 중입니다.');
    const run = async (): Promise<MasterBinding> => {
      if (this.binding() && !input.replace) throw new TowerError('conflict', '마스터 세션이 이미 있습니다.');
      await writeMasterGuide(this.folder);
      const response = await this.options.tower.call('POST', '/api/sessions', { provider: input.provider, cwd: this.folder, prompt: input.text, title: '마스터',
        ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) }, { write: true });
      const created = response.body as { session?: { id?: string }; run?: Run } | undefined;
      if (response.state !== 'succeeded' || !created?.session?.id) {
        const message = (response.body as { error?: string } | undefined)?.error;
        throw response.state === 'uncertain'
          ? new TowerError('unavailable', '마스터 세션을 만들었는지 알 수 없습니다. 세션 목록에서 "마스터" 세션을 확인해 주세요.')
          : replyError(`마스터 세션을 시작하지 못했습니다${message ? `: ${message}` : '.'}`, response, 'upstream');
      }
      const binding: MasterBinding = { sessionId: created.session.id, provider: input.provider, startedAt: new Date().toISOString() };
      await this.options.settings.bind(binding);
      if (created.run?.id) this.remember(created.run.id);
      await this.save();
      this.options.onChange?.();
      return binding;
    };
    return this.starting = run().finally(() => { this.starting = undefined; });
  }

  /** Lets go of the master session; the next message starts a new one. The session itself stays as it is. */
  async release(): Promise<void> {
    await this.options.settings.bind(undefined);
    this.options.onChange?.();
  }

  /** A request the owner said aloud: sent to the master session, and its answer read aloud when it comes. */
  async spoken(input: { text: string; voiceSession: string; key: string }): Promise<void> {
    const binding = this.binding();
    if (!binding) throw new TowerError('conflict', '마스터 세션이 아직 없습니다. 먼저 글로 한 번 말을 걸어 주세요.');
    // The same request (its page sent it again) goes once.
    if (this.sending.has(input.key) || this.file.followed.some(item => item.key === input.key)) return;
    this.sending.add(input.key);
    try { await this.sendSpoken(binding, input); } finally { this.sending.delete(input.key); }
  }

  private async sendSpoken(binding: MasterBinding, input: { text: string; voiceSession: string; key: string }): Promise<void> {
    const prompt = `${VOICE_MARK} ${input.text}`;
    // On disk before it goes: sent again with the same key, or after a restart, it is not sent twice.
    const item: Followed = { id: randomUUID(), kind: 'spoken', title: truncate(input.text, 80), sessionId: binding.sessionId, prompt, createdAt: new Date().toISOString(), state: 'running', voice: input.voiceSession, key: input.key };
    this.add(item);
    this.voice?.timings?.mark(timingKey(item), 'request', Date.now(), { kind: 'answer' });
    await this.save();
    this.options.room.add({ kind: 'owner', text: input.text, voice: true });
    const response = await this.options.tower.call('POST', `/api/sessions/${encodeURIComponent(binding.sessionId)}/messages`, { prompt }, { write: true })
      .catch(() => ({ state: 'uncertain' as const, status: 0, body: undefined }));
    const run = (response.body as { run?: Run } | undefined)?.run;
    if (response.state === 'succeeded' && run?.id) {
      item.runId = run.id;
      this.remember(run.id);
      await this.save();
      return;
    }
    // Refused, it can be said again; whether an uncertain one arrived is not known, so it is not sent again by its key.
    if (response.state !== 'uncertain') { this.file.followed = this.file.followed.filter(entry => entry !== item); await this.save(); }
    else { item.state = 'unknown'; await this.save(); }
    throw replyError((response.body as { error?: string } | undefined)?.error ?? '마스터 세션에 보내지 못했습니다.', response, 'unavailable');
  }

  /** Work a tower_api call started (a new session, a message, an Auto Prompt), followed so its end is reported. */
  async started(target: ApiTarget, body: Record<string, unknown> | undefined, answer: unknown): Promise<void> {
    const value = (answer ?? {}) as { session?: { id?: string }; run?: { id?: string; sessionId?: string; delegation?: Run['delegation'] }; job?: { id?: string }; result?: { job?: { id?: string } } };
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const title = truncate(typeof body?.title === 'string' && body.title ? body.title : prompt || target.local, 80);
    const message = /^\/api\/sessions\/([^/]+)\/messages$/.exec(target.local);
    let found: Pick<Followed, 'sessionId' | 'runId' | 'jobId'> | undefined;
    if (target.local === '/api/sessions' && value.session?.id) found = { sessionId: value.session.id, ...(value.run?.id ? { runId: value.run.id } : {}) };
    else if (message && value.run?.id) found = { sessionId: value.run.sessionId ?? decodeURIComponent(message[1]), runId: value.run.id };
    else if (target.local === '/api/auto-prompts' && value.job?.id) found = { jobId: value.job.id };
    else if (target.local === '/api/v1/autoPrompt.submit' && value.result?.job?.id) found = { jobId: value.result.job.id };
    if (!found) return;
    // Work sent to the master session itself is its own conversation, not work handed out.
    if (!target.node && found.sessionId === this.binding()?.sessionId) return;
    if (this.file.followed.some(item => (found.runId && item.runId === found.runId) || (found.jobId && item.jobId === found.jobId))) return;
    this.add({ id: randomUUID(), kind: 'delegated', title, ...found, ...(target.node ? { node: target.node } : {}), ...(value.run?.delegation ? { rootRunId: value.run.delegation.rootRunId } : {}), ...(prompt ? { prompt } : {}), createdAt: new Date().toISOString(), state: 'running' });
    await this.save();
    this.options.onChange?.();
  }

  /** One look at Tower: new work the master handed out, work that ended, reports to send and answers to read. */
  follow(): Promise<void> {
    // Asked again while a look is under way: one more look follows it, so a turn that ended meanwhile is not left for
    // the next regular look.
    if (this.following) { this.followAgain = true; return this.following; }
    return this.following = this.followOnce().catch(error => {
      console.error(`Master could not follow its work: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.following = undefined;
      if (this.followAgain && !this.closed) { this.followAgain = false; void this.follow(); }
    });
  }

  private async followOnce(): Promise<void> {
    const binding = this.binding();
    if (this.closed || !binding || !this.options.tower.hasCredentials()) return;
    const snapshot = await this.options.live.fresh();
    if (!snapshot) return;
    let changed = this.discover(snapshot, binding);
    for (const item of this.file.followed.filter(entry => entry.state === 'running')) {
      if (this.closed) return;
      const where = item.node ? this.options.live.node(item.node) ?? await this.nodeSnapshot(item.node) : snapshot;
      const current = item.currentRunId;
      if (where && await this.check(item, where)) changed = true;
      // Saved as soon as it moves, so the chain is still found after a restart.
      if (item.currentRunId !== current) changed = true;
    }
    if (await this.reconcile(snapshot, binding)) changed = true;
    if (await this.sendReports(binding)) changed = true;
    if (changed) { this.trim(); await this.save(); this.options.onChange?.(); }
  }

  /** Runs of the master session, and the work its turns handed out through Tower's own tools. */
  private discover(snapshot: Snapshot, binding: MasterBinding): boolean {
    let changed = false;
    for (const run of snapshot.runs ?? []) if (run.sessionId === binding.sessionId && !this.file.masterRuns.includes(run.id)) { this.remember(run.id); changed = true; }
    const masterTurns = (snapshot.runs ?? []).filter(run => run.sessionId === binding.sessionId);
    // An explicit stop must not be undone by a background report. A newer owner request releases the hold.
    for (const run of masterTurns) {
      if (run.status !== 'cancelled' || !run.ownerStopped) continue;
      const at = run.finishedAt ?? run.createdAt;
      if (!this.file.stoppedAt || Date.parse(at) > Date.parse(this.file.stoppedAt)) { this.file.stoppedAt = at; changed = true; }
    }
    if (this.file.stoppedAt && masterTurns.some(run => Date.parse(run.createdAt) > Date.parse(this.file.stoppedAt!)
      && !run.delegation && !run.scheduled && !run.permissionNotice && !run.updateWrapUp && !run.prompt.startsWith(REPORT_MARK) && (!run.origin || run.origin.kind === 'owner'))) {
      delete this.file.stoppedAt; changed = true;
    }
    const after = (at: string) => Date.parse(at) >= Date.parse(this.file.baselineAt);
    for (const item of this.file.followed) {
      if (item.kind !== 'delegated' || item.node) continue;
      const run = (snapshot.runs ?? []).find(run => run.id === (item.currentRunId ?? item.runId));
      const continued = continuedRunById(snapshot.runs ?? [], item.currentRunId ?? item.runId);
      if (continued && continued.id !== (item.currentRunId ?? item.runId) && item.state !== 'running') {
        item.state = 'running';
        delete item.answer; delete item.outcome; delete item.cut;
        delete item.report; delete item.reportId; delete item.reportAt; delete item.reportTries; delete item.reportHeld;
        changed = true;
      }
      if (run?.steering?.state === 'delivered' && item.turn !== run.steering.targetRunId) { item.turn = run.steering.targetRunId; changed = true; }
    }
    const callers = new Set([...this.file.masterRuns, ...this.file.followed.filter(item => item.kind === 'delegated' && !item.node)
      .flatMap(item => [item.runId, item.currentRunId, item.rootRunId, item.turn].filter((id): id is string => !!id))]);
    const ours = (item: Pick<Run, 'origin' | 'delegation'>) => item.delegation
      ? callers.has(item.delegation.parentRunId) || callers.has(item.delegation.rootRunId)
      : item.origin?.kind === 'agent' && !!item.origin.runId && callers.has(item.origin.runId);
    // Snapshots need not be in parent-first order. Include job dispatches and update continuations in the same closure.
    for (let added = true; added;) {
      added = false;
      for (const item of [...(snapshot.autoPrompts ?? []), ...(snapshot.runs ?? [])]) {
        if (!after(item.createdAt)) continue;
        const id = 'sessionId' in item && 'output' in item ? item.id : (item as AutoPromptJob).runId;
        const continuation = 'scheduled' in item && (item.scheduled?.resume === 'update' || item.scheduled?.resume === 'permission') && callers.has(item.scheduled.afterRunId);
        if (id && !callers.has(id) && (ours(item) || continuation)) { callers.add(id); added = true; }
        if (id && callers.has(id) && 'steering' in item && item.steering?.state === 'delivered' && !callers.has(item.steering.targetRunId)) {
          callers.add(item.steering.targetRunId); added = true;
        }
      }
    }
    // Jobs first: a job's run is the same work, found through the job.
    for (const job of snapshot.autoPrompts ?? []) {
      const known = this.file.followed.find(item => item.jobId === job.id);
      if (known && job.runId && !known.runId) { known.runId = job.runId; if (job.sessionId) known.sessionId = job.sessionId; changed = true; }
      if (known || !ours(job) || !after(job.createdAt) || this.file.followed.some(item => job.runId && item.runId === job.runId)) continue;
      this.add({ id: randomUUID(), kind: 'delegated', title: truncate(job.prompt, 80), ...(job.delegation ? { rootRunId: job.delegation.rootRunId } : job.origin?.runId ? { rootRunId: job.origin.runId } : {}), jobId: job.id, ...(job.runId ? { runId: job.runId } : {}), ...(job.sessionId ? { sessionId: job.sessionId } : {}), prompt: job.prompt, createdAt: job.createdAt, state: 'running' });
      changed = true;
    }
    for (const run of snapshot.runs ?? []) {
      // Tower's continuation after a forced update carries on a run already followed; it is not new work.
      if (run.scheduled?.resume === 'update' || run.scheduled?.resume === 'permission' || run.permissionNotice || run.permissionRequestIds?.length || run.updateWrapUp || !ours(run) || !after(run.createdAt) || run.sessionId === binding.sessionId || this.file.followed.some(item => item.runId === run.id)) continue;
      this.add({ id: randomUUID(), kind: 'delegated', title: truncate(run.prompt, 80), ...(run.delegation ? { rootRunId: run.delegation.rootRunId } : run.origin?.runId ? { rootRunId: run.origin.runId } : {}), runId: run.id, sessionId: run.sessionId, prompt: run.prompt, createdAt: run.createdAt, state: 'running' });
      changed = true;
    }
    return changed;
  }

  private async nodeSnapshot(node: string): Promise<Snapshot | undefined> {
    const response = await this.options.tower.call('GET', `/api/nodes/${node}/snapshot`, undefined, { write: false });
    return response.state === 'succeeded' ? response.body as Snapshot : undefined;
  }

  /** Whether something followed ended now; what happens next depends on what it was. */
  private async check(item: Followed, snapshot: Snapshot): Promise<boolean> {
    let ended: MasterTaskState | undefined;
    if (item.jobId && !item.runId) {
      const job = (snapshot.autoPrompts ?? []).find((entry: AutoPromptJob) => entry.id === item.jobId);
      if (job?.runId && job.sessionId) { item.runId = job.runId; item.sessionId = job.sessionId; }
      else if (job && (job.status === 'error' || job.status === 'cancelled')) ended = job.status;
    }
    let run: Run | undefined;
    if (!ended && item.runId) {
      // The item keeps its first run's ID, so discovery still knows that run; its continuation is looked up each time.
      run = continuedRunById(snapshot.runs ?? [], item.currentRunId ?? item.runId);
      // Remembered once it started, so the chain is found again after its earlier runs leave the history.
      if (run && run.id !== (item.currentRunId ?? item.runId) && run.status !== 'queued') item.currentRunId = run.id;
      if (run && (run.status === 'completed' || run.status === 'error' || run.status === 'cancelled')) ended = run.status;
    }
    if (!ended && Date.now() - Date.parse(item.createdAt) > UNKNOWN_MS && !run && !(item.jobId && !item.runId && (snapshot.autoPrompts ?? []).some(entry => entry.id === item.jobId))) ended = 'unknown';
    if (!ended) return false;
    // Messages steered into one turn share its answer, given after the last of them.
    const target = run ? run.steering?.targetRunId ?? run.id : undefined;
    // Only messages steered in after this one come after it in the history, before the turn's answer.
    const together = run ? (snapshot.runs ?? []).filter(entry => entry.id !== run.id && (entry.id === target || entry.steering?.targetRunId === target)
      && Date.parse(entry.createdAt) > Date.parse(run.createdAt)).map(entry => normalize(entry.prompt)) : [];
    if (target) item.turn = target;
    const turnRun = run ? turnOf(run, snapshot) : undefined;
    // The master's own words, as it wrote them, when every word is there; otherwise read back from its history.
    const written = turnRun && (item.kind === 'spoken' || item.kind === 'report') && ended === 'completed' ? lastMessage(turnRun) : undefined;
    const found = written ? { text: written } : item.sessionId && ended !== 'unknown' ? await this.finalAnswer(item, run, together).catch(() => undefined) : undefined;
    if (item.kind === 'spoken' || item.kind === 'report') this.voice?.timings?.mark(timingKey(item), 'end');
    item.state = ended;
    // An answer to read aloud is kept long enough to be read to the voice's limit (and to say the rest is on the screen).
    const keep = item.kind === 'delegated' ? 3000 : READ_CHARS + 1_000;
    if (found?.text) { item.answer = truncate(found.text, keep); if (found.text.length > keep) item.cut = true; }
    if (item.kind === 'delegated') {
      item.report = 'pending';
      if (found && 'outcome' in found && found.outcome) item.outcome = found.outcome;
      if (!found && run?.error) item.answer = `Error: ${truncate(run.error, 500)}`;
    } else this.speak(item, ended, turnRun);
    return true;
  }

  /** A spoken request's answer, or the answer to a report while voice is on, handed to the voice to read aloud. */
  private speak(item: Followed, ended: MasterTaskState, turnRun?: Run): void {
    const voice = this.voice;
    if (!voice) return;
    // A turn several messages were steered into is answered, and read aloud, once.
    const turn = item.turn ?? item.runId;
    if (turn && this.file.followed.some(other => other !== item && other.spoke && (other.turn ?? other.runId) === turn)) return;
    const report = item.kind === 'report';
    const state = voice.speaks(report);
    // Not read aloud because no voice page is there to read it: the owner is told when voice is on again.
    const speak: MasterSpeak | undefined = state && { state, ...(state === 'unspoken' ? { reason: voice.quiet?.() ?? 'away' } : {}), ...(item.voice && !report ? { session: item.voice } : {}), timing: timingKey(item),
      ...(item.cut && ended === 'completed' ? { cut: true as const } : {}) };
    const request = !report && item.key ? { request: item.key } : {};
    const data: MasterEntryData | undefined = !speak ? undefined : ended === 'completed' && item.answer
      ? report ? { kind: 'event', text: item.answer, speak } : { kind: 'master', text: item.answer, turnId: item.id, final: true, speak, ...request }
      : { kind: 'error', text: ended === 'cancelled' ? '요청이 멈췄습니다.' : '요청에 답하지 못했습니다. 마스터 창에서 확인해 주세요.', speak };
    // Read (or begun to be read) while it was written: the rest is read, and nothing of it is read twice.
    // Only the turn's own end settles it: a message steered into a turn still running that failed to arrive is told
    // on its own, as before, and the turn goes on being read.
    const turnGoesOn = turnRun !== undefined && !FINISHED_RUN.has(turnRun.status);
    if (turn && !turnGoesOn && (this.voiced(turn) || voice.streaming?.(turn)) && voice.finishStream) {
      if (ended === 'completed' && item.answer) item.spoke = true;
      voice.finishStream({ turn, ...(turnRun?.replies ? { replies: turnRun.replies } : {}), completed: ended === 'completed', ...(data ? { data } : {}) });
      return;
    }
    if (!data) return;
    // Only an answer read aloud stands for its turn; a failure does not keep the turn's answer from being read.
    if (data.kind !== 'error') item.spoke = true;
    this.options.room.add(data);
    voice.deliver();
  }

  /**
   * Reports waiting go to the master session, as few messages as fit, each named by its report ID so that one whose
   * sending was cut off can be found again. Nothing is sent twice.
   */
  private async sendReports(binding: MasterBinding): Promise<boolean> {
    const retry = this.options.reportRetryMs ?? REPORT_RETRY_MS;
    const since = (item: Followed) => Date.now() - Date.parse(item.reportAt ?? item.createdAt);
    const due = (item: Followed) => item.reportHeld ? since(item) >= retry : !item.reportTries || since(item) >= retry * 2 ** (item.reportTries - 1);
    if (this.file.stoppedAt) return false;
    const waiting = this.file.followed.filter(item => item.kind === 'delegated' && item.report === 'pending' && due(item));
    if (!waiting.length) return false;
    const line = (item: Followed) => `- "${item.title}" — ${item.state}${item.sessionId ? ` (session ${item.sessionId}${item.node ? ` on node ${item.node}` : ''})` : ''}`
      + (item.answer ? `\n  Its answer:\n${indent(item.answer)}` : '\n  Its answer could not be read; the owner can open the session.')
      + `\n  Goal outcome: ${item.outcome ?? 'unknown (not yet verified)'}.`;
    const batches: Followed[][] = [];
    let size = 0;
    for (const item of waiting) {
      const length = line(item).length + 1;
      if (!batches.length || size + length > REPORT_CHARS) { batches.push([]); size = 200; }
      batches.at(-1)!.push(item);
      size += length;
    }
    for (const batch of batches) {
      const reportId = randomUUID().slice(0, 8);
      const prompt = `${REPORT_MARK} Work you handed out ended (report ${reportId}):\n${batch.map(line).join('\n')}\n\nExecution completed is not proof that the owner's goal is done. Inspect the answers and tracked follow-up work; continue authorized remaining steps, respect real approval waits and owner stops, and do not resubmit work already running.`;
      for (const item of batch) { item.report = 'sending'; item.reportId = reportId; item.reportAt = new Date().toISOString(); }
      await this.save();
      const response = await this.options.tower.call('POST', `/api/sessions/${encodeURIComponent(binding.sessionId)}/messages`, { prompt }, { write: true })
        .catch(() => ({ state: 'uncertain' as const, status: 0, body: undefined }));
      const run = (response.body as { run?: Run } | undefined)?.run;
      for (const item of batch) {
        item.report = response.state === 'succeeded' ? 'sent' : response.state === 'uncertain' ? 'uncertain' : 'pending';
        if (response.state === 'not-admitted') { item.reportHeld = true; continue; }
        delete item.reportHeld;
        if (item.report !== 'pending') continue;
        item.reportTries = (item.reportTries ?? 0) + 1;
        if (item.reportTries >= REPORT_TRIES) item.report = 'failed';
      }
      if (response.state === 'succeeded' && run?.id) this.reported(run, binding, prompt);
      // Tower refused it (the master busy, or the web away): the rest waits for the next look.
      if (response.state !== 'succeeded') break;
    }
    return true;
  }

  /** A report the master session took: its answer is read aloud when voice is on. */
  private reported(run: Run, binding: MasterBinding, prompt: string): void {
    this.remember(run.id);
    if (!this.file.followed.some(item => item.kind === 'report' && item.runId === run.id)) {
      const item: Followed = { id: randomUUID(), kind: 'report', title: 'report', sessionId: binding.sessionId, runId: run.id, prompt: run.prompt ?? prompt, createdAt: run.createdAt ?? new Date().toISOString(), state: 'running' };
      this.add(item);
      this.voice?.timings?.mark(timingKey(item), 'request', Date.now(), { kind: 'report' });
    }
  }

  /**
   * A report whose sending was cut off is looked for in the master session: among its runs (queued ones included) and
   * in its history, by its report ID. Found, it counts as sent; surely missing after a while, it goes again.
   */
  private async reconcile(snapshot: Snapshot, binding: MasterBinding): Promise<boolean> {
    const doubtful = this.file.followed.filter(item => item.kind === 'delegated' && item.report === 'uncertain' && item.reportId);
    if (!doubtful.length) return false;
    let changed = false;
    const earliest = Math.min(...doubtful.map(item => Date.parse(item.reportAt ?? item.createdAt)));
    let history: ChatMessage[] | undefined | null = null;
    for (const reportId of new Set(doubtful.map(item => item.reportId!))) {
      const items = doubtful.filter(item => item.reportId === reportId);
      const named = (text: string) => text.startsWith(REPORT_MARK) && text.includes(`(report ${reportId})`);
      const run = (snapshot.runs ?? []).find(entry => entry.sessionId === binding.sessionId && named(entry.prompt));
      if (run) { for (const item of items) item.report = 'sent'; this.reported(run, binding, run.prompt); changed = true; continue; }
      // Read back to before it was sent; history that could not be read that far proves nothing, and after many such
      // looks the report is shown as failed rather than kept in doubt for ever.
      if (history === null) history = await this.historySince(binding.sessionId, earliest - 60_000);
      if (!history) {
        for (const item of items) { item.reconciles = (item.reconciles ?? 0) + 1; if (item.reconciles >= RECONCILES) item.report = 'failed'; }
        changed = true;
        continue;
      }
      if (history.some(message => message.role === 'user' && named(normalize(message.text)))) { for (const item of items) item.report = 'sent'; changed = true; }
      else if (Date.now() - Date.parse(items[0].reportAt ?? items[0].createdAt) > RECONCILE_MS) { for (const item of items) item.report = 'pending'; changed = true; }
    }
    return changed;
  }

  /** A session's messages back to `since`, or nothing when they could not all be read. */
  private async historySince(sessionId: string, since: number): Promise<ChatMessage[] | undefined> {
    const path = `/api/sessions/${encodeURIComponent(sessionId)}?limit=200`;
    const messages: ChatMessage[] = [];
    let before: number | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await this.options.tower.call('GET', before === undefined ? path : `${path}&before=${before}`, undefined, { write: false }).catch(() => undefined);
      if (response?.state !== 'succeeded') return undefined;
      const detail = response.body as SessionDetail;
      messages.push(...(detail.messages ?? []));
      if (!detail.hasMore || detail.nextBefore === undefined || (detail.messages ?? []).some(message => Date.parse(message.timestamp) < since)) return messages;
      before = detail.nextBefore;
    }
    return undefined;
  }

  /**
   * The answer a followed run gave: the assistant's last words after the run's own request (found by its text) and
   * before the next message the session received. It waits until the session's history has caught up with the run's
   * end. When the request cannot be found, there is no answer rather than a guess.
   */
  private async finalAnswer(item: Followed, run: Run | undefined, together: string[] = []): Promise<{ text: string; followedBy: boolean; outcome?: SessionOutcome } | undefined> {
    const prompt = normalize(run?.prompt ?? item.prompt ?? '');
    if (!prompt) return undefined;
    const path = `${item.node ? `/api/nodes/${item.node}` : '/api'}/sessions/${encodeURIComponent(item.sessionId!)}?limit=200`;
    const requested = Date.parse(run?.createdAt ?? item.createdAt) - 2000;
    const finished = run?.finishedAt ? Date.parse(run.finishedAt) : undefined;
    const latest = run?.startedAt ? Date.parse(run.startedAt) + 120_000 : (finished ?? Date.now()) + 2000;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
      const response = await this.options.tower.call('GET', path, undefined, { write: false });
      if (response.state !== 'succeeded') return undefined;
      const detail = response.body as SessionDetail;
      const updated = Date.parse(detail.session?.updatedAt ?? '');
      const caughtUp = finished === undefined ? undefined : updated >= finished - 1000;
      if (caughtUp === false) continue;
      const collected = [...(detail.messages ?? [])];
      let before = detail.hasMore ? detail.nextBefore : undefined;
      const pastStart = () => collected.some(message => Date.parse(message.timestamp) < requested);
      let unread = false;
      for (let page = 1; before !== undefined && !pastStart(); page++) {
        if (page >= 5) { unread = true; break; }
        const older = await this.options.tower.call('GET', `${path}&before=${before}`, undefined, { write: false });
        if (older.state !== 'succeeded') { unread = true; break; }
        const earlier = older.body as SessionDetail;
        collected.unshift(...(earlier.messages ?? []));
        before = earlier.hasMore ? earlier.nextBefore : undefined;
      }
      if (unread) return undefined;
      const messages = collected.sort((a: ChatMessage, b: ChatMessage) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      const candidates = messages.flatMap((message, index) => message.role === 'user' && sameRequest(message.text, prompt)
        && Date.parse(message.timestamp) >= requested && Date.parse(message.timestamp) <= latest ? [index] : []);
      if (candidates.length > 1) return undefined;
      const request = candidates[0] ?? -1;
      if (request >= 0) {
        // Messages steered into the same turn are part of this request, not the next one: each of them once.
        const steered = [...together];
        const next = messages.findIndex((message, index) => {
          if (index <= request || message.role !== 'user') return false;
          const one = steered.findIndex(other => sameRequest(message.text, other));
          if (one < 0) return true;
          steered.splice(one, 1);
          return false;
        });
        const answer = messages.slice(request + 1, next < 0 ? messages.length : next).reverse().find(message => message.role === 'assistant' && message.text.trim());
        if (answer) {
          // Outcome is a judgment of the session's latest turn, not necessarily the run we are reporting.
          const latestTurn = next < 0 && !detail.hasMore && detail.session?.status !== 'working'
            && detail.session?.messageCount === messages.length && detail.session?.lastRequestAt === messages[request].timestamp
            && !!detail.session?.lastMessage && normalize(answer.text).startsWith(normalize(detail.session.lastMessage));
          return { text: answer.text, followedBy: next >= 0, ...(latestTurn && detail.session.outcome ? { outcome: detail.session.outcome } : {}) };
        }
      }
      if (caughtUp) return undefined;
    }
    return undefined;
  }

  private remember(runId: string): void {
    if (this.file.masterRuns.includes(runId)) return;
    this.file.masterRuns.push(runId);
    if (this.file.masterRuns.length > MASTER_RUNS) this.file.masterRuns.splice(0, this.file.masterRuns.length - MASTER_RUNS);
  }

  private add(item: Followed): void { this.file.followed.push(item); }

  /** Keeps what is still followed or not yet reported, and the most recent of the rest. */
  private trim(): void {
    // A spoken request whose sending is in doubt keeps its key, so it is never sent again.
    const open = (item: Followed) => item.state === 'running' || item.report === 'pending' || item.report === 'sending' || item.report === 'uncertain'
      || (item.kind === 'spoken' && !item.runId && item.state === 'unknown');
    const done = this.file.followed.filter(item => !open(item));
    if (done.length <= FOLLOWED) return;
    const drop = new Set(done.slice(0, done.length - FOLLOWED).map(item => item.id));
    this.file.followed = this.file.followed.filter(item => !drop.has(item.id));
  }

  private save(): Promise<void> {
    if (!this.persist) return Promise.resolve();
    const text = JSON.stringify(this.file);
    const next = this.writes.then(() => writePrivateJson(this.path, text));
    this.writes = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeLive?.();
    if (this.timer) clearInterval(this.timer);
    await this.following?.catch(() => {});
    await this.writes;
  }
}

/** The run whose words answer `run`: the turn it was steered into, when it was. */
function turnOf(run: Run, snapshot: Snapshot): Run {
  const target = run.steering?.targetRunId;
  return (target && (snapshot.runs ?? []).find(entry => entry.id === target)) || run;
}

/** The key a request's timing record is kept under: a spoken request's key, or the report's own id. */
function timingKey(item: Followed): string { return item.key ?? item.id; }

/**
 * The last thing the master wrote in a turn: every text block of its last message with words, joined. Nothing when
 * the turn's replies are not whole (dropped or cut to stay small) or not there (an older worker).
 */
export function lastMessage(run: Run): string | undefined {
  const replies = run.replies;
  if (!replies || run.repliesTrimmed) return undefined;
  const message = (reply: RunReply) => reply.id.slice(0, reply.id.lastIndexOf(':'));
  const last = [...replies].reverse().find(reply => reply.text.trim());
  if (!last) return undefined;
  const text = replies.filter(reply => message(reply) === message(last) && reply.text.trim()).map(reply => reply.text.trim()).join('\n');
  return text || undefined;
}

function truncate(text: string, length: number): string { return text.length > length ? `${text.slice(0, length)}…` : text; }
function indent(text: string): string { return text.split('\n').map(line => `    ${line}`).join('\n'); }
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/**
 * A history message is the run's request when it is the request's whole text, or that text followed by the list of
 * attached files Tower adds. A longer request that merely starts the same way is another request.
 */
export function sameRequest(message: string, prompt: string): boolean {
  const text = normalize(message);
  return text === prompt || text.startsWith(`${prompt}${ATTACHED}`);
}
