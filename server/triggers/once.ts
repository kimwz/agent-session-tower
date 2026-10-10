import { OnceConsumptionSchema, type OnceConsumption, type Trigger, type TriggerInput } from '../../shared/triggers.js';
import { logTrigger } from './audit.js';
import { failure } from './errors.js';
import { MAX_ONCE_RESERVATIONS, MAX_RETAINED_TRIGGERS, MAX_REVISIONS } from './limits.js';
import type { EngineState } from './state.js';
import { writeRows, orderRows } from './row-operations.js';

/**
 * The rules of once reservations and archived definitions over a state, and the only code that writes the consumption
 * ledger (`state.onceConsumed`). Every check and every consumption runs inside a store commit, on its draft, so a
 * reservation is consumed in the same save as the event that consumed it. `now` is the engine's clock.
 */

export function activeCount(state: EngineState): number { return state.triggers.filter(trigger => !trigger.archivedAt).length; }

/** Reservation records: consumed ones (kept after deletion) and once definitions not yet consumed. */
export function onceCount(state: EngineState): number {
  return new Set([...Object.keys(state.onceConsumed), ...state.triggers.filter(trigger => trigger.source.schedule.type === 'once').map(trigger => trigger.id)]).size;
}

/** Room for one more definition: active ones within the owner's limit (unless it comes archived), all of them within 200 (unless unarchiving). */
export function assertRoom(state: EngineState, unarchive = false, archived = false): void {
  if (!archived && activeCount(state) >= state.settings.maxTriggers) throw failure(`At most ${state.settings.maxTriggers} active trigger definitions can exist. Archive one first.`, 'conflict');
  if (!unarchive && state.triggers.length >= MAX_RETAINED_TRIGGERS) throw failure(`At most ${MAX_RETAINED_TRIGGERS} definitions can be retained. Delete an archived definition; its run history is kept.`, 'conflict');
}

/** Room for one more once reservation; a definition that already is one (`id`), or one consumed, takes no new record. */
export function assertOnceRoom(state: EngineState, input: TriggerInput, id?: string): void {
  if (input.source.schedule.type === 'once' && (!id || !state.triggers.some(item => item.id === id && item.source.schedule.type === 'once'))
    && !state.onceConsumed[id ?? ''] && onceCount(state) >= MAX_ONCE_RESERVATIONS) throw failure(`Once reservation records are full (${onceCount(state)}/${MAX_ONCE_RESERVATIONS}). Consumption records are retained and cannot be reset by deletion.`, 'conflict');
}

/** A new or re-enabled once reservation is for a future instant. */
export function assertFuture(input: TriggerInput, now: () => number): void {
  if (input.source.schedule.type === 'once' && Date.parse(input.source.schedule.at) <= now()) throw failure('Choose a future instant for a new or re-enabled once reservation.', 'invalid');
}

/** Records a reservation as consumed (once, with the event that consumed it) and archives its definition. */
export function consumeOnce(state: EngineState, trigger: Trigger, eventId: string | undefined, now: () => number): void {
  const at = new Date(now()).toISOString();
  state.onceConsumed[trigger.id] ??= { at, ...(eventId ? { eventId } : {}) };
  writeRows(state,'onceConsumed',trigger.id);
  writeRows(state,'triggers',trigger.id); writeRows(state,'revisions',trigger.id);
  if (state.cursors[trigger.id]) writeRows(state,'cursors',trigger.id);
  const next: Trigger = { ...trigger, consumed: state.onceConsumed[trigger.id], enabled: false, archivedAt: at, revision: trigger.revision + 1,
    updatedAt: at, updatedBy: { kind: 'system', via: 'migration' } };
  state.revisions[trigger.id] = [...(state.revisions[trigger.id] ?? []), trigger].slice(-MAX_REVISIONS);
  state.triggers = state.triggers.map(item => item.id === trigger.id ? next : item);
  if (state.cursors[trigger.id]) delete state.cursors[trigger.id].nextAt;
  logTrigger(state, now, next.updatedBy, 'consume', next, trigger.revision, next.revision, 'Once reservation consumed and archived; run outcome is separate from task completion');
}

/** Recovers retained consumption evidence without reading the clock or reconciling execution. */
export function recoverConsumed(state: EngineState): void {
  for (const trigger of [...state.triggers, ...state.tombstones, ...Object.values(state.revisions).flat()]) {
    const parsed = OnceConsumptionSchema.safeParse(trigger.consumed);
    if (parsed.success && !state.onceConsumed[trigger.id]) { state.onceConsumed[trigger.id] = parsed.data; writeRows(state,'onceConsumed',trigger.id); }
  }
}

/**
 * Makes the ledger and the definitions agree: consumption a snapshot still shows is recorded, a consumed definition is
 * turned off without a next time, an archived one that is on is not archived, and a past reservation without a pending
 * time is turned off.
 */
export function normalizeOnce(state: EngineState, now: () => number): void {
  recoverConsumed(state);
  for (const trigger of state.triggers) {
    const cursor = state.cursors[trigger.id];
    const consumed = state.onceConsumed[trigger.id];
    if (consumed) {
      if (trigger.enabled || trigger.consumed?.at !== consumed.at || trigger.consumed?.eventId !== consumed.eventId)
        writeRows(state,'triggers',trigger.id);
      trigger.consumed = consumed; trigger.enabled = false;
      if (cursor?.nextAt !== undefined) { writeRows(state,'cursors',trigger.id); delete cursor.nextAt; }
    } else if (trigger.archivedAt && trigger.enabled) { writeRows(state,'triggers',trigger.id); delete trigger.archivedAt; }
    if (trigger.source.schedule.type === 'once' && !trigger.enabled && cursor?.nextAt !== undefined) {
      writeRows(state,'cursors',trigger.id); delete cursor.nextAt;
    }
    if (trigger.source.schedule.type === 'once' && trigger.enabled && cursor?.nextAt === undefined && Date.parse(trigger.source.schedule.at) <= now()) {
      writeRows(state,'triggers',trigger.id); trigger.enabled = false;
      logTrigger(state, now, { kind: 'system', via: 'migration' }, 'disable', trigger, trigger.revision, trigger.revision, 'A past once reservation without a pending slot was loaded turned off.');
    }
  }
}

/** The saved ledger, read into a fresh state; false when it is there but not a record. Each entry must parse. */
export function readLedger(saved: unknown, state: EngineState): boolean {
  if (saved === undefined) return true;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false;
  for (const [id, value] of Object.entries(saved)) state.onceConsumed[id] = OnceConsumptionSchema.parse(value);
  return true;
}

/** A restore's ledger: what this computer recorded wins, the rest comes from the backup. */
export function mergeConsumed(state: EngineState, incoming: Record<string, OnceConsumption>): void {
  for (const id of Object.keys(incoming)) if (!state.onceConsumed[id]) writeRows(state,'onceConsumed',id);
  orderRows(state,'onceConsumed',0);
  state.onceConsumed = { ...incoming, ...state.onceConsumed };
}

/** A row mutation has its own ledger container; entries remain immutable until once.ts replaces them. */
export function isolateConsumed(state: EngineState): void { state.onceConsumed = { ...state.onceConsumed }; }

export function consumedSnapshot(state: EngineState): EngineState['onceConsumed'] { return { ...state.onceConsumed }; }

export function projectConsumed(state: EngineState, trigger: Trigger): void {
  if (state.onceConsumed[trigger.id]) { trigger.consumed = { ...state.onceConsumed[trigger.id] }; trigger.enabled = false; }
}

/** The final say on a restored state, checked on the state about to be saved. */
export function admitCapacity(state: EngineState): void {
  if (state.triggers.length > MAX_RETAINED_TRIGGERS || activeCount(state) > state.settings.maxTriggers || onceCount(state) > MAX_ONCE_RESERVATIONS) throw failure('The restored trigger state exceeds the supported capacity. Existing records were preserved.', 'conflict');
}
