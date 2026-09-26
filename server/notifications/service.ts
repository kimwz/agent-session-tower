import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Run, RunApproval, Session } from '../../shared/types.js';
import { DEFAULT_NOTIFICATION_EVENTS, type NotificationDevice, type NotificationEvents, type NotificationLanguage, type NotificationOverview, type NotificationPayload } from '../../shared/notifications.js';
import { httpError } from '../http/requests.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { generateVapidKeys, sendPush, type PushResult, type PushTarget, type VapidKeys } from './web-push.js';
import type { TurnAttention, TurnAttentionInput } from './attention.js';

export type NotificationKind = keyof NotificationEvents;
export interface NotificationEvent { key: string; kind: NotificationKind; at: number; run: Run; approval?: RunApproval }
/** What a notification says happened; the page's words for it depend on the device language. */
export type NotificationVariant = 'done' | 'failed' | 'needsOwner' | 'blocked' | 'question' | 'approval' | 'started';
/** How the web process describes the work a notification is about. */
export interface NotificationContext {
  runs(): readonly Run[];
  session(id: string): Session | undefined;
  /** The name the page shows for a conversation's project. */
  project(session: Session): string;
  trigger(id: string): string | undefined;
  /**
   * Whether a finished turn needs the owner now, when fast judgments are set up; undefined keeps every finished
   * turn announced. A failure or a slow answer announces the turn as before.
   */
  attention?(input: TurnAttentionInput, signal: AbortSignal): Promise<TurnAttention | undefined>;
}
interface Device extends NotificationDevice { endpoint: string; keys: PushTarget['keys'] }
interface Saved { vapid: VapidKeys; devices: Device[]; delivered?: { since: string; keys: string[] } }

const SUBJECT = 'https://github.com/kimwz/agent-session-tower';
const MAX_DEVICES = 20;
const KEPT_KEYS = 500;
/** Work that finished while the web server was down is still announced when it comes back, unless it is this old. */
const CATCH_UP_MS = 60 * 60_000;
/** Status reports reach this process a moment after the worker records them. */
const ARRIVAL_MS = 60_000;
/** A judgment that takes longer than this is skipped and the turn announced as before. */
const ATTENTION_MS = 6_000;
const CLOSE_WAIT_MS = 2_000;
const B64URL = /^[A-Za-z0-9_-]+$/;

export const deviceId = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

/** A queued message the owner inserted into a running turn became part of it and ends with it. */
const merged = (run: Run) => run.steering?.state === 'delivered';

/**
 * What to announce: turns you started that finished, each trigger event's first run as it starts, and every
 * approval or question a conversation waits on. Agent-started, Slack and trigger turns finishing are not announced;
 * cancelled turns were stopped by someone. A message inserted into a running turn is announced with that turn.
 */
export function pendingEvents(runs: readonly Run[], cutoff: number, handled: ReadonlySet<string>, now = Date.now()): NotificationEvent[] {
  const events: NotificationEvent[] = [];
  for (const run of runs) {
    if (run.origin?.kind === 'owner' && (run.status === 'completed' || run.status === 'error') && run.finishedAt && !merged(run)) {
      events.push({ key: `done:${run.id}`, kind: 'runCompleted', at: Date.parse(run.finishedAt), run });
    } else if (run.origin?.kind === 'trigger' && run.origin.triggerId && run.startedAt && run.status !== 'queued' && run.status !== 'cancelled') {
      events.push({ key: `trigger:${run.origin.triggerId}:${run.origin.eventId ?? run.id}`, kind: 'triggerStarted', at: Date.parse(run.startedAt), run });
    }
    // Whoever started it, only the owner can answer; approvals carry no time of their own, so they count as new now.
    if (run.status === 'running') for (const approval of run.approvals ?? []) events.push({ key: `wait:${run.id}:${approval.id}`, kind: 'runWaiting', at: now, run, approval });
  }
  const seen = new Set(handled);
  return events.filter(event => event.at > cutoff).sort((a, b) => a.at - b.at)
    .filter(event => !seen.has(event.key) && seen.add(event.key));
}

/**
 * The turn is not where the conversation stands: a continuation it scheduled, a message sent while it ran that ran
 * after it, or anything the owner sent after it ended (they have seen it). Judged from how the runs relate rather
 * than from what runs now, so it still holds after that next turn ends or a restart. A message cancelled before it
 * started continued nothing. Work an agent, a trigger or Slack put into the conversation does not count.
 */
export function followedUp(run: Run, runs: readonly Run[]): boolean {
  const finished = run.finishedAt;
  const later = (other: Run) => !!finished && (other.createdAt > finished
    || (other.createdAt >= run.createdAt && (other.startedAt === undefined ? other.status === 'queued' : other.startedAt >= finished)));
  // Only the owner's own next turn counts: it is announced in turn, and only the owner sending one shows they saw this.
  return runs.some(other => other.id !== run.id && other.sessionId === run.sessionId && !merged(other) && other.origin?.kind === 'owner'
    && (other.scheduled?.afterRunId === run.id || later(other)));
}

/** The request a turn works on: a scheduled continuation goes back to the turn that scheduled it, with messages inserted along the way. */
export function turnRequest(run: Run, runs: readonly Run[]): string {
  const byId = new Map(runs.map(item => [item.id, item]));
  const chain = [run];
  for (let hops = 0; chain[0].scheduled && hops < 20; hops++) {
    const previous = byId.get(chain[0].scheduled.afterRunId);
    if (!previous) break;
    chain.unshift(previous);
  }
  const turns = new Set(chain.map(item => item.id));
  const inserted = runs.filter(item => merged(item) && turns.has(item.steering!.targetRunId)).map(item => item.prompt);
  return [chain[0].prompt, ...inserted].join('\n\n');
}

const clip = (value: string, length: number) => {
  const text = value.replace(/<[^>]*>/g, ' ').replace(/[#*`>_\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

const TITLES: Record<NotificationVariant, [string, string]> = {
  done: ['작업 완료', 'Task finished'], failed: ['작업 실패', 'Task failed'], needsOwner: ['확인 필요', 'Needs you'],
  blocked: ['진행 막힘', 'Blocked'], question: ['답변 필요', 'Question for you'], approval: ['승인 필요', 'Approval needed'], started: ['트리거 시작', 'Trigger started'],
};
function waitingDetail(approval: RunApproval): string {
  const interaction = approval.interaction;
  if (interaction?.type === 'questions') return interaction.questions.map(question => question.question || question.header).filter(Boolean).join(' / ');
  return approval.description || approval.toolName;
}

export function notificationMessage(event: NotificationEvent, context: NotificationContext, language: NotificationLanguage, variant: NotificationVariant = defaultVariant(event)): NotificationPayload {
  const { run } = event;
  const session = context.session(run.sessionId);
  const project = session ? context.project(session) : '';
  const conversation = clip(session?.customTitle || session?.agentName || session?.title || run.prompt, 80);
  const url = `/?session=${encodeURIComponent(session?.id ?? run.sessionId)}`;
  const ko = language === 'ko';
  const status = TITLES[variant][ko ? 0 : 1];
  if (event.kind === 'triggerStarted') {
    const name = context.trigger(run.origin!.triggerId!) || (ko ? '트리거' : 'Trigger');
    return { title: `${status} · ${name}`, body: [project, clip(run.prompt, 140)].filter(Boolean).join(' — '), url, tag: event.key };
  }
  const detail = clip(event.approval ? waitingDetail(event.approval) : run.status === 'error' ? run.error || '' : run.output, 160);
  return { title: project ? `${project} · ${status}` : status, body: [conversation, detail].filter(Boolean).join('\n'), url, tag: `session:${session?.id ?? run.sessionId}` };
}
function defaultVariant(event: NotificationEvent): NotificationVariant {
  if (event.kind === 'triggerStarted') return 'started';
  if (event.approval) return event.approval.interaction?.type === 'questions' ? 'question' : 'approval';
  return event.run.status === 'error' ? 'failed' : 'done';
}

function validDevice(value: unknown): value is Device {
  const device = value as Device;
  return !!device && typeof device === 'object' && typeof device.endpoint === 'string' && typeof device.id === 'string'
    && typeof device.keys?.p256dh === 'string' && typeof device.keys?.auth === 'string' && typeof device.label === 'string'
    && (device.language === 'ko' || device.language === 'en') && typeof device.events?.runCompleted === 'boolean'
    && typeof device.events?.triggerStarted === 'boolean' && (device.events.runWaiting === undefined || typeof device.events.runWaiting === 'boolean')
    && typeof device.createdAt === 'string';
}

function parseEvents(value: unknown, fallback: NotificationEvents): NotificationEvents {
  if (value === undefined) return fallback;
  const events = value as Record<string, unknown>;
  if (!events || typeof events !== 'object' || Object.keys(events).some(key => !(key in DEFAULT_NOTIFICATION_EVENTS)) || Object.values(events).some(item => typeof item !== 'boolean')) {
    throw httpError(400, '알림 종류 설정이 올바르지 않습니다.');
  }
  return { ...fallback, ...events as Partial<NotificationEvents> };
}
function parseLanguage(value: unknown, fallback: NotificationLanguage): NotificationLanguage {
  if (value === undefined) return fallback;
  if (value !== 'ko' && value !== 'en') throw httpError(400, '알림 언어가 올바르지 않습니다.');
  return value;
}
function parseLabel(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : 'Browser';
}

/** Browser push notifications for this Tower's owner. The web process watches runs; push services deliver. */
export class NotificationService {
  private readonly path: string;
  private saved?: Saved;
  /** Events handled for good: sent, or decided not to send. Saved, so a restart does not handle them again. */
  private delivered = new Set<string>();
  /** Events being decided or sent right now, with when they happened. Not saved: after a restart they are decided again. */
  private readonly judging = new Map<string, number>();
  private readonly processing = new Set<Promise<void>>();
  private cutoff = Date.now();
  private writes: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private lastSave = 0;
  private closed = false;
  /** Past the shutdown grace: anything still going neither sends, records nor saves; the next start takes it up. */
  private stopped = false;

  constructor(private readonly stateDir: string, private readonly context: NotificationContext, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    this.path = join(stateDir, 'notifications.json');
  }

  async start(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    let raw: unknown;
    try { raw = await readPrivateJson(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const saved = raw as Partial<Saved> | undefined;
    const vapid = saved?.vapid;
    const validKeys = !!vapid && typeof vapid.publicKey === 'string' && typeof vapid.privateKey === 'string' && B64URL.test(vapid.publicKey) && B64URL.test(vapid.privateKey);
    // New keys would leave every existing subscription unusable, so they come only with a fresh list.
    this.saved = validKeys
      // Devices saved before an event kind existed receive it, as a new device would.
      ? { vapid: vapid!, devices: Array.isArray(saved!.devices) ? saved!.devices.filter(validDevice).map(device => ({ ...device, events: { ...DEFAULT_NOTIFICATION_EVENTS, ...device.events } })) : [], ...(saved!.delivered ? { delivered: saved!.delivered } : {}) }
      : { vapid: generateVapidKeys(), devices: [] };
    const since = Date.parse(this.saved.delivered?.since ?? '');
    const now = this.now();
    this.cutoff = Number.isFinite(since) ? Math.max(since - ARRIVAL_MS, now - CATCH_UP_MS) : now;
    this.delivered = new Set(Array.isArray(this.saved.delivered?.keys) ? this.saved.delivered.keys.filter(key => typeof key === 'string') : []);
    if (!validKeys) await this.save();
    this.check();
  }

  /** Called whenever runs change; checks shortly after, once for a burst of changes. */
  changed(): void {
    if (this.closed || this.timer || !this.saved) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.check(); }, 300);
    this.timer.unref?.();
  }

  check(): void {
    if (this.closed || !this.saved) return;
    const handled = new Set([...this.delivered, ...this.judging.keys()]);
    const events = pendingEvents(this.context.runs(), this.cutoff, handled, this.now());
    for (const event of events) {
      this.judging.set(event.key, event.at);
      const work = this.handle(event).catch(error => console.error(`A notification was not sent: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          if (this.stopped) return;
          this.judging.delete(event.key);
          this.delivered.add(event.key);
          this.processing.delete(work);
          void this.save().catch(error => console.error(`Notification state was not saved: ${error instanceof Error ? error.message : String(error)}`));
        });
      this.processing.add(work);
    }
    // The mark moves forward even when nothing happened, so a restart does not announce old work again.
    if (this.now() - this.lastSave > 60_000) void this.save().catch(error => console.error(`Notification state was not saved: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Decides whether an event still deserves a push, then sends it to the devices that chose its kind. */
  private async handle(event: NotificationEvent): Promise<void> {
    const variant = await this.variant(event);
    if (variant && !this.stopped) await this.deliver(event, variant);
  }

  private async variant(event: NotificationEvent): Promise<NotificationVariant | undefined> {
    if (event.kind === 'triggerStarted') return 'started';
    const current = () => this.context.runs().find(run => run.id === event.run.id);
    if (event.approval) {
      const approval = event.approval;
      const now = current();
      return now?.status === 'running' && now.approvals?.some(item => item.id === approval.id) ? defaultVariant(event) : undefined;
    }
    const { run } = event;
    // A failure is always news, even when another message already waits.
    if (run.status === 'error') return 'failed';
    if (followedUp(run, this.context.runs())) return undefined;
    let judged: TurnAttention | undefined;
    if (this.context.attention) {
      const session = this.context.session(run.sessionId);
      const signal = AbortSignal.timeout(ATTENTION_MS);
      const input: TurnAttentionInput = { request: turnRequest(run, this.context.runs()), reply: run.output,
        conversation: session?.customTitle || session?.agentName || session?.title || '', project: session ? this.context.project(session) : '' };
      judged = await Promise.race([
        this.context.attention(input, signal).catch(() => undefined),
        new Promise<undefined>(resolve => { setTimeout(() => resolve(undefined), ATTENTION_MS + 500).unref?.(); }),
      ]);
    }
    // The owner may have sent the next message while this was being judged.
    if (followedUp(run, this.context.runs())) return undefined;
    if (judged?.quiet) return undefined;
    return judged?.outcome === 'needsOwner' ? 'needsOwner' : judged?.outcome === 'blocked' ? 'blocked' : 'done';
  }

  overview(): NotificationOverview {
    const saved = this.ready();
    return { publicKey: saved.vapid.publicKey, devices: saved.devices.map(({ endpoint: _, keys: __, ...device }) => device) };
  }

  async subscribe(body: Record<string, unknown>): Promise<NotificationOverview> {
    const saved = this.ready();
    if (Object.keys(body).some(key => !['subscription', 'label', 'language', 'events'].includes(key))) throw httpError(400, '알림 구독 요청 형식이 올바르지 않습니다.');
    const subscription = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
    const endpoint = subscription?.endpoint, p256dh = subscription?.keys?.p256dh, auth = subscription?.keys?.auth;
    let url: URL | undefined;
    try { url = typeof endpoint === 'string' && endpoint.length <= 2048 ? new URL(endpoint) : undefined; } catch { /* Checked below. */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || typeof p256dh !== 'string' || typeof auth !== 'string'
      || !B64URL.test(p256dh) || !B64URL.test(auth) || Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) {
      throw httpError(400, '브라우저 알림 구독 정보가 올바르지 않습니다.');
    }
    const id = deviceId(endpoint as string);
    const existing = saved.devices.find(device => device.id === id);
    const device: Device = {
      id, endpoint: endpoint as string, keys: { p256dh, auth }, label: parseLabel(body.label),
      language: parseLanguage(body.language, existing?.language ?? 'ko'),
      events: parseEvents(body.events, existing?.events ?? DEFAULT_NOTIFICATION_EVENTS),
      createdAt: existing?.createdAt ?? new Date(this.now()).toISOString(),
    };
    if (!existing && saved.devices.length >= MAX_DEVICES) throw httpError(409, `알림 기기는 최대 ${MAX_DEVICES}개까지 등록할 수 있습니다. 사용하지 않는 기기를 먼저 삭제하세요.`);
    saved.devices = existing ? saved.devices.map(item => item.id === id ? device : item) : [...saved.devices, device];
    await this.save();
    return this.overview();
  }

  async update(body: Record<string, unknown>): Promise<NotificationOverview> {
    const saved = this.ready();
    if (Object.keys(body).some(key => !['id', 'events', 'language'].includes(key))) throw httpError(400, '알림 설정 요청 형식이 올바르지 않습니다.');
    const device = saved.devices.find(item => item.id === body.id);
    if (!device) throw httpError(404, '알림 기기를 찾을 수 없습니다.');
    device.events = parseEvents(body.events, device.events);
    device.language = parseLanguage(body.language, device.language);
    await this.save();
    return this.overview();
  }

  async remove(body: Record<string, unknown>): Promise<NotificationOverview> {
    const saved = this.ready();
    if (Object.keys(body).some(key => key !== 'id') || typeof body.id !== 'string') throw httpError(400, '삭제할 알림 기기를 지정하세요.');
    saved.devices = saved.devices.filter(item => item.id !== body.id);
    await this.save();
    return this.overview();
  }

  async test(body: Record<string, unknown>): Promise<NotificationOverview> {
    const saved = this.ready();
    if (Object.keys(body).some(key => key !== 'id') || typeof body.id !== 'string') throw httpError(400, '테스트할 알림 기기를 지정하세요.');
    const device = saved.devices.find(item => item.id === body.id);
    if (!device) throw httpError(404, '알림 기기를 찾을 수 없습니다.');
    const ko = device.language === 'ko';
    const result = await this.send(device, { title: 'Agent Session Tower', body: ko ? '이 기기에서 알림을 받을 수 있습니다.' : 'This device can receive notifications.', url: '/', tag: 'test' });
    if (result !== 'sent') throw httpError(502, device.lastError || '알림을 보내지 못했습니다.');
    return this.overview();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    // Shutting down waits a moment for pushes being decided or sent. Any still going stay unhandled in the saved
    // state, so the next start takes them up again rather than losing them.
    // The wait keeps the process alive: shutdown must not end before the state below is saved.
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.processing]), new Promise(resolve => { grace = setTimeout(resolve, CLOSE_WAIT_MS); })]);
    clearTimeout(grace);
    this.stopped = true;
    if (this.saved) await this.save().catch(() => {});
    await this.writes;
  }

  private ready(): Saved {
    if (!this.saved) throw httpError(503, '알림을 사용할 수 없습니다.');
    return this.saved;
  }

  private async deliver(event: NotificationEvent, variant: NotificationVariant): Promise<void> {
    const devices = this.saved!.devices.filter(device => device.events[event.kind]);
    await Promise.all(devices.map(device => this.send(device, notificationMessage(event, this.context, device.language, variant))));
  }

  private async send(device: Device, payload: NotificationPayload): Promise<PushResult> {
    let result: PushResult;
    let error = '';
    try { result = await sendPush(device, payload, this.saved!.vapid, SUBJECT, this.fetcher); }
    catch (cause) { result = 'failed'; error = cause instanceof Error ? cause.message : String(cause); }
    // The browser dropped this subscription; it subscribes again the next time its page opens.
    if (this.stopped) return result;
    if (result === 'gone') this.saved!.devices = this.saved!.devices.filter(item => item.id !== device.id);
    else if (result === 'sent') { device.lastSentAt = new Date(this.now()).toISOString(); delete device.lastError; }
    else device.lastError = error || '푸시 서비스가 알림을 거부했습니다.';
    if (result !== 'sent') await this.save().catch(() => {});
    return result;
  }

  private save(): Promise<void> {
    const saved = this.saved!;
    this.lastSave = this.now();
    const kept = [...this.delivered].slice(-KEPT_KEYS);
    this.delivered = new Set(kept);
    // Events still being decided are not handled yet: the mark stays before them so a restart takes them up again.
    const since = Math.min(this.now(), ...this.judging.values());
    saved.delivered = { since: new Date(since).toISOString(), keys: kept };
    const data = `${JSON.stringify(saved)}\n`;
    const write = this.writes.then(() => writePrivateJson(this.path, data));
    this.writes = write.catch(() => {});
    return write;
  }
}
