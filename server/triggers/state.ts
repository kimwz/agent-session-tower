import { randomUUID } from 'node:crypto';
import { TriggerSettingsSchema, upgradeWatch, TriggerInputSchema, OnceConsumptionSchema, type OnceConsumption, type Trigger, type TriggerAuditEntry, type TriggerEvent, type TriggerSettings } from '../../shared/triggers.js';
import { logTrigger } from './audit.js';
import type { GitHubCursor } from './github.js';
import type { ConditionState } from './http.js';
import { MAX_AUDIT } from './limits.js';
import { normalizeOnce, readLedger } from './once.js';
import { decodeOnceTrigger, encodeOnceTrigger } from './once-storage.js';

/** Where a trigger stands between firings. */
export interface Cursor {
  anchorAt: number; nextAt?: number; lastSlot?: number; paused?: { reason: string; at: string }; turnedOffAt?: number;
  /** HTTP: what the last response looked like, for `changed` and `match`. */
  observed?: ConditionState;
  /** HTTP: a request claimed for this time; if Tower stops before it answers, it is not sent again. */
  polling?: { slot: number; revision: number; method: 'GET' | 'POST' };
  failures?: number;
  lastError?: string;
  /** GitHub: what the last complete check saw. */
  github?: GitHubCursor;
  /** GitHub's rate limit allows no request before this time, manual checks included. */
  blockedUntil?: number;
}
export interface EngineState {
  version: 1;
  /** Durable consumption is independent of definition deletion and history retention. */
  onceConsumed: Record<string, OnceConsumption>;
  triggers: Trigger[];
  /** Earlier revisions per trigger, oldest first. */
  revisions: Record<string, Trigger[]>;
  tombstones: Trigger[];
  cursors: Record<string, Cursor>;
  events: TriggerEvent[];
  /** `${triggerId} ${dedupKey}` → when it fired. Kept apart from event history so pruning history never refires. */
  fired: Record<string, string>;
  audit: TriggerAuditEntry[];
  settings: TriggerSettings;
  /** Folders the owner chose for a trigger; only these receive the native folder trust prompt answer. */
  trustedFolders: string[];
  /** Every firing in the last hour, kept apart from event history so trimming history never lifts a limit. */
  recentFires: Array<{ at: number; triggerId: string }>;
  /** Secret id → triggers the owner gave it to. Saved with the definitions, so a change and its grant commit together. */
  secretGrants: Record<string, string[]>;
}

const MAX_EVENTS = 500;
const FIRED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const KEEP_FULL_INPUT = 100;
export const UNFINISHED = new Set<TriggerEvent['status']>(['queued', 'claimed', 'running']);
export const ACTIVE = new Set<TriggerEvent['status']>(['claimed', 'running']);

export const empty = (): EngineState => ({ version: 1, onceConsumed: {}, triggers: [], revisions: {}, tombstones: [], cursors: {}, events: [], fired: {}, audit: [], secretGrants: {},
  settings: TriggerSettingsSchema.parse({}), trustedFolders: [], recentFires: [] });

/**
 * The saved file's text. A once reservation is stored the way a 1.105.0 engine reads as a turned-off cron that never
 * fires (see once-storage.ts), with its consumption projected onto each copy of the definition.
 */
export function serializeState(draft: EngineState): string {
  const encode = (trigger: Trigger) => encodeOnceTrigger({ ...trigger, ...(draft.onceConsumed[trigger.id] ? { consumed: { ...draft.onceConsumed[trigger.id] } } : {}) });
  return JSON.stringify({ ...draft, triggers: draft.triggers.map(encode), tombstones: draft.tombstones.map(encode),
    revisions: Object.fromEntries(Object.entries(draft.revisions).map(([id, list]) => [id, list.map(encode)])) });
}

/** Trims what a commit saves: old firings, finished history, payloads and grants of gone triggers. */
export function pruneState(state: EngineState, now: () => number): void {
  state.recentFires = state.recentFires.filter(item => item.at > now() - 60 * 60 * 1000);
  const known = new Set([...state.triggers, ...state.tombstones].map(trigger => trigger.id));
  for (const id of Object.keys(state.cursors)) if (!known.has(id)) delete state.cursors[id];
  const cutoff = now() - FIRED_RETENTION_MS;
  for (const [key, at] of Object.entries(state.fired)) if (Date.parse(at) < cutoff) delete state.fired[key];
  const finished = state.events.filter(event => !UNFINISHED.has(event.status));
  if (finished.length > MAX_EVENTS) {
    const drop = new Set(finished.slice(0, finished.length - MAX_EVENTS).map(event => event.id));
    state.events = state.events.filter(event => !drop.has(event.id));
  }
  // Once a run was handed over (or never will be), only a short trace of the response it saw is kept.
  for (const event of state.events) {
    if (event.payload === undefined || event.status === 'queued' || event.status === 'claimed') continue;
    const { status, url, selected } = event.payload as { status?: unknown; url?: unknown; selected?: unknown };
    const trace = selected === undefined ? undefined : typeof selected === 'string' ? selected : JSON.stringify(selected) ?? '';
    event.payload = { status, url, ...(trace !== undefined ? { selected: trace.slice(0, 300) } : {}), trimmed: true };
    if (JSON.stringify(event.payload).length > 1000) event.payload = { status, trimmed: true };
  }
  for (const [secretId, triggerIds] of Object.entries(state.secretGrants)) {
    const kept = triggerIds.filter(id => known.has(id));
    if (kept.length) state.secretGrants[secretId] = kept; else delete state.secretGrants[secretId];
  }
  // Older finished runs keep their outcome but not the full instructions they were given.
  for (const event of finished.slice(0, Math.max(0, finished.length - KEEP_FULL_INPUT))) if (event.input.instructions.length > 200) event.input.instructions = `${event.input.instructions.slice(0, 200)}…`;
}

/** A saved state as the engine takes it over, or undefined when it cannot be read. */
export function parseState(value: unknown, now: () => number, reconcile = true): EngineState | undefined {
  if (!value || typeof value !== 'object' || (value as EngineState).version !== 1) return undefined;
  const saved = upgradeState(value as EngineState, now());
  const state = empty();
  const record = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item);
  try {
    state.settings = TriggerSettingsSchema.parse(saved.settings ?? {});
    if (!readLedger(saved.onceConsumed, state)) return undefined;
    for (const trigger of Array.isArray(saved.triggers) ? saved.triggers : []) {
      const input = TriggerInputSchema.parse({ name: trigger.name, enabled: trigger.enabled, source: trigger.source, handler: trigger.handler, policy: trigger.policy });
      if (typeof trigger.id !== 'string' || !Number.isInteger(trigger.revision)) return undefined;
      state.triggers.push({ ...trigger, ...input });
    }
    const definition = (value: unknown) => record(value) && typeof value.id === 'string' && Number.isInteger(value.revision)
      && TriggerInputSchema.safeParse({ name: value.name, enabled: value.enabled, source: value.source, handler: value.handler, policy: value.policy }).success;
    // Kept as parsed, so a definition moved to a newer shape compares equal to the same one saved again.
    const parsed = (value: Trigger): Trigger => ({ ...value, ...TriggerInputSchema.parse({ name: value.name, enabled: value.enabled, source: value.source, handler: value.handler, policy: value.policy }) });
    if (!record(saved.revisions) || Object.values(saved.revisions).some(list => !Array.isArray(list) || !list.every(definition))) return undefined;
    if (!Array.isArray(saved.tombstones) || !saved.tombstones.every(definition)) return undefined;
    state.revisions = Object.fromEntries(Object.entries(saved.revisions as Record<string, Trigger[]>).map(([id, list]) => [id, list.map(parsed)]));
    state.tombstones = (saved.tombstones as Trigger[]).map(parsed);
    state.recentFires = Array.isArray(saved.recentFires) ? saved.recentFires.filter(item => record(item) && typeof item.at === 'number' && typeof item.triggerId === 'string') : [];
    if (!record(saved.cursors) || Object.values(saved.cursors).some(cursor => !record(cursor) || typeof cursor.anchorAt !== 'number')) return undefined;
    state.cursors = saved.cursors as Record<string, Cursor>;
    if (!Array.isArray(saved.events) || saved.events.some(event => !record(event) || typeof event.id !== 'string' || typeof event.triggerId !== 'string' || typeof event.status !== 'string'
      || typeof event.requestId !== 'string' || !record(event.input) || !record(event.input.target))) return undefined;
    state.events = saved.events.map(event => ({ ...event, input: { ...event.input, overlap: event.input.overlap ?? 'skip' } }));
    state.fired = saved.fired && typeof saved.fired === 'object' ? saved.fired : {};
    state.audit = Array.isArray(saved.audit) ? saved.audit : [];
    state.trustedFolders = Array.isArray(saved.trustedFolders) ? saved.trustedFolders.filter(item => typeof item === 'string') : [];
    if (record(saved.secretGrants)) for (const [secretId, triggerIds] of Object.entries(saved.secretGrants)) {
      if (Array.isArray(triggerIds)) state.secretGrants[secretId] = triggerIds.filter(item => typeof item === 'string');
    }
  } catch { return undefined; }
  if (saved.onceConsumed === undefined) {
    const projection = [...state.triggers, ...state.tombstones, ...Object.values(state.revisions).flat()].find(trigger => OnceConsumptionSchema.safeParse(trigger.consumed).success);
    if (projection) logTrigger(state, now, { kind: 'system', via: 'migration' }, 'consume', projection, projection.revision, projection.revision,
      'The once consumption ledger was absent after a downgrade; retained snapshots were recovered. Deleted IDs beyond legacy retention cannot be recovered.');
  }
  if (reconcile) normalizeOnce(state, now);
  return state;
}

/**
 * Saved state from before issues had one kind of watch, moved to it: each old issue watch becomes the issue watch
 * that does the same (`upgradeWatch`), in triggers, their revisions and deleted ones, and what it had seen goes
 * with it, so no issue it had already seen starts a run.
 */
export function upgradeState(saved: EngineState, now: number): EngineState {
  const record = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item);
  const audit = Array.isArray(saved.audit) ? [...saved.audit] : [];
  const upgrade = (value: unknown) => {
    const decoded = decodeOnceTrigger(value);
    const trigger = decoded.trigger;
    if (decoded.changed && record(trigger)) audit.push({ id: randomUUID(), at: new Date(now).toISOString(), actor: { kind: 'system', via: 'migration' }, action: 'disable',
      triggerId: trigger.id, triggerName: trigger.name, summary: trigger.enabled ? 'An obsolete once marker was removed after a source change by an older engine; inspect the definition.' : 'A reservation changed by an older engine was loaded turned off or its obsolete marker removed; inspect it before rescheduling.' });
    return record(trigger) && record(trigger.source) && trigger.source.kind === 'github'
      ? { ...trigger, source: { ...trigger.source, watch: upgradeWatch(trigger.source.watch, record(trigger.policy) ? trigger.policy.overlap : undefined) } } : trigger;
  };
  const cursors = record(saved.cursors) ? Object.fromEntries(Object.entries(saved.cursors).map(([id, cursor]) => {
    if (!record(cursor) || !record(cursor.github)) return [id, cursor];
    const old = cursor.github as Record<string, any>;
    // The new-issue watch knew the highest number seen per repository; the issues up to it are noted, not run.
    if (record(old.repos)) {
      const watermarks = Object.fromEntries(Object.entries(old.repos).flatMap(([repo, seen]) => record(seen) && Number.isInteger(seen.watermark) ? [[repo.toLowerCase(), seen.watermark as number]] : []));
      return [id, { ...cursor, github: { handled: [], checkedAt: now, baseline: { watermarks } } }];
    }
    if (Array.isArray(old.assigned)) return [id, { ...cursor, github: { handled: old.assigned.filter((key: unknown) => typeof key === 'string'), checkedAt: now } }];
    if (Array.isArray(old.handled) && old.checkedAt === undefined) return [id, { ...cursor, github: { ...old, checkedAt: now } }];
    return [id, cursor];
  })) : saved.cursors;
  return { ...saved, triggers: Array.isArray(saved.triggers) ? saved.triggers.map(upgrade) as Trigger[] : saved.triggers,
    revisions: record(saved.revisions) ? Object.fromEntries(Object.entries(saved.revisions).map(([id, list]) => [id, Array.isArray(list) ? list.map(upgrade) : list])) as EngineState['revisions'] : saved.revisions,
    tombstones: Array.isArray(saved.tombstones) ? saved.tombstones.map(upgrade) as Trigger[] : saved.tombstones, cursors: cursors as EngineState['cursors'], audit: audit.slice(-MAX_AUDIT) };
}

