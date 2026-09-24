import type { AutoPromptJob, ProjectGroup, Run, Session, SessionDetail, Snapshot } from '../../../shared/types';
import type { RepositoryStatus } from '../../../shared/repositories';

/*
 * Items of a joined computer keep their own ids on that computer. In this page they are named by the computer
 * too, `@<node>/<id>`, so two computers with the same folder or session id never meet in one list, one canvas
 * frame or one saved preference. Everything of this computer keeps its plain id, as before.
 */
const SCOPED = /^@([a-f0-9]{32})\/([\s\S]+)$/;

export function scopedId(node: string | undefined, id: string): string { return node ? `@${node}/${id}` : id; }
export function splitScopedId(value: string): { node?: string; id: string } {
  const match = SCOPED.exec(value);
  return match ? { node: match[1], id: match[2] } : { id: value };
}
export const nodeOf = (value: string | undefined): string | undefined => value ? SCOPED.exec(value)?.[1] : undefined;
/** The id or folder as that computer knows it. */
export const localPart = (value: string): string => splitScopedId(value).id;

/** A path of this Tower's API that reaches `node` through its link, or this computer when there is none. */
export function nodePath(node: string | undefined, path: string): string {
  return node ? `/api/nodes/${node}/${path.slice('/api/'.length)}` : path;
}
/** The API path for something named by a scoped id: `build` receives the id that computer knows. */
export function pathFor(scoped: string, build: (id: string) => string): string {
  const { node, id } = splitScopedId(scoped);
  return nodePath(node, build(id));
}

/** A time-ordered UUID, which another computer requires to run a new request at most once. */
export function requestId(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = now;
  for (let index = 5; index >= 0; index--) { bytes[index] = time % 256; time = Math.floor(time / 256); }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Headers for a change sent to `node`; a request that creates work names itself so a retry never runs twice. */
export function nodeHeaders(node: string | undefined, headers: Record<string, string>): Record<string, string> {
  return node ? { ...headers, 'X-Tower-Request-Id': requestId() } : headers;
}

export function scopeSession(node: string, session: Session): Session {
  return { ...session, id: scopedId(node, session.id), cwd: session.cwd ? scopedId(node, session.cwd) : '', node,
    ...(session.parentId ? { parentId: scopedId(node, session.parentId) } : {}) };
}
export function scopeRun(node: string, run: Run): Run {
  return { ...run, id: scopedId(node, run.id), sessionId: scopedId(node, run.sessionId), node,
    ...(run.attachments ? { attachments: run.attachments.map(attachment => ({ ...attachment, id: scopedId(node, attachment.id) })) } : {}) };
}
export function scopeJob(node: string, job: AutoPromptJob): AutoPromptJob {
  return { ...job, id: scopedId(node, job.id), node,
    ...(job.cwd ? { cwd: scopedId(node, job.cwd) } : {}),
    ...(job.sessionId ? { sessionId: scopedId(node, job.sessionId) } : {}),
    ...(job.decision ? { decision: { ...job.decision, cwd: scopedId(node, job.decision.cwd), ...(job.decision.sessionId ? { sessionId: scopedId(node, job.decision.sessionId) } : {}) } } : {}) };
}
export function scopeGroup(node: string, group: ProjectGroup): ProjectGroup { return { ...group, cwd: scopedId(node, group.cwd) }; }
export function scopeRepository(node: string, status: RepositoryStatus): RepositoryStatus { return { ...status, cwd: scopedId(node, status.cwd) }; }
export function scopeDetail(node: string | undefined, detail: SessionDetail): SessionDetail {
  return node ? { ...detail, session: scopeSession(node, detail.session) } : detail;
}

/** A joined computer's snapshot, named for this page. */
export function scopeSnapshot(node: string, snapshot: Snapshot): Snapshot {
  return { ...snapshot,
    sessions: snapshot.sessions.map(session => scopeSession(node, session)),
    runs: snapshot.runs.map(run => scopeRun(node, run)),
    ...(snapshot.autoPrompts ? { autoPrompts: snapshot.autoPrompts.map(job => scopeJob(node, job)) } : {}),
    ...(snapshot.groups ? { groups: snapshot.groups.map(group => scopeGroup(node, group)) } : {}),
    ...(snapshot.repositories ? { repositories: snapshot.repositories.map(status => scopeRepository(node, status)) } : {}),
  };
}
