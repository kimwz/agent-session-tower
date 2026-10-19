import { createHash, randomUUID } from 'node:crypto';
import { RETENTION_SESSION_BUDGET, selectRetention, type RetentionCandidate, type RetentionObservation, type RetentionRecord } from './policy.js';
import { RetentionArchive } from './archive.js';
import { retentionNodeMap } from './ancestry.js';
import { RetentionStore } from './store.js';
import type { RetentionCycleLog } from './cycle-log.js';
import type { RetentionCycleReason } from '../../../shared/retention.js';
import type { RetentionAdapter, RetentionJournalEntry, RetentionOverview, RetentionMember, RetentionOperationContext } from './types.js';

export interface RetentionServiceOptions {
  store: RetentionStore;
  archive: RetentionArchive;
  adapter: RetentionAdapter;
  observe: () => Promise<RetentionObservation>;
  reserveAdmission?: (ids: readonly string[]) => (() => void) | undefined;
  onColdChanged?: (members: RetentionMember[]) => void;
  refresh?: () => Promise<void>;
  onArchived?: (ids: string[]) => Promise<void>;
  onError?: (error: unknown) => void;
  /** Where each cycle is recorded for tracing. */
  log?: RetentionCycleLog;
  now?: () => number;
}
/** How soon a cycle looks again while a session asked to go once idle is still listed. */
const WAITING_MS = 2 * 60_000;
/** How soon a cycle comes after an archive request, or after a pause while requests wait. */
const REQUEST_MS = 5_000;
const HOUR_MS = 3_600_000;

export class RetentionService {
  private timer?: ReturnType<typeof setTimeout>;
  private catchUp = false;
  /** An archive request arrived since the last cycle began; the next one comes soon rather than in an hour. */
  private requested = false;
  /** A session asked to go once idle is still listed: looked at again soon, not an hour later (see `requestArchive`). */
  private waiting = false;
  /** Subagent parent links (hot and cold) from the latest observation, to tell whether a reopen sits under a request. */
  private parents = new Map<string, string | undefined>();
  private cycleIncomplete = false;
  /** What the current cycle moved to cold storage and how many of its candidates ended in conflict, for its record. */
  private cycleArchived: string[] = [];
  private cycleConflicts = 0;
  private cycleObserved = false;
  private nextCandidateId?: string;
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
  private activeOperation?: string;
  private inspecting?: Promise<void>;
  private coldIssues: string[] = [];
  private lastColdInspection = Number.NEGATIVE_INFINITY;
  coldInspectionIssues(): string[] { return [...this.coldIssues]; }
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: RetentionServiceOptions) {}
  async start(): Promise<void> {
    await this.options.store.start(); await this.options.archive.start(); await this.options.log?.start();
    this.verification = 'pending'; this.verified.clear();
    this.resume();
  }
  coldMembers(): RetentionMember[] {
    return this.options.store.list().flatMap(entry => entry.members || []).filter(member => member.state === 'cold');
  }
  publishCold(): void { this.options.onColdChanged?.(this.coldMembers()); }
  reconcileCold(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inspecting) return this.inspecting;
    const now = this.options.now?.() ?? Date.now();
    if (!force && now - this.lastColdInspection < 30_000) return Promise.resolve();
    this.lastColdInspection = now;
    const task = this.inspectColdNow(); this.inspecting = task;
    void task.finally(() => { this.inspecting = undefined; }).catch(error => this.report(error)); return task;
  }
  private async inspectColdNow(): Promise<void> {
    const entries = this.options.store.list().filter(entry => entry.id !== this.activeOperation && entry.members?.length);
    const members = entries.flatMap(entry => entry.members || []).filter(member => member.state !== 'restored');
    if (!members.length) { this.coldIssues = []; this.publishCold(); return; }
    const checked = await this.options.adapter.inspectCold(members);
    this.coldIssues = checked.complete ? [] : checked.issues;
    const updates = new Map(checked.members.map(member => [`${member.operationId}:${member.sessionId}`, member]));
    const changed: { previous: RetentionJournalEntry; next: RetentionJournalEntry }[] = [];
    for (const entry of entries) {
      const next = entry.members!.map(member => updates.get(`${member.operationId}:${member.sessionId}`) || member);
      if (JSON.stringify(next) === JSON.stringify(entry.members)) continue;
      // A failed intent left hot is not a restoration. Previously confirmed cold -> hot is evidence of external restore.
      const restored = next.every(member => member.state === 'restored') && Boolean(entry.restoredAt || entry.members!.some(member => member.state === 'cold'));
      changed.push({ previous: entry, next: { ...entry, members: next, phase: next.every(member => member.state === 'cold') ? 'archived' : restored ? 'restored-awaiting-start' : 'conflict', ...(restored ? { restoredAt: entry.restoredAt || new Date().toISOString() } : {}), updatedAt: new Date().toISOString() } });
    }
    if (changed.length) await this.options.store.putIfUnchanged(changed, id => !this.stopped && id !== this.activeOperation);
    this.publishCold();
  }
  async restoreSession(id: string): Promise<void> {
    const entry = this.options.store.list().find(entry => entry.members?.some(member => (member.sessionId === id || `${member.provider}:${member.nativeId}` === id) && member.state === 'cold'));
    if (!entry) return;
    await this.restore(entry.id);
  }
  private context(entry: RetentionJournalEntry, selectedRecords?: readonly RetentionRecord[]): RetentionOperationContext {
    const baseline = new Map((selectedRecords || []).map(record => [record.session.id, this.policyRevision(record)]));
    const fresh = async () => {
      await this.options.store.gateNativeEffects();
      const observation = await this.observe(); observation.migratedAt = this.options.store.migratedAt;
      await this.options.store.gateNativeEffects();
      if (!selectedRecords) return observation; // Restoration validates native ownership, not archive eligibility.
      if (!observation.complete) throw new Error('Latest retention policy observation incomplete.');
      const current = new Map(observation.records.map(record => [record.session.id, record]));
      const owned = new Map((this.options.store.get(entry.id)?.members || []).map(member => [member.sessionId, member]));
      for (const record of selectedRecords) {
        const latest = current.get(record.session.id);
        if (!latest) { if (owned.has(record.session.id)) continue; throw new Error('Retention source disappeared before ownership was established.'); }
        if (baseline.get(record.session.id) !== this.policyRevision(latest)) throw new Error('Retention policy revision changed after candidate selection.');
      }
      // Before any source leaves hot discovery, confirm the whole family is still selected.
      // Later fresh checks retain the original policy revision for every remaining hot source.
      if (selectedRecords.every(record => current.has(record.session.id))) {
        const candidate = selectRetention(observation).candidates.find(candidate => candidate.rootId === entry.candidate.rootId && candidate.reason === entry.candidate.reason);
        if (!candidate || candidate.ids.length !== entry.candidate.ids.length || entry.candidate.ids.some(id => !candidate.ids.includes(id))) throw new Error('Retention candidate is no longer eligible.');
      }
      return observation;
    };
    return { operationId: entry.id, managedCold: () => this.coldMembers(), journalMembers: () => structuredClone(this.options.store.list().flatMap(item => item.members || [])), fresh, commitMember: async member => {
      const current = this.options.store.get(entry.id) || entry;
      if (member.operationId !== entry.id || !entry.candidate.ids.includes(member.sessionId)) throw new Error('Native member operation ownership mismatch.');
      const members = new Map((current.members || []).map(item => [item.sessionId, item]));
      const previous = members.get(member.sessionId);
      if (previous) {
        if (previous.operationId !== member.operationId || previous.provider !== member.provider || previous.nativeId !== member.nativeId || previous.originalPath !== member.originalPath || previous.parentId !== member.parentId || previous.isSubagent !== member.isSubagent || previous.parentLink !== member.parentLink || previous.createdAt !== member.createdAt) throw new Error('Native member provenance cannot be replaced.');
        if (previous.provider === 'claude' && previous.coldPath && previous.coldPath !== member.coldPath) throw new Error('Managed original path cannot be replaced.');
        const relationships = new Set((member.relationships || []).map(edge=>JSON.stringify(edge)));
        if ((previous.relationships || []).some(edge=>!relationships.has(JSON.stringify(edge)))) throw new Error('Verified child relationships cannot be removed or replaced.');
        const sidecars = new Set((member.sidecars || []).map(file => JSON.stringify([file.originalPath, file.coldPath])));
        if ((previous.sidecars || []).some(file => !sidecars.has(JSON.stringify([file.originalPath, file.coldPath])))) throw new Error('Owned sidecar recovery information cannot be removed.');
      }
      // Identity/state and Codex's official archived path can change after fresh provider validation.
      members.set(member.sessionId, member);
      await this.options.store.put({ ...current, members: [...members.values()], updatedAt: new Date().toISOString() });
      this.publishCold(); // Intent must protect launcher proofs before the first physical move.
    } };
  }
  /**
   * Maintenance pauses (a worker handoff that did not happen, a storage hold) keep the cycle that was due rather than
   * starting an hour over; archive requests waiting meanwhile (or left from before a restart) bring one within seconds.
   */
  resume(): void {
    if (!this.stopped) return; this.stopped = false;
    const left = this.dueAt === undefined ? HOUR_MS : Math.max(0, this.dueAt - Date.now());
    if ((this.requested || this.options.store.requestedIds().length > 0) && left > REQUEST_MS) this.schedule(REQUEST_MS, 'resume');
    else this.schedule(left, this.dueAt === undefined ? 'hourly' : this.dueReason);
  }
  /** How long until the next cycle, as last scheduled (diagnostics and tests). */
  nextCycleIn(): number | undefined { return this.stopped ? undefined : this.delay; }
  private delay?: number;
  /** When the next cycle is due and why, kept while stopped so resuming keeps the plan. */
  private dueAt?: number;
  private dueReason: RetentionCycleReason = 'hourly';
  private schedule(delay: number, reason: RetentionCycleReason): void {
    this.delay = delay; this.dueAt = Date.now() + delay; this.dueReason = reason;
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.cycle('scheduled').catch(error => this.report(error)); }, delay);
    this.timer.unref();
  }
  /**
   * Sessions asked to go once their work is over, still waiting to: pages list them with the closed ones. A request or
   * withdrawal still queued behind a running cycle counts already, so pages follow it at once.
   */
  requestedIds(): string[] {
    const ids = new Set(this.options.store.requestedIds());
    for (const [id, intent] of this.intents) if (intent.requested) ids.add(id); else ids.delete(id);
    return [...ids];
  }
  /** Requests and withdrawals not yet written, newest per session (see `requestedIds`). */
  private intents = new Map<string, { requested: boolean; seq: number }>();
  private intentSeq = 0;
  private intend(ids: readonly string[], requested: boolean, work: () => Promise<void>): Promise<void> {
    const seq = ++this.intentSeq;
    for (const id of ids) this.intents.set(id, { requested, seq });
    return this.serial(work).finally(() => { for (const id of ids) if (this.intents.get(id)?.seq === seq) this.intents.delete(id); });
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  async quiesce(): Promise<void> {
    this.stop();
    // Queued errors are already reported by serial/cycle; maintenance failures must not strand the worker lock.
    await Promise.allSettled([this.checking, this.operations, this.inspecting]);
  }
  overview(): RetentionOverview {
    const entries = this.options.store.list();
    return { migratedAt: new Date(this.options.store.migratedAt).toISOString(), lastCheckedAt: this.lastCheckedAt, metricError: this.metricError,
      running: Boolean(this.checking), observationComplete: this.observationComplete, observationIssues: this.observationIssues, deferredReasons: this.deferredReasons, verification: this.verification, candidates: this.candidates, deferred: this.deferred,
      archived: entries.filter(entry => entry.members?.some(member => member.state === 'cold')).length,
      archivedMembers: entries.reduce((sum, entry) => sum + (entry.members?.filter(member => member.state === 'cold').length || 0), 0),
      backupFailures: entries.filter(entry => entry.backupError).length,
      blockedProvider: entries.filter(entry => entry.phase === 'blocked-provider').length,
      backupOnly: entries.filter(entry => entry.phase === 'backup-verified' && !entry.backupError).length,
      failures: entries.filter(entry => (['conflict', 'missing-backup'].includes(entry.phase) || entry.backupError)).length,
      coldBytes: this.coldBytes, originalBytes: this.originalBytes, providers: { claude: this.options.adapter.capability('claude'), codex: this.options.adapter.capability('codex') }, entries,
      ...(this.options.log ? { recentCycles: this.options.log.recent(20) } : {}) };
  }
  /**
   * `check`: the owner asked (or a test); `scheduled`: the service's own timer (or the worker's start, `startup`). One
   * already running is joined.
   */
  cycle(trigger: 'scheduled' | 'check' = 'check', startup?: 'startup'): Promise<RetentionOverview> {
    if (this.checking) return this.checking;
    const reason = trigger === 'scheduled' ? startup ?? this.dueReason : undefined;
    const task = this.serial(() => this.recordedCycle(trigger, reason)); this.checking = task;
    void task.finally(() => {
      this.checking = undefined;
      if (this.catchUp) this.schedule(1000, 'catch-up');
      else if (this.requested) this.schedule(1000, 'request');
      else if (this.waiting) this.schedule(WAITING_MS, 'waiting');
      else this.schedule(HOUR_MS, 'hourly');
    }).catch(error => this.report(error));
    return task;
  }
  private async recordedCycle(trigger: 'scheduled' | 'check', reason: RetentionCycleReason | undefined): Promise<RetentionOverview> {
    const started = Date.now(); this.cycleArchived = []; this.cycleConflicts = 0; this.cycleObserved = false;
    let failure: unknown, result: RetentionOverview | undefined;
    try { result = await this.runCycle(); }
    catch (error) { failure = error; throw error; }
    finally {
      const observed = this.cycleObserved;
      await this.options.log?.record({ trigger, ...(reason ? { reason } : {}), startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), ms: Date.now() - started,
        ...(observed ? { observationComplete: this.observationComplete } : {}), candidates: observed ? this.candidates : 0, archived: [...this.cycleArchived], conflicts: this.cycleConflicts,
        deferredReasons: observed ? { ...this.deferredReasons } : {},
        ...(failure ? { error: String(failure) } : observed ? {} : { error: this.stopped ? 'Maintenance paused before sessions were observed.' : 'Cold backup verification is not complete.' }) });
    }
    // The answer includes this cycle's own record.
    return this.options.log ? { ...result, recentCycles: this.options.log.recent(20) } : result;
  }
  verifyBackups(): Promise<void> { return this.serial(() => this.verifyBackupsNow()); }
  private async verifyBackupsNow(): Promise<void> {
    if (this.verification === 'complete' && !this.options.store.list().some(entry => entry.backupError || entry.phase === 'missing-backup')) return;
    this.verification = 'running';
    for (const entry of this.options.store.list()) {
      if (this.stopped) { this.verification = 'pending'; return; }
      if (entry.members?.length && !await this.options.archive.exists(entry.id)) continue;
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
    this.catchUp = false; this.requested = false; this.cycleIncomplete = false;
    const archivedBefore = this.coldMembers().length;
    await this.verifyBackupsNow();
    if (this.verification !== 'complete') return this.overview();
    const observation = await this.observe(); observation.migratedAt = this.options.store.migratedAt;
    this.cycleObserved = true;
    const selected = selectRetention(observation);
    // Sessions handed over to go once their work ends (a closed todo's issue master and its family) leave soon after:
    // while one waits only for its work to end, cycles come every few minutes. One held back by the owner (a reopened
    // sub-session) waits for the hourly cycle as everything else does.
    // Only work still running ends by itself soon: a lasting hold (a trigger's target, a coordinator) or a quiet session
    // with no recorded end waits for the hourly cycle as everything else does.
    const requested = new Set(observation.records.filter(record => record.archiveWhenIdle).map(record => record.session.id));
    const running = (id: string) => observation.records.some(record => (record.session.id === id || record.session.parentId === id)
      && (record.session.status === 'working' || Boolean(record.session.activeProcess) || Boolean(record.session.creationPending)));
    this.waiting = selected.deferred.some(item => requested.has(item.id) && (item.reason === 'awaiting-idle' || item.reason === 'protected') && running(item.id));
    this.deferred = 0; this.deferredReasons = {};
    for (const item of selected.deferred) this.addDeferred(item.reason);
    if (observation.complete) {
      const current = new Set(selected.candidates.map(candidate => this.operationId(candidate, this.records(candidate, observation))));
      const stale: string[] = [];
      for (const entry of this.options.store.list()) if (['planned', 'blocked-provider'].includes(entry.phase) && !current.has(entry.id) && !await this.options.archive.exists(entry.id)) stale.push(entry.id);
      if (stale.length) await this.options.store.removeMetadata(stale);
    }
    this.candidates = selected.candidates.length;
    const offset = selected.candidates.findIndex(candidate => candidate.rootId === this.nextCandidateId);
    const candidates = offset > 0 ? [...selected.candidates.slice(offset), ...selected.candidates.slice(0, offset)] : selected.candidates;
    if (!candidates.length) this.nextCandidateId = undefined;

    const started = Date.now(); let count = 0, oversized = false; const blockedEntries: RetentionJournalEntry[] = [];
    for (const [index, candidate] of candidates.entries()) {
      if (this.stopped) { this.addDeferred('maintenance-paused', candidates.length - index); break; }
      if (Date.now() - started >= 30_000) { this.addDeferred('time-budget', candidates.length - index); break; }
      this.nextCandidateId = candidates[(index + 1) % candidates.length]?.rootId;
      const records = this.records(candidate, observation);
      const id = this.operationId(candidate, records); const existing = this.options.store.get(id);
      if (existing && ((existing.members?.length && existing.members.every(member => member.state === 'cold')) || existing.phase === 'archived' || (existing.phase === 'restored-awaiting-start' && existing.restoredAt))) continue;
      const entry = existing || { id, candidate, phase: 'planned' as const, updatedAt: new Date().toISOString() };
      const blocked = records.map(record => this.options.adapter.capability(record.session.provider)).find(capability => capability.status === 'blocked');
      if (blocked) {
        if (existing?.phase === 'backup-verified') continue;
        const error = blocked.reason || 'Provider removal contract unavailable.';
        if (entry.phase !== 'blocked-provider' || entry.error !== error) blockedEntries.push({ ...entry, phase: 'blocked-provider', error, updatedAt: new Date().toISOString() });
        continue;
      }
      // The budget paces work. A requested family larger than it is still one operation, so one such
      // family goes per cycle rather than never.
      if (candidate.ids.length > RETENTION_SESSION_BUDGET && candidate.reason === 'explicit-archive' && !oversized) oversized = true;
      else if (count + candidate.ids.length > RETENTION_SESSION_BUDGET) {
        if (candidate.ids.length > RETENTION_SESSION_BUDGET) { this.addDeferred('session-budget'); continue; }
        this.nextCandidateId = candidate.rootId;
        this.addDeferred('session-budget', candidates.length - index); break;
      }
      await this.archiveCandidate(entry, records); count += candidate.ids.length;
      if (this.options.store.get(entry.id)?.phase === 'conflict') this.cycleConflicts++;
    }
    if (blockedEntries.length) await this.options.store.putMany(blockedEntries);
    if (observation.complete) await this.prunePolicies(observation);
    this.catchUp = observation.complete && !this.cycleIncomplete && this.coldMembers().length > archivedBefore
      && Boolean(this.deferredReasons['time-budget'] || this.deferredReasons['session-budget']);
    this.lastCheckedAt = new Date().toISOString(); await this.countBytes(); return this.overview();
  }
  /**
   * Reopening withdraws this session's archive request. Under an ancestor's pending request it also
   * records the reopen, which keeps the session out of that request (see selectRetention).
   */
  cancelArchiveRequest(id: string): Promise<void> {
    return this.serial(async () => {
      const policy = this.options.store.policy(id);
      const underRequest = this.parents.has(id) ? this.ancestorRequested(id) : this.options.store.policyList().some(other => other.archiveWhenIdle);
      if (!policy?.archivedAt && !policy?.archiveWhenIdle && !underRequest) return;
      const { archiveWhenIdle: _, archiveRequestedAt: __, ...kept } = policy || { id, archiveRevision: 0 };
      await this.options.store.setPolicy({ ...kept, archivedAt: undefined, archiveRevision: kept.archiveRevision + 1,
        ...(underRequest ? { reopenedAt: new Date(this.options.now?.() ?? Date.now()).toISOString() } : {}) });
    });
  }
  private ancestorRequested(id: string): boolean {
    const seen = new Set<string>();
    for (let parent = this.parents.get(id); parent && !seen.has(parent); parent = this.parents.get(parent)) {
      seen.add(parent); if (this.options.store.policy(parent)?.archiveWhenIdle) return true;
    }
    return false;
  }
  /**
   * Policy rows stay bounded by live requests and archived sessions: a request for a session that is
   * neither hot nor cold is gone, and a row left with only a reopen no request covers carries nothing.
   * Runs after the cycle's operations, so no selected candidate sees its revision reset.
   */
  private async prunePolicies(observation: RetentionObservation): Promise<void> {
    const hot = new Set(observation.records.map(record => record.session.id));
    const cold = new Set(this.options.store.list().flatMap(entry => entry.members || []).filter(member => member.state !== 'restored').map(member => member.sessionId));
    const stale = this.options.store.policyList().filter(policy => {
      if (policy.archiveWhenIdle) return !hot.has(policy.id) && !cold.has(policy.id);
      return !policy.archivedAt && !policy.restoredAt && !(policy.reopenedAt && this.ancestorRequested(policy.id));
    }).map(policy => policy.id);
    if (stale.length) await this.options.store.removePolicies(stale);
  }
  /**
   * Records that these sessions leave for cold storage once they settle (see selectRetention).
   * Nothing is checked or moved here: parents and masters are accepted, and a busy session simply
   * waits. The request lasts across restarts until the session is archived or reopened.
   */
  async requestArchive(ids: readonly string[]): Promise<{ requested: number }> {
    const unique = [...new Set(ids)];
    await this.intend(unique, true, async () => {
      const at = new Date(this.options.now?.() ?? Date.now()).toISOString();
      for (const id of unique) {
        const policy = this.options.store.policy(id) || { id, archiveRevision: 0 };
        if (!policy.archiveWhenIdle) await this.options.store.setPolicy({ ...policy, archiveWhenIdle: true, archiveRequestedAt: at, archiveRevision: policy.archiveRevision + 1 });
      }
      // Several closings tend to arrive together; one cycle a few seconds later takes them all. While maintenance is
      // paused this only notes the cycle as due; resuming brings it.
      this.requested = true; if (!this.checking) this.schedule(REQUEST_MS, 'request');
    });
    return { requested: unique.length };
  }
  /**
   * Takes back the archive requests these sessions carry themselves (a reopened todo's family still listed): they
   * stay where they are and show again. Unlike reopening, nothing is restored and no reopen is recorded.
   */
  async withdrawArchiveRequests(ids: readonly string[]): Promise<{ withdrawn: number }> {
    const unique = [...new Set(ids)]; let withdrawn = 0;
    await this.intend(unique, false, async () => {
      for (const id of unique) {
        const policy = this.options.store.policy(id);
        if (!policy?.archiveWhenIdle) continue;
        const { archiveWhenIdle: _, archiveRequestedAt: __, ...kept } = policy;
        await this.options.store.setPolicy({ ...kept, archiveRevision: kept.archiveRevision + 1 }); withdrawn++;
      }
    });
    return { withdrawn };
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
    await this.options.store.setPolicy({ ...this.options.store.policy(id), id, archivedAt: record.archivedAt, archiveRevision: record.archiveRevision, restoredAt: record.restoredAt });
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
    if (existing && (existing.members?.length || ['archived', 'removing', 'restored-awaiting-start'].includes(existing.phase))) throw new Error('Retention operation with native ownership cannot be replaced by backup-only.');
    await this.options.archive.create(id, candidate, records, await this.options.adapter.files(records));
    await this.options.store.put({ id, candidate, phase: 'backup-verified', updatedAt: new Date().toISOString() }); await this.countBytes();
    return { id, phase: 'backup-verified' };
  }
  private async archiveCandidate(entry: RetentionJournalEntry, records: RetentionRecord[]): Promise<void> {
    this.assertRemovalReady();
    const admissionIds = new Set(entry.candidate.ids);
    // Already-cold descendants are still in Codex's native subtree and must not be resumed mid-operation.
    const cold = this.coldMembers(); let expanded = true;
    while (expanded) { expanded = false; for (const member of cold) if (member.parentId && admissionIds.has(member.parentId) && !admissionIds.has(member.sessionId)) { admissionIds.add(member.sessionId); expanded = true; } }
    const releaseAdmission = this.options.reserveAdmission?.([...admissionIds]);
    if (this.options.reserveAdmission && !releaseAdmission) { await this.put(entry, 'conflict', 'Admission reservation unavailable.'); return; }
    this.activeOperation = entry.id;
    let lease: Awaited<ReturnType<RetentionAdapter['reserve']>>;
    try {
      lease = await this.options.adapter.reserve(entry.candidate, records, this.context(entry, records));
      if (!lease) { await this.put(entry, 'conflict', 'Provider reservation unavailable.'); return; }
      if (!await lease.revalidate()) { await this.put(entry, 'conflict', 'Retention preconditions changed.'); return; }
      await lease.preserveOwnership(); await this.put(entry, 'removing');
      const members = await lease.moveCold();
      this.cycleArchived.push(...members.filter(member => member.state === 'cold').map(member => member.sessionId));
      this.publishCold();
      const current = this.options.store.get(entry.id) || entry;
      if (!members.length || members.some(member => member.state !== 'cold')) {
        await this.options.store.put({ ...current, phase: 'conflict', error: 'Some members could not be moved to cold storage.', updatedAt: new Date().toISOString() }); return;
      }
      await this.options.store.put({ ...current, phase: 'archived', updatedAt: new Date().toISOString() });
      try {
        await this.options.archive.create(entry.id, entry.candidate, records, await lease.sources(members));
        await this.options.archive.verify(entry.id); this.verified.add(entry.id);
      } catch (error) {
        const archived = this.options.store.get(entry.id)!;
        await this.options.store.put({ ...archived, backupError: String(error), updatedAt: new Date().toISOString() });
      }
      await this.options.onArchived?.(entry.candidate.ids);
    } catch (error) { await this.put(entry, 'conflict', String(error)); }
    finally {
      this.activeOperation = undefined; this.publishCold();
      try { await this.options.refresh?.(); } finally { await lease?.release(); releaseAdmission?.(); }
    }
  }
  restore(id: string, operationId = randomUUID()): Promise<void> { return this.serial(() => this.restoreNow(id, operationId)); }
  private async restoreNow(id: string, operationId: string): Promise<void> {
    const entry = this.options.store.get(id);
    if (!entry || !entry.members?.some(member => member.coldPath && ['cold', 'intent', 'conflict'].includes(member.state))) throw new Error('Bundle has no archived original to restore.');
    if (!this.options.adapter.restore) throw new Error('Provider restore contract unavailable.');
    await this.options.store.gateNativeEffects();
    const members = entry.members.filter(member => member.coldPath && ['cold', 'intent', 'conflict'].includes(member.state));
    const releaseAdmission = this.options.reserveAdmission?.(members.flatMap(member => [member.sessionId, ...(member.provider === 'claude' && member.parentId ? [member.parentId] : [])]));
    if (this.options.reserveAdmission && !releaseAdmission) throw new Error('Session has active or pending work.');
    this.activeOperation = entry.id;
    try {
      // Native originals remain restorable even if the optional transcript export is damaged.
      const manifest = {
        version: 1 as const, id, createdAt: entry.updatedAt, reason: entry.candidate.reason, files: [],
        sessions: members.map(member => ({ id: member.sessionId, nativeId: member.nativeId, provider: member.provider, parentId: member.parentId, title: member.sessionId })) };
      await this.options.adapter.restore(manifest, operationId, members, this.context(entry));
      const current = this.options.store.get(id)!;
      const restoredAt = entry.restoredAt || new Date().toISOString();
      // An archive request outlives a restore (a closed issue's session resumed by a message goes back
      // once it settles); only reopening the session cancels it.
      for (const member of current.members || []) if (member.state === 'restored') {
        const { archivedAt: _, ...previous } = this.options.store.policy(member.sessionId) || { id: member.sessionId, archiveRevision: 0 };
        await this.options.store.setPolicy({ ...previous, archiveRevision: previous.archiveRevision + 1, restoredAt });
      }
      await this.options.store.put({ ...current, phase: current.members?.every(member => member.state === 'restored') ? 'restored-awaiting-start' : 'conflict', restoredAt, restoreOperationId: operationId, updatedAt: new Date().toISOString() });
    } catch (error) { await this.put(entry, 'conflict', String(error)); throw error; }
    finally {
      this.activeOperation = undefined; this.publishCold();
      try { await this.options.refresh?.(); } finally { releaseAdmission?.(); }
    }
  }
  exportBundle(id: string, target: string): Promise<void> { return this.serial(() => this.exportBundleNow(id, target)); }
  private async exportBundleNow(id: string, target: string): Promise<void> {
    const entry = this.options.store.get(id); if (!entry) throw new Error('Unknown retention bundle.');
    await this.options.archive.export(id, target, entry);
  }
  importBundle(source: string): Promise<void> { return this.serial(() => this.importBundleNow(source)); }
  private async importBundleNow(source: string): Promise<void> {
    const entry = await this.options.archive.import(source);
    // An exported journal is not ownership proof for local native/cold paths. Imported payloads are transcript-only.
    const owned = this.options.store.get(entry.id);
    await this.options.store.put(owned?.members?.length ? { ...owned, backupError: undefined } : { ...entry, members: undefined, phase: 'backup-verified', backupError: undefined }); this.verified.add(entry.id); await this.countBytes();
  }
  private records(candidate: RetentionCandidate, observation: RetentionObservation): RetentionRecord[] {
    return candidate.ids.map(id => { const record = observation.records.find(record => record.session.id === id); if (!record) throw new Error('Retention candidate no longer exists.'); return record; });
  }
  private policyRevision(record: RetentionRecord): string {
    return JSON.stringify([record.session.provider, record.session.nativeId, record.session.createdAt, record.session.readRevision,
      record.session.parentId, record.session.isSubagent, record.session.parentLink, record.kind, record.projectKey,
      record.latestTaskEndedAt, record.lastActivityAt, record.latestTaskEndedAt ? undefined : record.inactiveSince,
      record.archivedAt, record.archiveRevision || 0, record.restoredAt, record.archiveWhenIdle, record.archiveRequestedAt, record.reopenedAt]);
  }
  private operationId(candidate: RetentionCandidate, records: RetentionRecord[]): string {
    return createHash('sha256').update(JSON.stringify({ candidate, revisions: records.map(record => [record.session.id, record.session.readRevision, record.latestTaskEndedAt, record.latestTaskEndedAt ? undefined : record.inactiveSince]) })).digest('hex');
  }
  private async put(entry: RetentionJournalEntry, phase: RetentionJournalEntry['phase'], error?: string): Promise<void> {
    await this.options.store.put({ ...(this.options.store.get(entry.id) || entry), phase, error, updatedAt: new Date().toISOString() });
  }
  private addDeferred(reason: string, count = 1): void {
    this.deferred += count; this.deferredReasons[reason] = (this.deferredReasons[reason] || 0) + count;
  }
  private assertObservationComplete(observation: RetentionObservation): void {
    if (!observation.complete) throw new Error(`세션 기록 수집이 불완전하여 작업을 보류합니다: ${observation.issues?.join('; ') || '관찰 미완료'}`);
  }
  private assertRemovalReady(): void {
    if (this.verification !== 'complete') throw new Error('Cold backup verification is pending.');

  }
  private report(error: unknown): void { if (this.options.onError) this.options.onError(error); else console.error('Retention operation failed:', error); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operations.then(work); this.operations = next.catch(error => this.report(error)); return next;
  }
  private async observe(): Promise<RetentionObservation> {
    let observation: RetentionObservation;
    try { observation = await this.options.observe(); }
    catch (error) { this.cycleIncomplete = true; throw error; }
    this.observationComplete = observation.complete; this.cycleIncomplete ||= !observation.complete; this.observationIssues = observation.issues || [];
    // Cold ancestry counts too: a request two levels up reaches a hot child through a cold parent, as selection sees it.
    if (observation.complete) this.parents = new Map([...new Set(retentionNodeMap(observation).values())].map(node => [node.id, node.isSubagent ? node.parentId : undefined]));
    for (const record of observation.records) {
      const policy = this.options.store.policy(record.session.id); if (!policy) continue;
      const newer = policy.archivedAt && Date.parse(record.lastActivityAt || '') > Date.parse(policy.archivedAt);
      if (newer) { policy.archivedAt = undefined; policy.archiveRevision++; await this.options.store.setPolicy(policy); }
      record.archivedAt = policy.archivedAt; record.archiveRevision = policy.archiveRevision; record.restoredAt = policy.restoredAt;
      record.archiveWhenIdle = policy.archiveWhenIdle; record.archiveRequestedAt = policy.archiveRequestedAt; record.reopenedAt = policy.reopenedAt;
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
