import type { AutoPromptJob, Run, Session, Snapshot } from './types.js';

/** Collections sent item by item. Every other top-level value is replaced whole. */
const KEYED = ['sessions', 'runs', 'autoPrompts'] as const;
type KeyedName = typeof KEYED[number];
type Item = { id: string };

export interface KeyedPatch<T> {
  /** Items that are new or whose content changed. */
  upsert?: T[];
  /** The complete id order. Present only when membership or order changed. */
  order?: string[];
}
export interface SnapshotChanges {
  sessions?: KeyedPatch<Session>;
  runs?: KeyedPatch<Run>;
  autoPrompts?: KeyedPatch<AutoPromptJob>;
  /** Top-level values replaced whole, including a collection that cannot be patched by id. */
  fields?: Partial<Snapshot>;
  /** Optional top-level values that are no longer present. */
  cleared?: (keyof Snapshot)[];
}
/** Changes from the snapshot numbered `base` to the next one in the same event stream. */
export interface SnapshotPatch extends SnapshotChanges { base: number }

interface KeyedIndex { ids: string[]; json: Map<string, string>; items: Map<string, Item> }
/** Serialized content of a snapshot, kept so the next comparison serializes only the new one. */
export interface SnapshotIndex {
  keyed: Partial<Record<KeyedName, KeyedIndex>>;
  fields: Map<keyof Snapshot, string>;
}

export function indexSnapshot(snapshot: Snapshot): SnapshotIndex {
  const index: SnapshotIndex = { keyed: {}, fields: new Map() };
  for (const [key, value] of Object.entries(snapshot) as [keyof Snapshot, unknown][]) {
    // The broadcast time alone is not a change.
    if (value === undefined || key === 'updatedAt') continue;
    const keyed = (KEYED as readonly string[]).includes(key) ? keyedIndex(value) : undefined;
    if (keyed) index.keyed[key as KeyedName] = keyed;
    else index.fields.set(key, JSON.stringify(value));
  }
  return index;
}

/** A collection with missing or repeated ids is compared and sent whole. */
function keyedIndex(value: unknown): KeyedIndex | undefined {
  if (!Array.isArray(value)) return undefined;
  const index: KeyedIndex = { ids: [], json: new Map(), items: new Map() };
  for (const item of value as Item[]) {
    if (!item || typeof item.id !== 'string' || index.items.has(item.id)) return undefined;
    index.ids.push(item.id);
    index.items.set(item.id, item);
    index.json.set(item.id, JSON.stringify(item));
  }
  return index;
}

/** Undefined when nothing but `updatedAt` differs. */
export function diffSnapshots(previous: SnapshotIndex, next: Snapshot, nextIndex = indexSnapshot(next)): SnapshotChanges | undefined {
  const changes: SnapshotChanges = {};
  const fields: Partial<Record<keyof Snapshot, unknown>> = {};
  let changed = false;
  for (const name of KEYED) {
    const before = previous.keyed[name];
    const after = nextIndex.keyed[name];
    if (!after) continue;
    if (!before) { fields[name] = next[name]; changed = true; continue; }
    const upsert = after.ids.filter(id => before.json.get(id) !== after.json.get(id)).map(id => after.items.get(id)!);
    const reordered = before.ids.length !== after.ids.length || before.ids.some((id, position) => after.ids[position] !== id);
    if (!upsert.length && !reordered) continue;
    (changes as Record<KeyedName, KeyedPatch<Item>>)[name] = { ...(upsert.length ? { upsert } : {}), ...(reordered ? { order: after.ids } : {}) };
    changed = true;
  }
  for (const [key, json] of nextIndex.fields) {
    if (previous.fields.get(key) !== json) { fields[key] = next[key]; changed = true; }
  }
  const cleared = [...previous.fields.keys(), ...Object.keys(previous.keyed) as KeyedName[]]
    .filter(key => !nextIndex.fields.has(key) && !nextIndex.keyed[key as KeyedName]);
  if (cleared.length) { changes.cleared = cleared; changed = true; }
  if (!changed) return undefined;
  changes.fields = { ...fields, updatedAt: next.updatedAt } as Partial<Snapshot>;
  return changes;
}

/**
 * Unchanged items keep their identity. Throws when the patch does not fit `previous`;
 * the caller must then request a complete snapshot.
 */
export function applySnapshotPatch(previous: Snapshot, patch: SnapshotChanges): Snapshot {
  const next = { ...previous } as Record<keyof Snapshot, unknown>;
  for (const key of patch.cleared ?? []) delete next[key];
  Object.assign(next, patch.fields);
  for (const name of KEYED) {
    const change = patch[name] as KeyedPatch<Item> | undefined;
    if (!change) continue;
    const current = previous[name];
    if (!Array.isArray(current)) throw new Error(`Snapshot patch has no ${name} to update.`);
    const items = new Map((current as Item[]).map(item => [item.id, item]));
    for (const item of change.upsert ?? []) items.set(item.id, item);
    const order = change.order ?? (current as Item[]).map(item => item.id);
    const listed = new Set(order);
    if (listed.size !== order.length || (change.upsert ?? []).some(item => !listed.has(item.id))) throw new Error(`Snapshot patch has an invalid ${name} order.`);
    next[name] = order.map(id => {
      const item = items.get(id);
      if (!item) throw new Error(`Snapshot patch refers to an unknown ${name} item.`);
      return item;
    });
  }
  return next as unknown as Snapshot;
}
