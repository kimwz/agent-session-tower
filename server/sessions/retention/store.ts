import { mkdir, lstat, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../../stores/private-json.js';
import type { RetentionJournalEntry } from './types.js';
import type { StorageClient } from '../../storage/client.js';
import { RetentionRepository } from './storage-repository.js';
import { journalDocument, type JournalDocument, type RetentionChange } from './storage-codec.js';

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
  private journal: Record<string, unknown> = { version: 1 };
  private repository?: RetentionRepository;
  private database = false;
  constructor(readonly root: string, private readonly options?: { storage: StorageClient | undefined }) {
    if (options?.storage) this.repository = new RetentionRepository(options.storage);
  }
  async start(now = Date.now()): Promise<void> {
    if (this.options && !this.repository) throw new Error('Shared retention storage is unavailable.');
    if (this.repository && await this.repository.databaseAuthority()) {
      const { journal } = await this.repository.readCurrentJournal();
      this.load(journal); this.database = true; return;
    }
    await privateDirectory(this.root);
    try {
      this.load(journalDocument(await readPrivateJson(join(this.root, 'journal.json'), 32_000_000)));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.migratedAt = now; await this.commit(() => {}); }
  }
  private load(data: JournalDocument): void {
    const { entries, policies, ...metadata } = data;
    this.journal = { ...metadata, ...(policies === undefined ? {} : { policies: Array.isArray(policies) ? [] : policies }) }; this.migratedAt = data.migratedAt;
    this.entries = new Map(entries.map(entry => [entry.id, entry]));
    this.policies = new Map((policies || []).map(policy => [policy.id, policy]));
  }
  private document(entries = this.entries, policies = this.policies): JournalDocument {
    return { ...this.journal, version: 1, migratedAt: this.migratedAt, entries: [...entries.values()], policies: [...policies.values()] };
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
      if (this.database) {
        const changes: RetentionChange[] = [];
        const delta = <T>(kind: 'entry' | 'policy', before: Map<string, T>, after: Map<string, T>) => {
          for (const [id, value] of after) if (before.get(id) !== value) {
            const json = JSON.stringify(value), previous = before.has(id) ? JSON.stringify(before.get(id)) : null;
            if (json !== previous) changes.push({ kind, id, json, previous });
          }
          for (const [id, value] of before) if (!after.has(id)) changes.push({ kind, id, json: JSON.stringify(value), previous: JSON.stringify(value), remove: true });
        };
        delta('entry', this.entries, entries); delta('policy', this.policies, policies);
        const wrapper = { ...this.journal, version: 1, migratedAt: this.migratedAt, policies: [] };
        if (JSON.stringify(wrapper) !== JSON.stringify(this.journal)) changes.push({ kind: 'journal', id: '', json: JSON.stringify(wrapper), previous: JSON.stringify(this.journal) });
        await this.repository!.update(changes);
      } else {
        if (this.repository && await this.repository.databaseAuthority()) throw new Error('Retention authority changed; restart the owner before writing.');
        await writePrivateJson(join(this.root, 'journal.json'), JSON.stringify(this.document(entries, policies)), { syncDirectory: true });
      }
      this.entries = entries; this.policies = policies; this.journal = { ...this.journal, version: 1, migratedAt: this.migratedAt, policies: [] };
    });
    this.writing = next.catch(error => { console.error('Retention journal write failed:', error); }); return next;
  }
}
