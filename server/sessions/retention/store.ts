import { mkdir, lstat, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../../stores/private-json.js';
import type { RetentionJournalEntry } from './types.js';

export async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const pieces = absolute.split('/').filter(Boolean); let current = '/';
  for (const piece of pieces) {
    current = join(current, piece);
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe retention directory: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(current, { mode: 0o700 }); }
  }
  await chmod(absolute, 0o700);
  return absolute;
}
export function validateOperationId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid retention operation ID.');
}
export interface RetentionPolicyState { id: string; archivedAt?: string; archiveRevision: number; restoredAt?: string }
export class RetentionStore {
  private entries = new Map<string, RetentionJournalEntry>();
  private policies = new Map<string, RetentionPolicyState>();
  private writing: Promise<void> = Promise.resolve();
  migratedAt = 0;
  constructor(readonly root: string) {}
  async start(now = Date.now()): Promise<void> {
    await privateDirectory(this.root);
    try {
      const data = await readPrivateJson(join(this.root, 'journal.json'), 32_000_000) as { version: number; migratedAt: number; entries: RetentionJournalEntry[]; policies?: RetentionPolicyState[] };
      if (data.version !== 1 || !Number.isFinite(data.migratedAt) || !Array.isArray(data.entries)) throw new Error('Invalid retention journal.');
      this.migratedAt = data.migratedAt;
      for (const policy of data.policies || []) { if (typeof policy.id !== 'string' || !Number.isSafeInteger(policy.archiveRevision)) throw new Error('Invalid retention policy state.'); this.policies.set(policy.id, policy); }
      for (const entry of data.entries) { validateOperationId(entry.id); if (!entry.candidate || !Array.isArray(entry.candidate.ids)) throw new Error('Invalid retention journal entry.'); this.entries.set(entry.id, entry); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.migratedAt = now; await this.save(); }
  }
  policy(id: string): RetentionPolicyState | undefined { const policy = this.policies.get(id); return policy ? structuredClone(policy) : undefined; }
  async setPolicy(policy: RetentionPolicyState): Promise<void> { this.policies.set(policy.id, structuredClone(policy)); await this.save(); }
  list(): RetentionJournalEntry[] { return structuredClone([...this.entries.values()]); }
  get(id: string): RetentionJournalEntry | undefined { const entry = this.entries.get(id); return entry ? structuredClone(entry) : undefined; }
  async put(entry: RetentionJournalEntry): Promise<void> { await this.putMany([entry]); }
  async putMany(entries: RetentionJournalEntry[]): Promise<void> {
    for (const entry of entries) { validateOperationId(entry.id); this.entries.set(entry.id, structuredClone(entry)); }
    await this.save();
  }
  private save(): Promise<void> {
    const data = JSON.stringify({ version: 1, migratedAt: this.migratedAt, entries: [...this.entries.values()], policies: [...this.policies.values()] });
    const next = this.writing.then(() => writePrivateJson(join(this.root, 'journal.json'), data, { syncDirectory: true }));
    this.writing = next.catch(error => { console.error('Retention journal write failed:', error); }); return next;
  }
}
