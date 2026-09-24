import type { AutoPromptJob, ChatMessage, ProjectGroup, ProviderHealth, Run, Session, SessionDetail, Snapshot } from '../../shared/types.js';
import type { RepositoryStatus } from '../../shared/repositories.js';
import type { ExclusionMatcher, RemoteExclusionStore } from './exclusions.js';

/** What decides whether something on this machine can reach a remote controller. */
export interface RemoteScope {
  matcher: ExclusionMatcher;
  /** Coordinator conversations (Slack, GitHub) stay on this machine. */
  coordinators: ReadonlySet<string>;
}

/**
 * Sessions a remote controller may see: not in an excluded folder, not a coordinator conversation, and with a
 * visible parent chain. A subagent whose parent is unknown here stays private rather than guessed at.
 */
export function remoteSessionIds(sessions: readonly Session[], scope: RemoteScope): Set<string> {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const decided = new Map<string, boolean>();
  const visible = (session: Session, depth = 0): boolean => {
    const known = decided.get(session.id);
    if (known !== undefined) return known;
    let result = depth < 32 && !scope.coordinators.has(session.id) && !scope.matcher.excludes(session.cwd);
    if (result && session.parentId) {
      const parent = byId.get(session.parentId);
      result = parent ? visible(parent, depth + 1) : false;
    }
    decided.set(session.id, result);
    return result;
  };
  return new Set(sessions.filter(session => visible(session)).map(session => session.id));
}

/** An Auto Prompt job is visible only when every folder and session it touched is. */
export function remoteJobVisible(job: AutoPromptJob, scope: RemoteScope, sessions: ReadonlySet<string>, controllerId?: string): boolean {
  if (job.cwd && scope.matcher.excludes(job.cwd)) return false;
  if (job.decision && scope.matcher.excludes(job.decision.cwd)) return false;
  if (job.decision?.sessionId && !sessions.has(job.decision.sessionId)) return false;
  if (job.sessionId && !sessions.has(job.sessionId)) return false;
  // A job still choosing its folder has touched nothing yet; only the controller that asked for it sees it.
  if (!job.cwd && !job.decision) return Boolean(controllerId) && job.origin?.controllerId === controllerId;
  return true;
}

/**
 * The working view for remote work inside this machine: the same snapshot with excluded folders, their
 * sessions and runs, and coordinator conversations removed. Auto Prompt routes remote requests with it.
 */
export function remoteWorkingSnapshot(snapshot: Snapshot, scope: RemoteScope): Snapshot {
  const ids = remoteSessionIds(snapshot.sessions, scope);
  return { ...snapshot,
    sessions: snapshot.sessions.filter(session => ids.has(session.id)),
    runs: snapshot.runs.filter(run => ids.has(run.sessionId)),
    ...(snapshot.groups ? { groups: snapshot.groups.filter(group => !scope.matcher.excludes(group.cwd)) } : {}),
    ...(snapshot.autoPrompts ? { autoPrompts: snapshot.autoPrompts.filter(job => remoteJobVisible(job, scope, ids, job.origin?.controllerId)) } : {}),
  };
}

const pick = <T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> => {
  const result = {} as Pick<T, K>;
  for (const key of keys) if (value[key] !== undefined) result[key] = value[key];
  return result;
};
const SESSION_FIELDS = ['id', 'nativeId', 'provider', 'title', 'customTitle', 'closed', 'creationPending', 'cwd', 'project', 'parentId', 'parentLink',
  'launchedByAgent', 'launchedBy', 'agentName', 'model', 'contextUsage', 'status', 'statusReason', 'createdAt', 'updatedAt', 'lastRequestAt',
  'lastCompletedAt', 'lastMessage', 'messageCount', 'readRevision', 'isSubagent', 'resumable', 'activeProcess', 'scheduledAt'] as const satisfies readonly (keyof Session)[];
const RUN_FIELDS = ['id', 'sessionId', 'unattended', 'towerTools', 'prompt', 'status', 'createdAt', 'startedAt', 'finishedAt', 'output', 'error', 'attachments', 'model',
  'effort', 'codexApprovalsReviewer', 'autoPromptId', 'contextUsage', 'approvals', 'canSteer', 'steering', 'scheduled'] as const satisfies readonly (keyof Run)[];
const JOB_FIELDS = ['id', 'unattended', 'untrustedInput', 'sessionMode', 'model', 'effort', 'provider', 'cwd', 'prompt', 'codexApprovalsReviewer', 'routerModel',
  'status', 'stage', 'createdAt', 'updatedAt', 'attachments', 'sessionId', 'runId', 'error'] as const satisfies readonly (keyof AutoPromptJob)[];

export function remoteSession(session: Session): Session { return pick(session, SESSION_FIELDS) as Session; }
export function remoteRun(run: Run): Run {
  return { ...pick(run, RUN_FIELDS), ...(run.origin ? { origin: { kind: run.origin.kind, ...(run.origin.controllerId ? { controllerId: run.origin.controllerId } : {}) } } : {}) } as Run;
}
/**
 * A routing explanation can quote other candidates' conversations. It is shown only for this controller's own
 * request, routed with the exclusion list still in force; otherwise the decision keeps its folder and session only.
 */
export function remoteJob(job: AutoPromptJob, controllerId: string | undefined, exclusionRevision: number): AutoPromptJob {
  const own = Boolean(controllerId) && job.origin?.controllerId === controllerId && job.exclusionRevision === exclusionRevision;
  return { ...pick(job, JOB_FIELDS),
    ...(job.origin ? { origin: { kind: job.origin.kind, ...(job.origin.controllerId ? { controllerId: job.origin.controllerId } : {}) } } : {}),
    ...(own && job.routingContext !== undefined ? { routingContext: job.routingContext } : {}),
    ...(job.decision ? { decision: { action: job.decision.action, cwd: job.decision.cwd, ...(job.decision.sessionId ? { sessionId: job.decision.sessionId } : {}), reason: own ? job.decision.reason : '' } } : {}),
  } as AutoPromptJob;
}
function remoteGroup(group: ProjectGroup): ProjectGroup { return { cwd: group.cwd, title: group.title, pinned: group.pinned }; }
function remoteProvider(provider: ProviderHealth, sessionCount: number): ProviderHealth {
  return { provider: provider.provider, available: provider.available, sessionCount,
    ...(provider.usage ? { usage: { status: provider.usage.status, windows: provider.usage.windows.map(window => pick(window, ['id', 'usedPercent', 'windowMinutes', 'resetsAt'] as const)),
      ...(provider.usage.updatedAt ? { updatedAt: provider.usage.updatedAt } : {}), ...(provider.usage.stale ? { stale: true } : {}) } } : {}),
    ...(provider.models ? { models: structuredClone(provider.models) } : {}), ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
    ...(provider.efforts ? { efforts: structuredClone(provider.efforts) } : {}), ...(provider.defaultEffort ? { defaultEffort: provider.defaultEffort } : {}) };
}
/** Git errors can name other folders; a remote controller gets the branch state without the raw text. */
export function remoteRepository(status: RepositoryStatus): RepositoryStatus {
  return { ...pick(status, ['cwd', 'root', 'branch', 'upstream', 'ahead', 'behind', 'changes', 'checkedAt', 'fetchedAt'] as const),
    ...(status.lastAction ? { lastAction: pick(status.lastAction, ['kind', 'ok', 'commits', 'at'] as const) } : {}) };
}
const MESSAGE_FIELDS = ['id', 'role', 'text', 'timestamp', 'toolName', 'isError'] as const satisfies readonly (keyof ChatMessage)[];
/** One page of a shared conversation. */
export function remotePage(page: SessionDetail): SessionDetail {
  return { session: remoteSession(page.session), messages: page.messages.map(message => pick(message, MESSAGE_FIELDS) as ChatMessage), hasMore: page.hasMore,
    ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}), ...(page.previousUser ? { previousUser: pick(page.previousUser, MESSAGE_FIELDS) as ChatMessage } : {}) };
}

/**
 * The snapshot a remote controller receives. It is built from an allowlist: a field added to the local
 * snapshot later never reaches a remote controller until it is listed here with its own rule.
 */
export function remoteSnapshot(snapshot: Snapshot, scope: RemoteScope, controllerId?: string): Snapshot {
  const ids = remoteSessionIds(snapshot.sessions, scope);
  const sessions = snapshot.sessions.filter(session => ids.has(session.id)).map(remoteSession);
  return {
    sessions,
    runs: snapshot.runs.filter(run => ids.has(run.sessionId)).map(remoteRun),
    providers: snapshot.providers.map(provider => remoteProvider(provider, sessions.filter(session => session.provider === provider.provider).length)),
    ...(snapshot.groups ? { groups: snapshot.groups.filter(group => !scope.matcher.excludes(group.cwd)).map(remoteGroup) } : {}),
    ...(snapshot.autoPrompts ? { autoPrompts: snapshot.autoPrompts.filter(job => remoteJobVisible(job, scope, ids, controllerId)).map(job => remoteJob(job, controllerId, scope.matcher.revision)) } : {}),
    ...(snapshot.repositories ? { repositories: snapshot.repositories.filter(status => !scope.matcher.excludes(status.cwd) && !scope.matcher.excludes(status.root)).map(remoteRepository) } : {}),
    scanning: snapshot.scanning, hostname: snapshot.hostname, version: snapshot.version,
    ...(snapshot.runnerVersion ? { runnerVersion: snapshot.runnerVersion } : {}),
    ...(snapshot.runnerUpdate ? { runnerUpdate: snapshot.runnerUpdate } : {}),
    updatedAt: snapshot.updatedAt,
  };
}

/**
 * Work a trigger set up from a controlling computer starts never uses a folder kept out of sharing. `prepareRun` reads
 * the list as saved now and looks again where a waiting run's folder really is, right before the run is judged;
 * `refused` then answers at once.
 */
export function remoteTriggerLaunch(exclusions: Pick<RemoteExclusionStore, 'reload' | 'prepare' | 'matcher'>, runs: { list(): Run[]; getSession(id: string): Session | undefined }) {
  const remote = (run: Run) => run.origin?.kind === 'trigger' && Boolean(run.origin.controllerId);
  return {
    async prepareRun(run: Run): Promise<void> {
      const cwd = remote(run) ? runs.getSession(run.sessionId)?.cwd : undefined;
      if (cwd === undefined) return;
      await exclusions.reload();
      await exclusions.prepare([cwd], { fresh: true });
    },
    refused(run: Run): boolean {
      if (!remote(run)) return false;
      const cwd = runs.getSession(run.sessionId)?.cwd;
      return cwd !== undefined && exclusions.matcher().excludes(cwd);
    },
  };
}
