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
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.migratedAt = now; await this.commit(() => {}); }
  }
  policy(id: string): RetentionPolicyState | undefined { const policy = this.policies.get(id); return policy ? structuredClone(policy) : undefined; }
  async setPolicy(policy: RetentionPolicyState): Promise<void> {
    const input = structuredClone(policy);
    return this.commit((_entries, policies) => { policies.set(input.id, input); });
  }
  list(): RetentionJournalEntry[] { return structuredClone([...this.entries.values()]); }
  get(id: string): RetentionJournalEntry | undefined { const entry = this.entries.get(id); return entry ? structuredClone(entry) : undefined; }
  async put(entry: RetentionJournalEntry): Promise<void> { await this.putMany([entry]); }
  async putMany(entries: RetentionJournalEntry[]): Promise<void> {
    const inputs = structuredClone(entries);
    for (const entry of inputs) validateOperationId(entry.id);
    return this.commit(draft => { for (const entry of inputs) draft.set(entry.id, entry); });
  }
  async putIfUnchanged(updates: { previous: RetentionJournalEntry; next: RetentionJournalEntry }[], allowed: (id: string) => boolean): Promise<void> {
    const inputs = structuredClone(updates);
    for (const item of inputs) validateOperationId(item.next.id);
    return this.commit(draft => {
      for (const { previous, next } of inputs) if (allowed(previous.id) && JSON.stringify(draft.get(previous.id)) === JSON.stringify(previous)) draft.set(next.id, next);
    });
  }
  async removeMetadata(ids: string[]): Promise<void> {
    const inputs = [...ids];
    return this.commit(draft => {
      for (const id of inputs) { const entry = draft.get(id); if (entry && ['planned', 'blocked-provider'].includes(entry.phase)) draft.delete(id); }
    });
  }
  private commit(mutate: (entries: Map<string, RetentionJournalEntry>, policies: Map<string, RetentionPolicyState>) => void): Promise<void> {
    const next = this.writing.then(async () => {
      // Build from the last committed state inside the queue; failed drafts never become visible.
      const entries = new Map(this.entries), policies = new Map(this.policies);
      mutate(entries, policies);
      const data = JSON.stringify({ version: 1, migratedAt: this.migratedAt, entries: [...entries.values()], policies: [...policies.values()] });
      await writePrivateJson(join(this.root, 'journal.json'), data, { syncDirectory: true });
      this.entries = entries; this.policies = policies;
    });
    this.writing = next.catch(error => { console.error('Retention journal write failed:', error); }); return next;
  }
}
