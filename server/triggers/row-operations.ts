import type { EngineState } from './state.js';
import type { TriggerRowKind } from './storage-codec.js';

/** Explicit owner declarations, separate from the durable business projection. */
export interface RowOperations {
  rows: Map<TriggerRowKind, Map<string, 'write' | 'remove'>>;
  tails: Map<TriggerRowKind, number>;
}
const operations = new WeakMap<EngineState, RowOperations>();
export function beginRowOperations(state: EngineState): RowOperations {
  const result: RowOperations = { rows: new Map(), tails: new Map() };
  operations.set(state,result); return result;
}
export function writeRows(state: EngineState, kind: TriggerRowKind, ...ids: string[]): void {
  const result = operations.get(state); if (!result) return;
  const rows = result.rows.get(kind) ?? new Map<string,'write' | 'remove'>(); result.rows.set(kind,rows);
  for (const id of ids) rows.set(id,'write');
}
export function removeRows(state: EngineState, kind: TriggerRowKind, ...ids: string[]): void {
  const result = operations.get(state); if (!result) return;
  const rows = result.rows.get(kind) ?? new Map<string,'write' | 'remove'>(); result.rows.set(kind,rows);
  for (const id of ids) rows.set(id,'remove');
}
/** Only the affected collection's tail needs new ordinals; untouched JSON is reused. */
export function orderRows(state: EngineState, kind: TriggerRowKind, from: number): void {
  const result = operations.get(state); if (result) result.tails.set(kind,Math.min(result.tails.get(kind) ?? Infinity,from));
}
export function mergeRowOperations(state: EngineState, incoming: RowOperations): void {
  for (const [kind,rows] of incoming.rows) for (const [id,operation] of rows)
    (operation === 'remove' ? removeRows : writeRows)(state,kind,id);
  for (const [kind,from] of incoming.tails) orderRows(state,kind,from);
}
