import { createHash } from 'node:crypto';
import { OnceConsumptionSchema, TriggerInputSchema, TriggerSettingsSchema, type Trigger } from '../../shared/triggers.js';
import { encodeOnceTrigger } from './once-storage.js';
import { empty, type EngineState } from './state.js';

export const TRIGGER_CHUNK_BYTES = 196608;
export const TRIGGER_INTENT_BYTES = 481048576;
export const ACCEPT_TRIGGER_BYTES = 8_000_000;
export const MAX_TRIGGER_BYTES = 10_000_000;
export const triggerHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// Preserve JSON property order as well as collection order. Payload hashes use these exact bytes.
export const canonical = JSON.stringify;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid trigger storage object.');
  return value as Record<string, unknown>;
}
export const ROW_KINDS = ['onceConsumed','triggers','revisions','tombstones','cursors','events','fired','audit','settings','trustedFolders','recentFires','secretGrants'] as const;
export type TriggerRowKind = typeof ROW_KINDS[number];
const ARRAYS = new Set<TriggerRowKind>(['triggers','tombstones','events','audit','trustedFolders','recentFires']);
export interface TriggerRow { kind: TriggerRowKind; id: string; ordinal: number; json: string }
export interface TriggerChange extends TriggerRow { previous: string | null; previousOrdinal?: number; remove?: boolean }
export function validateRow(row: TriggerRow): void {
  if (!ROW_KINDS.includes(row.kind) || typeof row.id !== 'string' || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || typeof row.json !== 'string') throw new Error('Invalid trigger row.');
  const value: unknown = JSON.parse(row.json);
  if (canonical(value) !== row.json) throw new Error('Trigger row JSON is not lossless.');
  if (row.kind === 'settings' && (row.id !== 'settings' || row.ordinal !== 0)) throw new Error('Invalid settings singleton.');
  if (['triggers','tombstones','events','audit'].includes(row.kind) && object(value).id !== row.id) throw new Error('Trigger row identity mismatch.');
  const definition = (item: unknown) => {
    const trigger = object(item);
    if (typeof trigger.id !== 'string' || !Number.isInteger(trigger.revision)) throw new Error('Invalid trigger definition.');
    TriggerInputSchema.parse({ name: trigger.name,enabled: trigger.enabled,source: trigger.source,handler: trigger.handler,policy: trigger.policy });
  };
  if (row.kind === 'triggers' || row.kind === 'tombstones') definition(value);
  if (row.kind === 'revisions') { if (!Array.isArray(value)) throw new Error('Invalid trigger revisions.'); value.forEach(definition); }
  if (row.kind === 'settings') TriggerSettingsSchema.parse(value);
  if (row.kind === 'onceConsumed') OnceConsumptionSchema.parse(value);
  if (row.kind === 'cursors' && typeof object(value).anchorAt !== 'number') throw new Error('Invalid trigger cursor.');
  if (row.kind === 'events') { const event = object(value); if (typeof event.triggerId !== 'string' || typeof event.status !== 'string' || typeof event.requestId !== 'string') throw new Error('Invalid trigger event.'); object(object(event.input).target); }
  if (row.kind === 'fired' && typeof value !== 'string') throw new Error('Invalid trigger dedup value.');
  if (row.kind === 'trustedFolders' && typeof value !== 'string') throw new Error('Invalid trusted folder.');
  if (row.kind === 'recentFires' && (typeof object(value).at !== 'number' || typeof object(value).triggerId !== 'string')) throw new Error('Invalid recent firing.');
  if (row.kind === 'secretGrants' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw new Error('Invalid secret grants.');
}
export function rowsOf(state: EngineState): TriggerRow[] {
  if (state.version !== 1) throw new Error('Unknown trigger state version.');
  const rows: TriggerRow[] = [];
  for (const kind of ROW_KINDS) {
    // Transport reads generic collections; only once.ts owns business ledger changes.
    const value = object(state)[kind];
    if (kind === 'settings') rows.push({ kind, id: kind, ordinal: 0, json: canonical(value) });
    else if (ARRAYS.has(kind)) {
      if (!Array.isArray(value)) throw new Error('Invalid trigger array.');
      value.forEach((item, ordinal) => rows.push({ kind, id: ['triggers','tombstones','events','audit'].includes(kind) ? String(object(item).id) : String(ordinal), ordinal, json: canonical(item) }));
    } else Object.entries(object(value)).forEach(([id,item],ordinal) => rows.push({ kind, id, ordinal, json: canonical(item) }));
  }
  const keys = new Set<string>();
  for (const row of rows) { validateRow(row); const key = canonical([row.kind,row.id]); if (keys.has(key)) throw new Error('Duplicate trigger row.'); keys.add(key); }
  return rows;
}
/** Decoding current SQL rows does not normalize, prune or recover execution state. */
export function stateOf(rows: readonly TriggerRow[]): EngineState {
  const state = empty(), keys = new Set<string>();
  for (const row of rows) { validateRow(row); const key = canonical([row.kind,row.id]); if (keys.has(key)) throw new Error('Duplicate trigger row.'); keys.add(key); }
  if (rows.filter(row => row.kind === 'settings').length !== 1) throw new Error('Missing trigger settings.');
  for (const kind of ROW_KINDS) {
    const group = rows.filter(row => row.kind === kind).sort((a,b) => a.ordinal - b.ordinal);
    group.forEach((row,index) => { validateRow(row); if (row.ordinal !== index) throw new Error('Noncontiguous trigger collection.'); });
    const value = kind === 'settings' ? JSON.parse(group[0].json) : ARRAYS.has(kind) ? group.map(row => JSON.parse(row.json)) : Object.fromEntries(group.map(row => [row.id,JSON.parse(row.json)]));
    Object.defineProperty(state,kind,{ value,enumerable: true,writable: true,configurable: true });
  }
  rowsOf(state);
  return state;
}
export function projectedJson(row: TriggerRow, ledger: EngineState['onceConsumed']): string {
  const encode = (trigger: Trigger) => encodeOnceTrigger({ ...trigger, ...(ledger[trigger.id] ? { consumed: { ...ledger[trigger.id] } } : {}) });
  const value = JSON.parse(row.json);
  return row.kind === 'triggers' || row.kind === 'tombstones' ? canonical(encode(value)) : row.kind === 'revisions' ? canonical(value.map(encode)) : row.json;
}
export function rowCost(row: TriggerRow, projected: string): number {
  return Buffer.byteLength(projected) + (!ARRAYS.has(row.kind) && row.kind !== 'settings' ? Buffer.byteLength(canonical(row.id)) + 1 : 0);
}
// Empty wrappers, keys, colons and outer commas match serializeState's EngineState field order.
export const WRAPPER_BYTES = Buffer.byteLength(canonical({ ...empty(), settings: null })) - 4;
export function logicalBytes(rows: readonly TriggerRow[]): number {
  const ledger = Object.fromEntries(rows.filter(row => row.kind === 'onceConsumed').map(row => [row.id,JSON.parse(row.json)]));
  return WRAPPER_BYTES + rows.reduce((sum,row) => sum + rowCost(row,projectedJson(row,ledger)),0) + ROW_KINDS.reduce((sum,kind) => sum + (kind === 'settings' ? 0 : Math.max(0,rows.filter(row => row.kind === kind).length - 1)),0);
}
export function changesOf(previous: readonly TriggerRow[], next: readonly TriggerRow[]): TriggerChange[] {
  const before = new Map(previous.map(row => [canonical([row.kind,row.id]),row]));
  const changes: TriggerChange[] = [];
  for (const row of next) { const key = canonical([row.kind,row.id]), old = before.get(key); before.delete(key); if (!old || old.json !== row.json || old.ordinal !== row.ordinal) changes.push({ ...row,previous: old?.json ?? null,previousOrdinal: old?.ordinal }); }
  for (const row of before.values()) changes.push({ ...row,previous: row.json,previousOrdinal: row.ordinal,remove: true });
  return changes;
}
export function documentsHash(state: EngineState): string {
  const hash = createHash('sha256');
  for (const row of rowsOf(state)) hash.update(canonical([row.kind,row.id,row.ordinal])).update('\n').update(row.json).update('\n');
  return hash.digest('hex');
}
export function transferRow(row: TriggerRow | TriggerChange, replacing: boolean): string {
  const change = row as TriggerChange;
  return canonical({ kind: row.kind,id: row.id,ordinal: row.ordinal,json: row.json,...(replacing ? {} : { previousSha256: change.previous === null ? null : triggerHash(change.previous),previousOrdinal: change.previousOrdinal,...(change.remove ? { remove: true } : {}) }) }) + '\n';
}
export function requestHash(mode: string, rows: readonly (TriggerRow | TriggerChange)[]): string {
  const hash = createHash('sha256').update(canonical({ mode }) + '\n');
  for (const row of rows) hash.update(transferRow(row,mode === 'import' || mode === 'restore'));
  return hash.digest('hex');
}
