import type { ProviderHealth, Snapshot } from '../../../shared/types';
import { translate as t } from '../i18n/i18n';
import type { NodeStatus } from '../../../shared/link';
import { scopeSnapshot } from './scope';

/** A computer on the canvas: this one, or one joined to this Tower. */
export interface Host {
  /** Absent for this computer. */
  node?: string;
  name: string;
  status: 'local' | NodeStatus;
  /** Its state is arriving now. When false, what is shown is the last state seen. */
  live: boolean;
  /** It can take new work from this page now. */
  canWork: boolean;
  /** Its files and terminals can be opened from this page now. */
  workspace: boolean;
  /** Some state of it is known to this page, even if out of date. */
  known: boolean;
  version?: string;
  providers: ProviderHealth[];
}

// Renaming a snapshot is done once per computer and snapshot, not on every render.
const scoped = new Map<string, { raw: Snapshot; named: Snapshot }>();

/** Where a computer stands for this page: what it shows and whether work can be sent to it. */
export type HostState = 'here' | 'ready' | 'loading' | 'read-only' | 'offline' | 'update-required' | 'removed-by-node';
export function hostState(host: Host): HostState {
  if (!host.node) return 'here';
  if (host.status === 'update-required') return 'update-required';
  if (host.status === 'removed-by-node') return 'removed-by-node';
  if (host.status !== 'connected') return 'offline';
  if (!host.live) return 'loading';
  return host.canWork ? 'ready' : 'read-only';
}
/** Why work cannot be sent to a joined computer right now, in one sentence; undefined when it can. */
export function hostProblem(host: Host): string | undefined {
  const name = host.name;
  switch (hostState(host)) {
    case 'offline': return t('{0}이(가) 오프라인입니다. 다시 연결되면 이어서 할 수 있습니다.', { 0: name });
    case 'loading': return t('{0}의 상태를 불러오는 중입니다.', { 0: name });
    case 'read-only': return t('{0}의 Tower를 업데이트하면 작업을 보낼 수 있습니다.', { 0: name });
    case 'update-required': return t('{0}의 Tower 버전이 이 컴퓨터와 맞지 않습니다. 두 컴퓨터를 같은 버전으로 업데이트하세요.', { 0: name });
    case 'removed-by-node': return t('{0}이(가) 이 컴퓨터의 제어를 해제했습니다. 다시 연결하려면 새 명령이 필요합니다.', { 0: name });
    default: return undefined;
  }
}
/** Why a connected computer's files and terminals cannot be opened, when that is so. */
export function workspaceNote(host: Host | undefined): string | undefined {
  if (!host?.node || host.workspace || host.status !== 'connected') return undefined;
  return t('{0}의 Tower를 업데이트하면 파일과 터미널을 열 수 있습니다.', { 0: host.name });
}
const named = (node: string, snapshot: Snapshot) => {
  const cached = scoped.get(node);
  if (cached?.raw === snapshot) return cached.named;
  const value = scopeSnapshot(node, snapshot);
  scoped.set(node, { raw: snapshot, named: value });
  return value;
};

/**
 * One view of every computer: this Tower's snapshot with each joined computer's items added under their own
 * names. Without joined computers it is this Tower's snapshot itself, unchanged.
 */
/**
 * `complete` says the list of joined computers is final (this Tower has read its saved computers); until then a page
 * forgets nothing it keeps for them.
 */
export function combinedView(local: Snapshot | null, nodes: ReadonlyMap<string, Snapshot>): { view: Snapshot | null; hosts: Host[]; complete: boolean } {
  if (!local) return { view: null, hosts: [], complete: false };
  const complete = local.nodes !== undefined;
  const here: Host = { name: local.hostname, status: 'local', live: true, canWork: true, workspace: true, known: true, version: local.version, providers: local.providers };
  const listed = local.nodes ?? [];
  for (const node of scoped.keys()) if (!listed.some(item => item.id === node)) scoped.delete(node);
  if (!listed.length) return { view: local, hosts: [here], complete };
  const parts = listed.flatMap(node => { const snapshot = nodes.get(node.id); return snapshot ? [named(node.id, snapshot)] : []; });
  const hosts = [here, ...listed.map((node): Host => ({ node: node.id, name: node.label || node.name, status: node.status, live: node.status === 'connected' && node.streaming,
    canWork: node.status === 'connected' && node.streaming && node.features.includes('work'), workspace: node.status === 'connected' && node.features.includes('workspace'), known: Boolean(nodes.get(node.id)) && !nodes.get(node.id)!.scanning, ...(node.version ? { version: node.version } : {}), providers: nodes.get(node.id)?.providers ?? [] }))];
  return { hosts, complete, view: { ...local,
    sessions: [...local.sessions, ...parts.flatMap(part => part.sessions)],
    runs: [...local.runs, ...parts.flatMap(part => part.runs)],
    autoPrompts: [...local.autoPrompts ?? [], ...parts.flatMap(part => part.autoPrompts ?? [])],
    groups: [...local.groups ?? [], ...parts.flatMap(part => part.groups ?? [])],
    repositories: [...local.repositories ?? [], ...parts.flatMap(part => part.repositories ?? [])],
  } };
}

export const hostOf = (hosts: readonly Host[], node: string | undefined): Host | undefined => hosts.find(host => host.node === node);

/** Names of joined computers, kept by the page for views opened outside it (such as the workspace). */
export const hostNames = new Map<string, string>();
