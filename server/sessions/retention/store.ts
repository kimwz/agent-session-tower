import { mkdir, lstat, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { RetentionJournalEntry } from './types.js';
import type { StorageClient } from '../../storage/client.js';
import { RetentionRepository } from './storage-repository.js';
import type { JournalDocument, RetentionChange } from './storage-codec.js';

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
  private started = false;
  constructor(readonly root: string, options?: { storage: StorageClient | undefined }) {
    if (options?.storage) this.repository = new RetentionRepository(options.storage);
  }
  async start(_now = Date.now()): Promise<void> {
    this.started = false;
    if (!this.repository) throw new Error('Shared retention storage is unavailable.');
    if (!await this.repository.databaseAuthority()) throw new Error('Retention database authority is required.');
    const { journal } = await this.repository.readCurrentJournal();
    this.load(journal); this.started = true;
  }
  private load(data: JournalDocument): void {
    const { entries, policies, ...metadata } = data;
    this.journal = { ...metadata, ...(policies === undefined ? {} : { policies: Array.isArray(policies) ? [] : policies }) }; this.migratedAt = data.migratedAt;
    this.entries = new Map(entries.map(entry => [entry.id, entry]));
    this.policies = new Map((policies || []).map(policy => [policy.id, policy]));
  }
  policy(id: string): RetentionPolicyState | undefined { const policy = this.policies.get(id); return policy ? structuredClone(policy) : undefined; }
  async setPolicy(policy: RetentionPolicyState): Promise<void> {
    const input = structuredClone(policy);
    return this.enqueue(async () => {
      const changes = [this.change('policy', input.id, input, this.policies.get(input.id))];
      const wrapper = { ...this.journal, version: 1, migratedAt: this.migratedAt, policies: [] };
      if (JSON.stringify(wrapper) !== JSON.stringify(this.journal)) changes.push(this.change('journal', '', wrapper, this.journal));
      await this.requiredRepository().update(changes);
      this.policies.set(input.id, input); this.journal = wrapper;
    });
  }
  list(): RetentionJournalEntry[] { return structuredClone([...this.entries.values()]); }
  async gateNativeEffects(): Promise<void> {
    if (!await this.requiredRepository().databaseAuthority()) throw new Error('Retention database authority is required.');
  }
  get(id: string): RetentionJournalEntry | undefined { const entry = this.entries.get(id); return entry ? structuredClone(entry) : undefined; }
  async put(entry: RetentionJournalEntry): Promise<void> { await this.putMany([entry]); }
  async putMany(entries: RetentionJournalEntry[]): Promise<void> {
    const inputs = structuredClone(entries);
    for (const entry of inputs) validateOperationId(entry.id);
    return this.enqueue(async () => {
      const targets = new Map(inputs.map(entry => [entry.id, entry]));
      await this.requiredRepository().update([...targets].map(([id, value]) => this.change('entry', id, value, this.entries.get(id))));
      for (const [id, value] of targets) this.entries.set(id, value);
    });
  }
  async putIfUnchanged(updates: { previous: RetentionJournalEntry; next: RetentionJournalEntry }[], allowed: (id: string) => boolean): Promise<void> {
    const inputs = structuredClone(updates);
    for (const item of inputs) {
      validateOperationId(item.next.id);
      if (item.previous.id !== item.next.id) throw new Error('Retention guarded update cannot change operation ID.');
    }
    return this.enqueue(async () => {
      const changes: RetentionChange[] = [];
      const targets = new Map<string, RetentionJournalEntry>();
      for (const { previous, next } of inputs) {
        const current = targets.get(previous.id) ?? this.entries.get(previous.id);
        if (allowed(previous.id) && JSON.stringify(current) === JSON.stringify(previous)) {
          changes.push(this.change('entry', next.id, next, current)); targets.set(next.id, next);
        }
      }
      await this.requiredRepository().update(changes);
      for (const [id, value] of targets) this.entries.set(id, value);
    });
  }
  async removeMetadata(ids: string[]): Promise<void> {
    const inputs = [...new Set(ids)];
    return this.enqueue(async () => {
      const changes: RetentionChange[] = [];
      for (const id of inputs) {
        const entry = this.entries.get(id);
        if (entry && ['planned', 'blocked-provider'].includes(entry.phase)) changes.push({ ...this.change('entry', id, entry, entry), remove: true });
      }
      await this.requiredRepository().update(changes);
      for (const change of changes) this.entries.delete(change.id);
    });
  }
  private change(kind: RetentionChange['kind'], id: string, value: unknown, previous: unknown): RetentionChange {
    return { kind, id, json: JSON.stringify(value), previous: previous === undefined ? null : JSON.stringify(previous) };
  }
  private requiredRepository(): RetentionRepository {
    if (!this.repository) throw new Error('Shared retention storage is unavailable.');
    if (!this.started) throw new Error('Retention store has not loaded database authority.');
    return this.repository;
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writing.then(operation);
    this.writing = next.catch(error => { console.error('Retention journal write failed:', error); });
    return next;
  }
}
