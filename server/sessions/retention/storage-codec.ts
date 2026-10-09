import { createHash } from 'node:crypto';
import type { RetentionJournalEntry } from './types.js';
import type { RetentionPolicyState } from './store.js';

export const JOURNAL_BYTES = 32_000_000;
export const OBSERVATION_BYTES = 8_000_000;
// JSON.stringify finite numbers use at most 25 ASCII bytes. One/two-byte input
// integers do not grow; three/four-byte number tokens produce at most 11/22
// bytes; tokens of >=5 bytes grow <=5x. Six is therefore a finite upper bound.
// Strings/syntax do not grow (even replacement of invalid UTF-8 grows <=3x).
export const CANONICAL_JOURNAL_BYTES = 6 * JOURNAL_BYTES;
export const CANONICAL_OBSERVATION_BYTES = 6 * OBSERVATION_BYTES;
// Update envelopes escape canonical row strings, repeat IDs and carry guards.
// Numeric expansion introduces no escapable characters; string escaping and
// repeated IDs cost <=2x raw bytes. The smallest legal row is a policy (>=28
// bytes); six raw budgets also cover its fixed envelope and 64-byte digest.
// Reserve one command envelope for fences/wrappers. This stays below V8's
// 512MiB string ceiling; shared SDK payload/result limits stay unchanged.
export const RETENTION_INTENT_BYTES = CANONICAL_JOURNAL_BYTES + CANONICAL_OBSERVATION_BYTES + 6 * (JOURNAL_BYTES + OBSERVATION_BYTES) + 1024 * 1024;
// Base64 prevents JSON escaping and UTF-16 surrogate splits from enlarging a message unexpectedly.
export const RETENTION_CHUNK_BYTES = 192 * 1024;
export const retentionHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export interface InactiveObservation { fingerprint: string; since: string; observedAt: number; [key: string]: unknown }
export interface JournalDocument { version: 1; migratedAt: number; entries: RetentionJournalEntry[]; policies?: RetentionPolicyState[] | null | false | 0 | ''; [key: string]: unknown }
export interface ObservationDocument { version: 1; entries: [string, InactiveObservation, ...unknown[]][]; [key: string]: unknown }
export interface RetentionDocuments { journal: JournalDocument; observations: ObservationDocument }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid retention object.');
  return value as Record<string, unknown>;
}
export function entry(value: unknown): RetentionJournalEntry {
  const row = object(value);
  if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.id) || !row.candidate || !Array.isArray(object(row.candidate).ids)) throw new Error('Invalid retention journal entry.');
  return value as RetentionJournalEntry;
}
export function policy(value: unknown): RetentionPolicyState {
  const row = object(value);
  if (typeof row.id !== 'string' || !Number.isSafeInteger(row.archiveRevision)) throw new Error('Invalid retention policy state.');
  return value as RetentionPolicyState;
}
export function observation(value: unknown): InactiveObservation {
  const row = object(value);
  if (typeof row.fingerprint !== 'string' || !Number.isFinite(row.observedAt) || !Number.isFinite(Date.parse(row.since as string))) throw new Error('Invalid inactive observation.');
  return value as InactiveObservation;
}
export function journalDocument(value: unknown): JournalDocument {
  const data = object(value);
  if (data.version !== 1 || !Number.isFinite(data.migratedAt) || !Array.isArray(data.entries)) throw new Error('Invalid retention journal.');
  for (const row of data.entries) entry(row);
  if (data.policies) { if (!Array.isArray(data.policies)) throw new Error('Invalid retention policies.'); for (const row of data.policies) policy(row); }
  return value as JournalDocument;
}
export function observationDocument(value: unknown): ObservationDocument {
  const data = object(value);
  if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Invalid retention observations.');
  for (const row of data.entries) { if (!Array.isArray(row) || row.length < 2 || typeof row[0] !== 'string') throw new Error('Invalid inactive observation.'); observation(row[1]); }
  return value as ObservationDocument;
}
export type RetentionRowKind = 'entry' | 'policy' | 'observation' | 'journal' | 'observations';
export interface RetentionRow { kind: RetentionRowKind; id: string; json: string }
export interface RetentionChange extends RetentionRow { previous: string | null; previousSha256?: string; remove?: boolean }
export function rowsOf(documents: RetentionDocuments): RetentionRow[] {
  journalDocument(documents.journal); observationDocument(documents.observations);
  const { entries, policies, ...journal } = documents.journal;
  const { entries: inactive, ...observations } = documents.observations;
  // Last duplicate wins, as in the existing Map loaders; unknown fields stay inside the original JSON.
  const rows = new Map<string, RetentionRow>();
  const put = (kind: RetentionRowKind, id: string, value: unknown) => rows.set(JSON.stringify([kind, id]), { kind, id, json: JSON.stringify(value) });
  put('journal', '', { ...journal, ...(policies === undefined ? {} : { policies: Array.isArray(policies) ? [] : policies }) });
  put('observations', '', observations);
  for (const row of entries) put('entry', row.id, row);
  for (const row of policies || []) put('policy', row.id, row);
  for (const tuple of inactive) put('observation', tuple[0], tuple);
  return [...rows.values()];
}
function wrapperOf(rows: RetentionRow[], kind: 'journal' | 'observations'): Record<string, unknown> {
  const row = rows.find(row => row.kind === kind);
  if (!row) throw new Error(`Missing retention ${kind} metadata.`);
  return object(JSON.parse(row.json));
}
export function journalOf(rows: RetentionRow[]): JournalDocument {
  const journal = wrapperOf(rows, 'journal');
  return journalDocument({ ...journal, entries: rows.filter(row => row.kind === 'entry').map(row => JSON.parse(row.json)), ...(rows.some(row => row.kind === 'policy') || Array.isArray(journal.policies) ? { policies: rows.filter(row => row.kind === 'policy').map(row => JSON.parse(row.json)) } : {}) });
}
export function documentsOf(rows: RetentionRow[]): RetentionDocuments {
  const observations = wrapperOf(rows, 'observations');
  return {
    journal: journalOf(rows),
    observations: observationDocument({ ...observations, entries: rows.filter(row => row.kind === 'observation').map(row => JSON.parse(row.json)) }),
  };
}
export function validateRow(row: RetentionRow): void {
  if (typeof row.id !== 'string' || typeof row.json !== 'string') throw new Error('Invalid retention row.');
  const value = JSON.parse(row.json);
  if (row.kind === 'entry') { if (entry(value).id !== row.id) throw new Error('Retention entry ID mismatch.'); }
  else if (row.kind === 'policy') { if (policy(value).id !== row.id) throw new Error('Retention policy ID mismatch.'); }
  else if (row.kind === 'observation') { if (!Array.isArray(value) || value[0] !== row.id) throw new Error('Invalid retention observation tuple.'); observation(value[1]); }
  else if (row.kind === 'journal') { if (row.id !== '') throw new Error('Invalid retention wrapper ID.'); journalDocument({ ...object(value), entries: [], ...(Object.hasOwn(object(value), 'policies') ? { policies: [] } : {}) }); }
  else if (row.kind === 'observations') { if (row.id !== '') throw new Error('Invalid retention wrapper ID.'); observationDocument({ ...object(value), entries: [] }); }
  else throw new Error('Unknown retention row kind.');
}
