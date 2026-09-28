import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MASTER_FOLDER, type MasterBinding, type MasterTaskState } from '../../shared/master.js';
import type { AutoPromptJob, ChatMessage, Provider, Run, SessionDetail, Snapshot } from '../../shared/types.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { ApiTarget } from './api-target.js';
import { REPORT_MARK, VOICE_MARK, writeMasterGuide } from './guide.js';
import type { LiveState } from './live-state.js';
import type { Table } from './read-db.js';
import type { MasterRoom } from './room.js';
import type { MasterSettingsStore } from './settings.js';
import type { TowerClient } from './tower-client.js';

const FOLLOW_MS = 5_000;
/** Work Tower cannot find for this long is reported as unknown. */
const UNKNOWN_MS = 30 * 60_000;
/** A spoken request that takes this long hears, once, that it is still being worked on. */
const STILL_WORKING_MS = 20_000;
const MASTER_RUNS = 500;
const FOLLOWED = 300;
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
  jobId?: string;
  node?: string;
  prompt?: string;
  createdAt: string;
  state: MasterTaskState;
  /** Delegated work's report. Written before it is sent; "sending" after a restart becomes "uncertain" and is not sent again. */
  report?: 'pending' | 'sending' | 'sent' | 'uncertain';
  answer?: string;
  /** The voice session a spoken request (or a report while voice is on) belongs to. */
  voice?: string;
  workingSaid?: true;
}

interface FollowFile { version: 1; baselineAt: string; masterRuns: string[]; followed: Followed[] }

/** What the voice gets from the master session. */
export interface VoiceSide {
  speaks(report: boolean): 'pending' | 'unspoken' | undefined;
  deliver(): void;
  working(origin: { key: string; session?: string }): Promise<void>;
}

export interface MasterSessionOptions {
  stateDir: string;
  dataDir: string;
  settings: MasterSettingsStore;
  tower: TowerClient;
  live: LiveState;
  /** The voice's ledger: spoken requests and what is read aloud. */
  room: MasterRoom;
  followMs?: number;
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
  private voice?: VoiceSide;
  private timer?: ReturnType<typeof setInterval>;
  private following?: Promise<void>;
  private starting?: Promise<MasterBinding>;
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: MasterSessionOptions) {
    this.folder = join(options.stateDir, MASTER_FOLDER);
    this.path = join(options.dataDir, 'follow.json');
  }

  async start(): Promise<void> {
    const saved = await readPrivateJson(this.path).catch(() => undefined) as Partial<FollowFile> | undefined;
    if (saved?.version === 1 && Array.isArray(saved.followed) && Array.isArray(saved.masterRuns) && typeof saved.baselineAt === 'string') {
      this.file = { version: 1, baselineAt: saved.baselineAt, masterRuns: saved.masterRuns.filter(id => typeof id === 'string'), followed: saved.followed.filter(item => item && typeof item.id === 'string') };
    }
    // A report that was being sent when the host stopped may have arrived: it is not sent again.
    for (const item of this.file.followed) if (item.report === 'sending') item.report = 'uncertain';
    await this.save();
    await writeMasterGuide(this.folder);
    this.timer = setInterval(() => { void this.follow(); }, this.options.followMs ?? FOLLOW_MS);
    this.timer.unref();
  }

  setVoice(voice: VoiceSide): void { this.voice = voice; }

  binding(): MasterBinding | undefined { return this.options.settings.current().session; }

  /** Work handed out and not reported yet. */
  activeTasks(): number { return this.file.followed.filter(item => item.kind === 'delegated' && (item.state === 'running' || item.report === 'pending' || item.report === 'sending')).length; }

  /** A report is on its way: a host of another build waits until it is sent. */
  busy(): boolean { return this.file.followed.some(item => item.report === 'sending'); }

  /** The work handed out, as tower_query shows it. */
  delegatedTable(): Table {
    return { name: 'delegated', columns: ['id', 'title', 'state', 'session_id', 'node', 'created_at'],
      rows: this.file.followed.filter(item => item.kind === 'delegated').map(item => [item.id, item.title, item.state, item.sessionId ?? null, item.node ?? null, item.createdAt]) };
  }

  /**
   * Starts the master session with the owner's first message: a new session in the master's folder, with its guide.
   * `replace` starts a new one in place of the current (another provider, a fresh conversation); the old one stays an
   * ordinary session. A start whose answer was lost is not tried again: the owner sees it in the session list.
   */
  begin(input: { provider: Provider; text: string; model?: string; effort?: string; replace?: boolean }): Promise<MasterBinding> {
    if (this.starting) throw Object.assign(new Error('마스터 세션을 시작하는 중입니다.'), { statusCode: 409 });
    const run = async (): Promise<MasterBinding> => {
      if (this.binding() && !input.replace) throw Object.assign(new Error('마스터 세션이 이미 있습니다.'), { statusCode: 409 });
      await writeMasterGuide(this.folder);
      const response = await this.options.tower.call('POST', '/api/sessions', { provider: input.provider, cwd: this.folder, prompt: input.text, title: '마스터',
        ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) }, { write: true });
      const created = response.body as { session?: { id?: string }; run?: Run } | undefined;
      if (response.state !== 'succeeded' || !created?.session?.id) {
        const message = (response.body as { error?: string } | undefined)?.error;
        throw Object.assign(new Error(response.state === 'uncertain'
          ? '마스터 세션을 만들었는지 알 수 없습니다. 세션 목록에서 "마스터" 세션을 확인해 주세요.'
          : `마스터 세션을 시작하지 못했습니다${message ? `: ${message}` : '.'}`), { statusCode: response.state === 'uncertain' ? 503 : response.status || 502 });
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
    if (!binding) throw Object.assign(new Error('마스터 세션이 아직 없습니다. 먼저 글로 한 번 말을 걸어 주세요.'), { statusCode: 409 });
    const prompt = `${VOICE_MARK} ${input.text}`;
    this.options.room.add({ kind: 'owner', text: input.text, voice: true });
    const response = await this.options.tower.call('POST', `/api/sessions/${encodeURIComponent(binding.sessionId)}/messages`, { prompt }, { write: true });
    const run = (response.body as { run?: Run } | undefined)?.run;
    if (response.state !== 'succeeded' || !run?.id) throw Object.assign(new Error((response.body as { error?: string } | undefined)?.error ?? '마스터 세션에 보내지 못했습니다.'), { statusCode: response.status || 503 });
    this.remember(run.id);
    this.add({ id: randomUUID(), kind: 'spoken', title: truncate(input.text, 80), sessionId: binding.sessionId, runId: run.id, prompt, createdAt: new Date().toISOString(), state: 'running', voice: input.voiceSession });
    await this.save();
  }

  /** Work a tower_api call started (a new session, a message, an Auto Prompt), followed so its end is reported. */
  async started(target: ApiTarget, body: Record<string, unknown> | undefined, answer: unknown): Promise<void> {
    const value = (answer ?? {}) as { session?: { id?: string }; run?: { id?: string; sessionId?: string }; job?: { id?: string }; result?: { job?: { id?: string } } };
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
    this.add({ id: randomUUID(), kind: 'delegated', title, ...found, ...(target.node ? { node: target.node } : {}), ...(prompt ? { prompt } : {}), createdAt: new Date().toISOString(), state: 'running' });
    await this.save();
    this.options.onChange?.();
  }

  /** One look at Tower: new work the master handed out, work that ended, reports to send and answers to read. */
  follow(): Promise<void> {
    return this.following ??= this.followOnce().catch(error => {
      console.error(`Master could not follow its work: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.following = undefined; });
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
      if (where && await this.check(item, where)) changed = true;
    }
    if (await this.sendReports(binding)) changed = true;
    if (changed) { this.trim(); await this.save(); this.options.onChange?.(); }
  }

  /** Runs of the master session, and the work its turns handed out through Tower's own tools. */
  private discover(snapshot: Snapshot, binding: MasterBinding): boolean {
    let changed = false;
    for (const run of snapshot.runs ?? []) if (run.sessionId === binding.sessionId && !this.file.masterRuns.includes(run.id)) { this.remember(run.id); changed = true; }
    const ours = (origin: Run['origin']) => origin?.kind === 'agent' && !!origin.runId && this.file.masterRuns.includes(origin.runId);
    const after = (at: string) => Date.parse(at) >= Date.parse(this.file.baselineAt);
    // Jobs first: a job's run is the same work, found through the job.
    for (const job of snapshot.autoPrompts ?? []) {
      const known = this.file.followed.find(item => item.jobId === job.id);
      if (known && job.runId && !known.runId) { known.runId = job.runId; if (job.sessionId) known.sessionId = job.sessionId; changed = true; }
      if (known || !ours(job.origin) || !after(job.createdAt) || this.file.followed.some(item => job.runId && item.runId === job.runId)) continue;
      this.add({ id: randomUUID(), kind: 'delegated', title: truncate(job.prompt, 80), jobId: job.id, ...(job.runId ? { runId: job.runId } : {}), ...(job.sessionId ? { sessionId: job.sessionId } : {}), prompt: job.prompt, createdAt: job.createdAt, state: 'running' });
      changed = true;
    }
    for (const run of snapshot.runs ?? []) {
      if (!ours(run.origin) || !after(run.createdAt) || run.sessionId === binding.sessionId || this.file.followed.some(item => item.runId === run.id)) continue;
      this.add({ id: randomUUID(), kind: 'delegated', title: truncate(run.prompt, 80), runId: run.id, sessionId: run.sessionId, prompt: run.prompt, createdAt: run.createdAt, state: 'running' });
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
      run = (snapshot.runs ?? []).find(entry => entry.id === item.runId);
      if (run && (run.status === 'completed' || run.status === 'error' || run.status === 'cancelled')) ended = run.status;
    }
    if (!ended && Date.now() - Date.parse(item.createdAt) > UNKNOWN_MS && !run && !(item.jobId && !item.runId && (snapshot.autoPrompts ?? []).some(entry => entry.id === item.jobId))) ended = 'unknown';
    if (!ended) {
      if (item.kind === 'spoken' && !item.workingSaid && run?.status === 'running' && Date.now() - Date.parse(item.createdAt) > STILL_WORKING_MS) {
        item.workingSaid = true;
        void this.voice?.working({ key: item.id, ...(item.voice ? { session: item.voice } : {}) });
        return true;
      }
      return false;
    }
    const found = item.sessionId && ended !== 'unknown' ? await this.finalAnswer(item, run).catch(() => undefined) : undefined;
    item.state = ended;
    if (found?.text) item.answer = truncate(found.text, 3000);
    if (item.kind === 'delegated') {
      item.report = 'pending';
      if (!found && run?.error) item.answer = `Error: ${truncate(run.error, 500)}`;
    } else this.speak(item, ended);
    return true;
  }

  /** A spoken request's answer, or the answer to a report while voice is on, handed to the voice to read aloud. */
  private speak(item: Followed, ended: MasterTaskState): void {
    const voice = this.voice;
    if (!voice) return;
    const report = item.kind === 'report';
    const state = voice.speaks(report);
    if (!state) return;
    const speak = { state, ...(item.voice && !report ? { session: item.voice } : {}) };
    if (ended === 'completed' && item.answer) this.options.room.add(report ? { kind: 'event', text: item.answer, speak } : { kind: 'master', text: item.answer, turnId: item.id, final: true, speak });
    else this.options.room.add({ kind: 'error', text: ended === 'cancelled' ? '요청이 멈췄습니다.' : '요청에 답하지 못했습니다. 마스터 창에서 확인해 주세요.', speak });
    voice.deliver();
  }

  /** Every report waiting goes to the master session in one message. Nothing is sent twice. */
  private async sendReports(binding: MasterBinding): Promise<boolean> {
    const waiting = this.file.followed.filter(item => item.kind === 'delegated' && item.report === 'pending');
    if (!waiting.length) return false;
    const lines = waiting.map(item => `- "${item.title}" — ${item.state}${item.sessionId ? ` (session ${item.sessionId}${item.node ? ` on node ${item.node}` : ''})` : ''}`
      + (item.answer ? `\n  Its answer:\n${indent(item.answer)}` : '\n  Its answer could not be read; the owner can open the session.'));
    const prompt = `${REPORT_MARK} Work you handed out ended:\n${lines.join('\n')}`;
    for (const item of waiting) item.report = 'sending';
    await this.save();
    const response = await this.options.tower.call('POST', `/api/sessions/${encodeURIComponent(binding.sessionId)}/messages`, { prompt }, { write: true })
      .catch(() => ({ state: 'uncertain' as const, status: 0, body: undefined }));
    const run = (response.body as { run?: Run } | undefined)?.run;
    for (const item of waiting) item.report = response.state === 'succeeded' ? 'sent' : response.state === 'uncertain' ? 'uncertain' : 'pending';
    if (response.state === 'succeeded' && run?.id) {
      this.remember(run.id);
      this.add({ id: randomUUID(), kind: 'report', title: 'report', sessionId: binding.sessionId, runId: run.id, prompt, createdAt: new Date().toISOString(), state: 'running' });
    }
    return true;
  }

  /**
   * The answer a followed run gave: the assistant's last words after the run's own request (found by its text) and
   * before the next message the session received. It waits until the session's history has caught up with the run's
   * end. When the request cannot be found, there is no answer rather than a guess.
   */
  private async finalAnswer(item: Followed, run: Run | undefined): Promise<{ text: string; followedBy: boolean } | undefined> {
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
        const next = messages.findIndex((message, index) => index > request && message.role === 'user');
        const answer = messages.slice(request + 1, next < 0 ? messages.length : next).reverse().find(message => message.role === 'assistant' && message.text.trim());
        if (answer) return { text: answer.text, followedBy: next >= 0 };
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
    const open = (item: Followed) => item.state === 'running' || item.report === 'pending' || item.report === 'sending';
    const done = this.file.followed.filter(item => !open(item));
    if (done.length <= FOLLOWED) return;
    const drop = new Set(done.slice(0, done.length - FOLLOWED).map(item => item.id));
    this.file.followed = this.file.followed.filter(item => !drop.has(item.id));
  }

  private save(): Promise<void> {
    const text = JSON.stringify(this.file);
    const next = this.writes.then(() => writePrivateJson(this.path, text));
    this.writes = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.following?.catch(() => {});
    await this.writes;
  }
}

function truncate(text: string, length: number): string { return text.length > length ? `${text.slice(0, length)}…` : text; }
function indent(text: string): string { return text.split('\n').map(line => `    ${line}`).join('\n'); }
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/**
 * A history message is the run's request when it is the request's whole text, or that text followed by the list of
 * attached files Tower adds. A longer request that merely starts the same way is another request.
 */
function sameRequest(message: string, prompt: string): boolean {
  const text = normalize(message);
  return text === prompt || text.startsWith(`${prompt}${ATTACHED}`);
}
