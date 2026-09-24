import type { ProviderHealth, Snapshot } from '../../../shared/types';
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
  /** Some state of it is known to this page, even if out of date. */
  known: boolean;
  version?: string;
  providers: ProviderHealth[];
}

// Renaming a snapshot is done once per computer and snapshot, not on every render.
const scoped = new Map<string, { raw: Snapshot; named: Snapshot }>();
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
export function combinedView(local: Snapshot | null, nodes: ReadonlyMap<string, Snapshot>): { view: Snapshot | null; hosts: Host[] } {
  if (!local) return { view: null, hosts: [] };
  const here: Host = { name: local.hostname, status: 'local', live: true, canWork: true, known: true, version: local.version, providers: local.providers };
  const listed = local.nodes ?? [];
  if (!listed.length) return { view: local, hosts: [here] };
  const parts = listed.flatMap(node => { const snapshot = nodes.get(node.id); return snapshot ? [named(node.id, snapshot)] : []; });
  const hosts = [here, ...listed.map((node): Host => ({ node: node.id, name: node.label || node.name, status: node.status, live: node.status === 'connected' && node.streaming,
    canWork: node.status === 'connected' && node.streaming && node.features.includes('work'), known: nodes.has(node.id), ...(node.version ? { version: node.version } : {}), providers: nodes.get(node.id)?.providers ?? [] }))];
  return { hosts, view: { ...local,
    sessions: [...local.sessions, ...parts.flatMap(part => part.sessions)],
    runs: [...local.runs, ...parts.flatMap(part => part.runs)],
    autoPrompts: [...local.autoPrompts ?? [], ...parts.flatMap(part => part.autoPrompts ?? [])],
    groups: [...local.groups ?? [], ...parts.flatMap(part => part.groups ?? [])],
    repositories: [...local.repositories ?? [], ...parts.flatMap(part => part.repositories ?? [])],
  } };
}

export const hostOf = (hosts: readonly Host[], node: string | undefined): Host | undefined => hosts.find(host => host.node === node);
