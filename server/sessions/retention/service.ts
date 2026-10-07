import { createHash, randomUUID } from 'node:crypto';
import { selectRetention, type RetentionCandidate, type RetentionObservation, type RetentionRecord } from './policy.js';
import { RetentionArchive } from './archive.js';
import { RetentionStore } from './store.js';
import type { RetentionAdapter, RetentionJournalEntry, RetentionOverview } from './types.js';

export interface RetentionServiceOptions {
  store: RetentionStore;
  archive: RetentionArchive;
  adapter: RetentionAdapter;
  observe: () => Promise<RetentionObservation>;
  onArchived?: (ids: string[]) => Promise<void>;
  onError?: (error: unknown) => void;
}
export class RetentionService {
  private timer?: ReturnType<typeof setInterval>;
  private checking?: Promise<RetentionOverview>;
  private stopped = true;
  private lastCheckedAt?: string;
  private candidates = 0;
  private deferred = 0;
  private observationComplete?: boolean;
  private observationIssues: string[] = [];
  private deferredReasons: Record<string, number> = {};
  private coldBytes = 0;
  private originalBytes = 0;
  private metricError?: string;
  private verification: 'pending' | 'running' | 'complete' = 'pending';
  private verified = new Set<string>();
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: RetentionServiceOptions) {}
  async start(): Promise<void> {
    await this.options.store.start(); await this.options.archive.start();
    this.verification = 'pending'; this.verified.clear();
    this.resume();
  }
  resume(): void {
    if (this.timer) return; this.stopped = false;
    this.timer = setInterval(() => { void this.cycle().catch(error => this.report(error)); }, 3_600_000); this.timer.unref();
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async quiesce(): Promise<void> {
    this.stop();
    // Queued errors are already reported by serial/cycle; maintenance failures must not strand the worker lock.
    await Promise.allSettled([this.checking, this.operations]);
  }
  overview(): RetentionOverview {
    const entries = this.options.store.list();
    return { migratedAt: new Date(this.options.store.migratedAt).toISOString(), lastCheckedAt: this.lastCheckedAt, metricError: this.metricError,
      running: Boolean(this.checking), observationComplete: this.observationComplete, observationIssues: this.observationIssues, deferredReasons: this.deferredReasons, verification: this.verification, candidates: this.candidates, deferred: this.deferred,
      archived: entries.filter(entry => entry.phase === 'archived' && !entry.backupError).length,
      blockedProvider: entries.filter(entry => entry.phase === 'blocked-provider').length,
      backupOnly: entries.filter(entry => entry.phase === 'backup-verified' && !entry.backupError).length,
      failures: entries.filter(entry => (['conflict', 'missing-backup'].includes(entry.phase) || entry.backupError)).length,
      coldBytes: this.coldBytes, originalBytes: this.originalBytes, providers: { claude: this.options.adapter.capability('claude'), codex: this.options.adapter.capability('codex') }, entries };
  }
  cycle(): Promise<RetentionOverview> {
    if (this.checking) return this.checking;
    const task = this.serial(() => this.runCycle()); this.checking = task;
    void task.finally(() => { this.checking = undefined; }).catch(error => this.report(error));
    return task;
  }
  verifyBackups(): Promise<void> { return this.serial(() => this.verifyBackupsNow()); }
  private async verifyBackupsNow(): Promise<void> {
    if (this.verification === 'complete' && !this.options.store.list().some(entry => entry.backupError || entry.phase === 'missing-backup')) return;
    this.verification = 'running';
    for (const entry of this.options.store.list()) {
      if (this.stopped) { this.verification = 'pending'; return; }
      if (entry.phase === 'planned' || entry.phase === 'blocked-provider' || (this.verified.has(entry.id) && !entry.backupError && entry.phase !== 'missing-backup')) continue;
      try {
        await this.options.archive.verify(entry.id);
        const phase = entry.phase === 'missing-backup' ? (entry.restoredAt ? 'restored-awaiting-start' : 'backup-verified') : entry.phase;
        if (entry.backupError || entry.phase === 'missing-backup') await this.options.store.put({ ...entry, phase, backupError: undefined, error: entry.phase === 'missing-backup' ? undefined : entry.error, updatedAt: new Date().toISOString() });
        this.verified.add(entry.id);
      } catch (error) { this.verified.delete(entry.id); await this.options.store.put({ ...entry, backupError: String(error), updatedAt: new Date().toISOString() }); }
    }
    await this.countBytes(); this.verification = 'complete';
  }
  private async runCycle(): Promise<RetentionOverview> {
    await this.verifyBackupsNow();
    if (this.verification !== 'complete') return this.overview();
    const observation = await this.observe(); observation.migratedAt = this.options.store.migratedAt;
    const selected = selectRetention(observation);
    this.deferred = 0; this.deferredReasons = {};
    for (const item of selected.deferred) this.addDeferred(item.reason);
    if (observation.complete) {
      const current = new Set(selected.candidates.map(candidate => this.operationId(candidate, this.records(candidate, observation))));
      const stale: string[] = [];
      for (const entry of this.options.store.list()) if (['planned', 'blocked-provider'].includes(entry.phase) && !current.has(entry.id) && !await this.options.archive.exists(entry.id)) stale.push(entry.id);
      if (stale.length) await this.options.store.removeMetadata(stale);
    }
    this.candidates = selected.candidates.length;
    if (this.options.store.list().some(entry => entry.phase === 'missing-backup' || Boolean(entry.backupError))) { this.addDeferred('backup-unverified', selected.candidates.length); return this.overview(); }
    const started = Date.now(); let count = 0; const blockedEntries: RetentionJournalEntry[] = [];
    for (const [index, candidate] of selected.candidates.entries()) {
      if (this.stopped) { this.addDeferred('maintenance-paused', selected.candidates.length - index); break; }
      if (Date.now() - started >= 30_000) { this.addDeferred('time-budget', selected.candidates.length - index); break; }
      const records = this.records(candidate, observation);
      const id = this.operationId(candidate, records); const existing = this.options.store.get(id);
      if (existing && ['archived', 'backup-verified', 'conflict', 'missing-backup', 'restored-awaiting-start'].includes(existing.phase)) continue;
      const entry = existing || { id, candidate, phase: 'planned' as const, updatedAt: new Date().toISOString() };
      const blocked = records.map(record => this.options.adapter.capability(record.session.provider)).find(capability => capability.status === 'blocked');
      if (blocked) {
        const error = blocked.reason || 'Provider removal contract unavailable.';
        if (entry.phase !== 'blocked-provider' || entry.error !== error) blockedEntries.push({ ...entry, phase: 'blocked-provider', error, updatedAt: new Date().toISOString() });
        continue;
      }
      if (count + candidate.ids.length > 100) { this.addDeferred('session-budget'); continue; }
      await this.archiveCandidate(entry, records); count += candidate.ids.length;
    }
    if (blockedEntries.length) await this.options.store.putMany(blockedEntries);
    this.lastCheckedAt = new Date().toISOString(); await this.countBytes(); return this.overview();
  }
  cancelArchiveRequest(id: string): Promise<void> {
    return this.serial(async () => {
      const policy = this.options.store.policy(id); if (!policy?.archivedAt) return;
      await this.options.store.setPolicy({ ...policy, archivedAt: undefined, archiveRevision: policy.archiveRevision + 1 });
    });
  }
  archiveSession(id: string): Promise<RetentionOverview> { return this.serial(() => this.archiveSessionNow(id)); }
  private async archiveSessionNow(id: string): Promise<RetentionOverview> {
    this.assertRemovalReady();
    const observation = await this.observe(); observation.migratedAt = this.options.store.migratedAt;
    this.assertObservationComplete(observation);
    const record = observation.records.find(record => record.session.id === id);
    if (!record || record.kind === 'parent') throw new Error('Explicit archive requires a proven child session.');
    record.archivedAt = new Date(observation.now).toISOString(); record.archiveRevision = (record.archiveRevision || 0) + 1;
    const candidate = selectRetention(observation).candidates.find(candidate => candidate.rootId === id);
    if (!candidate) throw new Error('Child session is active, pending or has unproven termination.');
    await this.options.store.setPolicy({ id, archivedAt: record.archivedAt, archiveRevision: record.archiveRevision, restoredAt: record.restoredAt });
    const records = this.records(candidate, observation);
    const entry: RetentionJournalEntry = { id: this.operationId(candidate, records), candidate, phase: 'planned', updatedAt: new Date().toISOString() };
    const blocked = records.map(record => this.options.adapter.capability(record.session.provider)).find(capability => capability.status === 'blocked');
    if (blocked) await this.put(entry, 'blocked-provider', blocked.reason);
    else await this.archiveCandidate(entry, records);
    return this.overview();
  }
  /** Explicit backup retains every original and never claims a reduction in native scan load. */
  backup(rootId: string): Promise<{ id: string; phase: 'backup-verified' }> { return this.serial(() => this.backupNow(rootId)); }
  private async backupNow(rootId: string): Promise<{ id: string; phase: 'backup-verified' }> {
    const observation = await this.observe(); observation.migratedAt = this.options.store.migratedAt;
    this.assertObservationComplete(observation);
    const candidate = selectRetention(observation).candidates.find(candidate => candidate.rootId === rootId);
    if (!candidate) throw new Error('No eligible inactive session to back up.');
    const records = this.records(candidate, observation); const id = this.operationId(candidate, records);
    const existing = this.options.store.get(id);
    if (existing && ['archived', 'removing', 'restored-awaiting-start'].includes(existing.phase)) throw new Error('Retention operation cannot be replaced by backup-only.');
    await this.options.archive.create(id, candidate, records, await this.options.adapter.files(records));
    await this.options.store.put({ id, candidate, phase: 'backup-verified', updatedAt: new Date().toISOString() }); await this.countBytes();
    return { id, phase: 'backup-verified' };
  }
  private async archiveCandidate(entry: RetentionJournalEntry, records: RetentionRecord[]): Promise<void> {
    this.assertRemovalReady();
    const lease = await this.options.adapter.reserve(entry.candidate, records);
    if (!lease) { await this.put(entry, 'conflict', 'Admission reservation unavailable.'); return; }
    try {
      if (!await lease.revalidate()) { await this.put(entry, 'conflict', 'Retention preconditions changed.'); return; }
      await lease.preserveOwnership();
      const manifest = await this.options.archive.create(entry.id, entry.candidate, records, await this.options.adapter.files(records));
      await this.put(entry, 'backup-verified');
      if (this.stopped || !await lease.revalidate()) { await this.put(entry, 'conflict', 'Retention preconditions changed after backup.'); return; }
      await this.put(entry, 'removing'); await lease.remove(manifest);
      await this.options.archive.verify(entry.id);
      await this.options.onArchived?.(entry.candidate.ids); await this.put(entry, 'archived');
    } catch (error) { await this.put(entry, 'conflict', String(error)); }
    finally { await lease.release(); }
  }
  restore(id: string, operationId = randomUUID()): Promise<void> { return this.serial(() => this.restoreNow(id, operationId)); }
  private async restoreNow(id: string, operationId: string): Promise<void> {
    this.assertRemovalReady();
    const entry = this.options.store.get(id); if (entry?.backupError) throw new Error('Cold backup verification failed; retry verification or import a healthy backup.'); if (!entry || !['archived', 'restored-awaiting-start'].includes(entry.phase)) throw new Error('Bundle has no archived original to restore.');
    const manifest = await this.options.archive.verify(id);
    if (!this.options.adapter.restore || manifest.sessions.some(session => this.options.adapter.capability(session.provider).status !== 'supported')) throw new Error('Provider restore contract unavailable.');
    if (entry.phase === 'restored-awaiting-start' && entry.restoreOperationId !== operationId) throw new Error('Restore already completed; its original grace is retained.');
    await this.options.adapter.restore(manifest, operationId);
    for (const session of manifest.sessions) await this.options.store.setPolicy({ id: session.id, archiveRevision: (this.options.store.policy(session.id)?.archiveRevision || 0) + 1, restoredAt: entry.restoredAt || new Date().toISOString() });
    await this.options.store.put({ ...entry, phase: 'restored-awaiting-start', restoredAt: entry.restoredAt || new Date().toISOString(), restoreOperationId: operationId, updatedAt: new Date().toISOString() });
  }
  exportBundle(id: string, target: string): Promise<void> { return this.serial(() => this.exportBundleNow(id, target)); }
  private async exportBundleNow(id: string, target: string): Promise<void> {
    const entry = this.options.store.get(id); if (!entry) throw new Error('Unknown retention bundle.');
    await this.options.archive.export(id, target, entry);
  }
  importBundle(source: string): Promise<void> { return this.serial(() => this.importBundleNow(source)); }
  private async importBundleNow(source: string): Promise<void> {
    const entry = await this.options.archive.import(source); await this.options.store.put({ ...entry, backupError: undefined }); this.verified.add(entry.id); await this.countBytes();
  }
  private records(candidate: RetentionCandidate, observation: RetentionObservation): RetentionRecord[] {
    return candidate.ids.map(id => { const record = observation.records.find(record => record.session.id === id); if (!record) throw new Error('Retention candidate no longer exists.'); return record; });
  }
  private operationId(candidate: RetentionCandidate, records: RetentionRecord[]): string {
    return createHash('sha256').update(JSON.stringify({ candidate, revisions: records.map(record => [record.session.id, record.session.readRevision, record.latestTaskEndedAt, record.latestTaskEndedAt ? undefined : record.inactiveSince]) })).digest('hex');
  }
  private async put(entry: RetentionJournalEntry, phase: RetentionJournalEntry['phase'], error?: string): Promise<void> {
    await this.options.store.put({ ...entry, phase, error, updatedAt: new Date().toISOString() });
  }
  private addDeferred(reason: string, count = 1): void {
    this.deferred += count; this.deferredReasons[reason] = (this.deferredReasons[reason] || 0) + count;
  }
  private assertObservationComplete(observation: RetentionObservation): void {
    if (!observation.complete) throw new Error(`세션 기록 수집이 불완전하여 작업을 보류합니다: ${observation.issues?.join('; ') || '관찰 미완료'}`);
  }
  private assertRemovalReady(): void {
    if (this.verification !== 'complete') throw new Error('Cold backup verification is pending.');
    if (this.options.store.list().some(entry => entry.phase === 'missing-backup' || Boolean(entry.backupError))) throw new Error('A cold backup is missing; further original removal is blocked.');
  }
  private report(error: unknown): void { if (this.options.onError) this.options.onError(error); else console.error('Retention operation failed:', error); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operations.then(work); this.operations = next.catch(error => this.report(error)); return next;
  }
  private async observe(): Promise<RetentionObservation> {
    const observation = await this.options.observe();
    this.observationComplete = observation.complete; this.observationIssues = observation.issues || [];
    for (const record of observation.records) {
      const policy = this.options.store.policy(record.session.id); if (!policy) continue;
      const newer = policy.archivedAt && Date.parse(record.lastActivityAt || '') > Date.parse(policy.archivedAt);
      if (newer) { policy.archivedAt = undefined; policy.archiveRevision++; await this.options.store.setPolicy(policy); }
      record.archivedAt = policy.archivedAt; record.archiveRevision = policy.archiveRevision; record.restoredAt = policy.restoredAt;
    }
    return observation;
  }
  private async countBytes(): Promise<void> {
    try {
      this.coldBytes = await this.options.archive.diskBytes();
      this.originalBytes = (await this.options.archive.list()).reduce((sum, manifest) => sum + manifest.files.reduce((bytes, file) => bytes + file.bytes, 0), 0);
      this.metricError = undefined;
    } catch (error) { this.originalBytes = 0; this.metricError = String(error); this.report(error); }
  }
}
