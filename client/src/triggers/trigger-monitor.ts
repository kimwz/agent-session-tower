import type { SlackWorkflow } from '../../../shared/slack';
import type { TriggerEvent, TriggerOverview } from '../../../shared/triggers';
import { parseSlackPosition, SLACK_POSITION_KEY } from '../graph/slack-graph';

/** One lane on the canvas for everything triggers do, Slack mentions included. */
export const TRIGGER_MONITOR_ID = 'trigger:monitor';
export const TRIGGER_POSITION_KEY = 'tower.trigger-monitor.position.v1';
export const TRIGGER_READ_KEY = 'tower.trigger-read.v1';
/** When this browser first showed the monitor; runs that finished before then start out read. */
export const TRIGGER_READ_SINCE_KEY = 'tower.trigger-read-since.v1';

export type MonitorItem =
  | { kind: 'slack'; id: string; at: string; event: SlackWorkflow }
  | { kind: 'trigger'; id: string; at: string; event: TriggerEvent };

const WORKING = new Set<TriggerEvent['status']>(['queued', 'claimed', 'running']);
export const triggerEventWorking = (event: Pick<TriggerEvent, 'status'>) => WORKING.has(event.status);

/** Runs that were skipped or merged into another are only history; the canvas shows what ran or failed. */
export const laneWorthy = (event: TriggerEvent) => event.status !== 'skipped' && event.status !== 'coalesced';

/** A finished run with a result to look at; seeing it once marks that result read. */
export function triggerEventRevision(event: Pick<TriggerEvent, 'status' | 'updatedAt'>): string {
  return event.status === 'completed' || event.status === 'error' || event.status === 'uncertain' ? `${event.status}:${event.updatedAt}` : '';
}

/** Newest first across both sources; a selected item stays visible even when it is older than the page. */
export function monitorItems(slack: SlackWorkflow[], triggers: TriggerEvent[], limit: number, selected?: string | null): MonitorItem[] {
  const all: MonitorItem[] = [
    ...slack.map(event => ({ kind: 'slack' as const, id: event.id, at: event.createdAt, event })),
    ...triggers.map(event => ({ kind: 'trigger' as const, id: event.id, at: event.receivedAt, event })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const shown = all.slice(0, limit);
  const chosen = selected ? all.find(item => item.id === selected) : undefined;
  if (chosen && !shown.includes(chosen)) shown.push(chosen);
  return shown;
}

/** The lane appears once Slack is connected or any trigger exists or has run. */
export function monitorVisible(slackConnected: boolean, overview: TriggerOverview | undefined): boolean {
  return slackConnected || !!overview?.triggers.some(item => item.kind !== 'slack' && item.kind !== 'public') || !!overview?.recent.length;
}

/** Where the lane was left; the Slack monitor's saved place carries over once, into the lane's own key. */
export function readMonitorPosition(storage: Pick<Storage, 'getItem' | 'setItem'>): { x: number; y: number } | null {
  const own = parseSlackPosition(storage.getItem(TRIGGER_POSITION_KEY));
  if (own) return own;
  const earlier = parseSlackPosition(storage.getItem(SLACK_POSITION_KEY));
  if (earlier) { try { storage.setItem(TRIGGER_POSITION_KEY, JSON.stringify(earlier)); } catch { /* Still usable for this visit. */ } }
  return earlier;
}

/** Merges two lists of runs; of two copies of a run the later update wins, and on a tie the first list's. */
export function mergeTriggerEvents(recent: TriggerEvent[], older: TriggerEvent[]): TriggerEvent[] {
  const byId = new Map<string, TriggerEvent>();
  for (const event of older) byId.set(event.id, event);
  for (const event of recent) { const other = byId.get(event.id); if (!other || event.updatedAt >= other.updatedAt) byId.set(event.id, event); }
  return [...byId.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id));
}

const KEPT = 500;
/** At most 500 runs stay loaded; runs still working always stay, so their cards keep updating. */
export function keepTriggerEvents(events: TriggerEvent[]): TriggerEvent[] {
  if (events.length <= KEPT) return events;
  const working = events.filter(triggerEventWorking);
  const room = Math.max(0, KEPT - working.length);
  const finished = new Set(events.filter(event => !triggerEventWorking(event)).slice(0, room));
  return events.filter(event => triggerEventWorking(event) || finished.has(event));
}

/**
 * Folds a snapshot into the runs already shown. When the snapshot's latest runs do not reach what is here
 * (a long disconnect), the list starts over from them so it never has a hole. Every run still working is in
 * each snapshot, so a run shown as working that is missing from it has finished and must be read again.
 */
export function reconcileSnapshot(previous: TriggerEvent[], recent: TriggerEvent[], updated: TriggerEvent[] = [], page = 20) {
  const joined = !previous.length || recent.length < page || recent.some(event => previous.some(item => item.id === event.id));
  const next = keepTriggerEvents(mergeTriggerEvents([...recent, ...updated], joined ? previous : []));
  const live = new Set([...recent, ...updated].map(event => event.id));
  const stale = next.filter(event => triggerEventWorking(event) && !live.has(event.id)).map(event => event.id);
  return { next, joined, stale };
}

/**
 * Reads runs again a few at a time until each is done. A read that fails for a moment waits before it is
 * tried again, however often the run is added meanwhile; one the worker cannot answer at all is left alone.
 * After `stop`, reads still out change nothing and schedule nothing.
 */
export class RecheckQueue {
  private readonly waiting = new Set<string>();
  private readonly active = new Set<string>();
  private readonly cooling = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly abandoned = new Set<string>();
  private epoch = 0;
  private stopped = false;
  constructor(private readonly read: (id: string, current: () => boolean) => Promise<void>,
    private readonly options: { concurrency?: number; retryMs?: number; permanent?: (error: unknown) => boolean } = {}) {}
  add(ids: Iterable<string>): void {
    if (this.stopped) return;
    for (const id of ids) if (!this.active.has(id) && !this.cooling.has(id) && !this.abandoned.has(id)) this.waiting.add(id);
    this.pump();
  }
  get busy(): number { return this.active.size; }
  get queued(): number { return this.waiting.size + this.cooling.size; }
  start(): void { this.stopped = false; }
  stop(): void {
    this.stopped = true;
    this.epoch++;
    this.waiting.clear(); this.active.clear();
    for (const timer of this.cooling.values()) clearTimeout(timer);
    this.cooling.clear();
  }
  private pump(): void {
    while (!this.stopped && this.active.size < (this.options.concurrency ?? 4) && this.waiting.size) {
      const id = this.waiting.values().next().value as string;
      const epoch = this.epoch;
      const current = () => epoch === this.epoch;
      this.waiting.delete(id);
      this.active.add(id);
      this.read(id, current).catch(error => {
        if (!current()) return;
        if (this.options.permanent?.(error)) { this.abandoned.add(id); return; }
        this.cooling.set(id, setTimeout(() => { this.cooling.delete(id); this.add([id]); }, this.options.retryMs ?? 15_000));
      }).finally(() => { if (!current()) return; this.active.delete(id); this.pump(); });
    }
  }
}

export type TriggerReadState = Record<string, string>;
export function readTriggerState(value: string | null): TriggerReadState {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter(([, revision]) => typeof revision === 'string')) as TriggerReadState : {};
  } catch { return {}; }
}
/**
 * A finished run is unread until it is opened. Runs that finished before this browser first showed the
 * monitor start out read, however they are loaded; a run still working then is unread once it finishes.
 */
export function triggerUnread(event: TriggerEvent, read: TriggerReadState, since: string | null): boolean {
  const revision = triggerEventRevision(event);
  return !!revision && since !== null && event.updatedAt > since && read[event.id] !== revision;
}
