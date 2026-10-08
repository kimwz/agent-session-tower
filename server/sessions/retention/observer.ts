import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { Run, Session } from '../../../shared/types.js';
import { readPrivateJson, writePrivateJson } from '../../stores/private-json.js';
import { resolveRetentionLineage } from './ancestry.js';
import type { RetentionMember } from '../../../shared/retention.js';
import type { RetentionObservation, RetentionRecord } from './policy.js';

/** An execution result stays protected until delivered, even if no notification was requested. */
export function permissionRetentionPending(request: { status: string; notification?: { state: string }; run?: { status: string; delivered?: boolean } }): boolean {
  return request.status === 'pending' || request.notification?.state === 'pending' || Boolean(request.run && (!request.run.delivered || request.run.status === 'waiting' || request.run.status === 'running'));
}

export interface NativeRetentionObservation {
  complete: boolean;
  issues?: string[];
  records: { session: Session; internal: boolean; fingerprint: string; lastActivityAt?: string; latestTaskEndedAt?: string }[];
  launchers?: ReadonlyMap<string, readonly string[]>;
}
interface InactiveObservation { fingerprint: string; since: string; observedAt: number }
export interface RetentionObserverOptions {
  stateDir: string;
  snapshot: () => NativeRetentionObservation | Promise<NativeRetentionObservation>;
  reconcile: (sessions: Session[]) => Session[];
  runs: () => Run[];
  settled: () => ReadonlySet<string>;
  /** Native/monitor qualified IDs of coordinators, pending results, permissions and automation references. */
  protectedIds: () => Iterable<string>;
  projectIdentity?: (cwd: string) => Promise<string | undefined>;
  now?: () => number;
  journalMembers?: () => RetentionMember[];
}
const exec = promisify(execFile);
/** Existing git metadata proves linked worktrees share one project. Missing folders stay unclassified. */
export async function gitProjectIdentity(cwd: string): Promise<string | undefined> {
  if (!isAbsolute(cwd)) return undefined;
  try {
    await realpath(cwd);
    const result = await exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      timeout: 2000, maxBuffer: 8192, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const path = result.stdout.trim();
    return isAbsolute(path) ? await realpath(path) : undefined;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
    // Missing/not-repository/timeout never become an invented project identity.
    if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR' || typeof failure.code === 'number' || failure.killed) return undefined;
    throw error;
  }
}

export class RetentionObserver {
  private inactive = new Map<string, InactiveObservation>();
  private restarted = true;
  private observing?: Promise<RetentionObservation>;
  private readonly path: string;
  constructor(private readonly options: RetentionObserverOptions) { this.path = join(options.stateDir, 'retention-observations.json'); }
  async start(): Promise<void> {
    try {
      const data = await readPrivateJson(this.path, 8_000_000) as { version: number; entries: [string, InactiveObservation][] };
      if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Invalid retention observations.');
      for (const [id, entry] of data.entries) {
        if (typeof id !== 'string' || !entry || typeof entry.fingerprint !== 'string' || !Number.isFinite(entry.observedAt) || !Number.isFinite(Date.parse(entry.since))) throw new Error('Invalid inactive observation.');
        this.inactive.set(id, entry);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  observe(): Promise<RetentionObservation> {
    if (this.observing) return this.observing;
    const task = this.readObservation(); this.observing = task;
    void task.then(() => { this.observing = undefined; }, error => {
      this.observing = undefined;
      console.error(`Retention observation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return task;
  }
  private async readObservation(): Promise<RetentionObservation> {
    let snapshot: NativeRetentionObservation;
    try { snapshot = await this.options.snapshot(); }
    catch (error) { this.inactive.clear(); this.restarted = true; throw error; }
    const now = this.options.now?.() ?? Date.now();
    const lineage=resolveRetentionLineage(this.options.reconcile(snapshot.records.map(record => record.session)),this.options.journalMembers?.() || [],snapshot.launchers);
    const sessions = lineage.sessions;
    const byNative = new Map(sessions.map(session => [`${session.provider}:${session.nativeId}`, session]));
    const aliases = new Map<string, string>();
    for (const session of [...lineage.ancestry,...sessions]) { aliases.set(session.id, session.id); aliases.set(`${session.provider}:${session.nativeId}`, session.id); }
    const protectedIds = new Set<string>();
    const protect = (id: string) => { protectedIds.add(aliases.get(id) ?? id); };
    for (const id of this.options.protectedIds()) protect(id);
    const settled = this.options.settled();
    for (const run of this.options.runs()) {
      if (run.status === 'queued' || run.status === 'running' || run.approvals?.length || run.backgroundWait || !settled.has(run.id)) protect(run.sessionId);
    }
    for (const session of sessions) if (session.activeProcess || session.status === 'working' || session.creationPending || session.scheduledAt) protect(session.id);
    const byId = lineage.nodes;
    const parentOf = (session: {parentId?:string;provider:string}) => session.parentId ? aliases.get(session.parentId) ?? aliases.get(`${session.provider}:${session.parentId}`) ?? session.parentId : undefined;
    for (const raw of snapshot.records) {
      const session = byNative.get(`${raw.session.provider}:${raw.session.nativeId}`) ?? raw.session;
      if (session.provider !== 'claude' || !session.isSubagent) continue;
      const seen = new Set<string>();
      for (let parent = parentOf(session); parent && !seen.has(parent); parent = byId.get(parent) && parentOf(byId.get(parent)!)) {
        seen.add(parent);
        if (protectedIds.has(parent)) { protect(session.id); break; }
      }
    }
    const records: RetentionRecord[] = [];
    const projects = new Map<string, string | undefined>();
    const projectDeadline = Date.now() + 10_000;
    const current = new Map<string, InactiveObservation>();
    for (const raw of snapshot.records) {
      const reconciled = byNative.get(`${raw.session.provider}:${raw.session.nativeId}`) ?? raw.session;
      const session = { ...reconciled };
      if (session.parentId) session.parentId = aliases.get(session.parentId) ?? aliases.get(`${session.provider}:${session.parentId}`) ?? session.parentId;
      const inactive = snapshot.complete && !protectedIds.has(session.id);
      const previous = this.inactive.get(session.id);
      let observation: InactiveObservation | undefined;
      if (inactive) {
        observation = previous && !this.restarted && previous.fingerprint === raw.fingerprint && now >= previous.observedAt && now - previous.observedAt <= 7_200_000
          ? { ...previous, observedAt: now }
          : { fingerprint: raw.fingerprint, since: new Date(now).toISOString(), observedAt: now };
        current.set(session.id, observation);
      }
      const kind = raw.internal ? 'guardian' : session.isSubagent ? 'subagent' : session.launchedByAgent ? 'helper' : 'parent';
      const needsProject = kind === 'parent' && !session.master;
      if (needsProject && !projects.has(session.cwd)) projects.set(session.cwd, Date.now() < projectDeadline
        ? await (this.options.projectIdentity ?? gitProjectIdentity)(session.cwd) : undefined);
      records.push({ session, kind,
        projectKey: needsProject ? projects.get(session.cwd) : undefined, lastActivityAt: raw.lastActivityAt,
        latestTaskEndedAt: raw.latestTaskEndedAt, inactiveSince: observation?.since });
    }
    try { await writePrivateJson(this.path, JSON.stringify({ version: 1, entries: [...current] }), { syncDirectory: true }); }
    catch (error) { this.inactive.clear(); this.restarted = true; throw error; }
    this.inactive = current; this.restarted = false;
    return { now, migratedAt: 0, complete: snapshot.complete, issues: snapshot.issues, records, protectedIds, ancestry:lineage.ancestry, blockedIds:lineage.blockedIds };
  }
}
