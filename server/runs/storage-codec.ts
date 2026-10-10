import { createHash } from 'node:crypto';
import type { Run, RunInstructions } from '../../shared/types.js';
import { isCreatedSession, isSavedRun, UUID, type CreatedSession } from './saved-state.js';
import { checkedInstructions } from './turn-notes.js';
import type { TriggerAdmissionLink } from '../triggers/storage-commands.js';

export const RUN_SOURCE_BYTES = 64 * 1024 * 1024;
export const RUN_DEPENDENCY_BYTES = 12_000_000;
export const RUN_CHUNK_BYTES = 192 * 1024;
// Six times raw JSON bounds finite numeric canonicalization. Records are transferred
// as NDJSON, so a 64MiB source never requires one >512MiB JS string (including guards).
export const RUN_INTENT_BYTES = 6 * (RUN_SOURCE_BYTES + 2 * RUN_DEPENDENCY_BYTES) + 1024 * 1024;
export const runHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid runs object.');
  return value as Record<string, unknown>;
}
/** Stable payload identity; unknown JSON fields remain part of the hash and stored record. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
export interface RunDocuments { runs: Run[]; created: CreatedSession[]; instructions: Record<string, RunInstructions> }
export type RunRowKind = 'run' | 'created' | 'instruction';
export interface RunRow { kind: RunRowKind; id: string; json: string }
export interface RunChange extends RunRow { previous: string | null; previousSha256?: string; remove?: boolean }
export function validateRow(row: RunRow): void {
  if (typeof row.id !== 'string' || typeof row.json !== 'string') throw new Error('Invalid run storage row.');
  const value: unknown = JSON.parse(row.json);
  if (row.kind === 'run') {
    if (!isSavedRun(value) || value.id !== row.id) throw new Error('Invalid saved run.');
    const data = object(value);
    for (const key of ['needsInstructions', 'keepQueued', 'retain']) if (key in data && data[key] !== true) throw new Error('Unknown run restoration marker.');
    if ('instructions' in data || 'approvals' in data || 'canSteer' in data || 'steerBlocked' in data) throw new Error('Live-only run fields cannot enter storage.');
  } else if (row.kind === 'created') {
    if (!isCreatedSession(value) || value.session.id !== row.id) throw new Error('Invalid created session.');
  } else if (row.kind === 'instruction') {
    if (!UUID.test(row.id)) throw new Error('Invalid instruction run ID.');
    const instructions = object(value);
    if (instructions.required !== undefined && typeof instructions.required !== 'boolean') throw new Error('Unknown required instructions marker.');
    checkedInstructions(value as RunInstructions);
  } else throw new Error('Unknown run storage row kind.');
}
export function rowsOf(documents: RunDocuments): RunRow[] {
  if (!Array.isArray(documents.runs) || !Array.isArray(documents.created)) throw new Error('Invalid run documents.');
  object(documents.instructions);
  const rows: RunRow[] = [
    ...documents.created.map(value => ({ kind: 'created' as const, id: value?.session?.id, json: canonical(value) })),
    ...documents.runs.map(value => ({ kind: 'run' as const, id: value?.id, json: canonical(value) })),
    ...Object.entries(documents.instructions).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, value]) => ({ kind: 'instruction' as const, id, json: canonical(value) })),
  ];
  const keys = new Set<string>();
  for (const row of rows) { validateRow(row); const key = canonical([row.kind, row.id]); if (keys.has(key)) throw new Error('Duplicate run storage identity.'); keys.add(key); }
  for (const [name, bytes] of [['runs', RUN_SOURCE_BYTES], ['created', RUN_DEPENDENCY_BYTES], ['instructions', RUN_DEPENDENCY_BYTES]] as const) {
    if (Buffer.byteLength(canonical(documents[name])) > 6 * bytes) throw new Error(`Current ${name} exceeds its lossless canonical source allowance.`);
  }
  return rows;
}
export function documentsOf(rows: readonly RunRow[]): RunDocuments {
  const documents: RunDocuments = { runs: [], created: [], instructions: {} };
  for (const row of rows) {
    validateRow(row);
    if (row.kind === 'run') documents.runs.push(JSON.parse(row.json));
    else if (row.kind === 'created') documents.created.push(JSON.parse(row.json));
    else Object.defineProperty(documents.instructions, row.id, { value: JSON.parse(row.json), enumerable: true, configurable: true, writable: true });
  }
  rowsOf(documents);
  return documents;
}
/** Validate raw JSON without executing restart reconciliation, truncation, pruning or origin upgrades. */
export function parseRunDocuments(raw: { runs: Buffer; created: Buffer; instructions: Buffer }, current = false): RunDocuments {
  for (const [key, limit] of [['runs', RUN_SOURCE_BYTES], ['created', RUN_DEPENDENCY_BYTES], ['instructions', RUN_DEPENDENCY_BYTES]] as const) {
    if (raw[key].length > limit * (current ? 6 : 1)) throw new Error(`Runs ${key} source is too large.`);
    if (!Buffer.from(raw[key].toString('utf8')).equals(raw[key])) throw new Error('Runs source is not lossless UTF-8.');
  }
  const documents = Object.fromEntries(Object.entries(raw).map(([key, bytes]) => [key, JSON.parse(bytes.toString('utf8'))])) as unknown as RunDocuments;
  rowsOf(documents);
  return documents;
}
/** Ordered row digest also includes deletions/order; no giant combined document string. */
export function documentsHash(documents: RunDocuments): string {
  const hash = createHash('sha256');
  for (const row of rowsOf(documents)) hash.update(canonical([row.kind, row.id])).update('\n').update(row.json).update('\n');
  return hash.digest('hex');
}

export function transferRow(row: RunRow | RunChange, replacing: boolean): string {
  const change = row as RunChange;
  return canonical({ kind: row.kind,id: row.id,value: JSON.parse(row.json),
    ...(replacing ? {} : { previousSha256: change.previousSha256 ?? (change.previous === null ? null : runHash(change.previous)), ...(change.remove ? { remove: true } : {}) }) }) + '\n';
}
export function requestHash(mode: string, rows: readonly (RunRow | RunChange)[], triggerLinks?: readonly TriggerAdmissionLink[]): string {
  const hash = createHash('sha256').update(canonical({ mode,...(triggerLinks ? { triggerLinks } : {}) }) + '\n');
  for (const row of rows) hash.update(transferRow(row,mode === 'import' || mode === 'restore'));
  return hash.digest('hex');
}
