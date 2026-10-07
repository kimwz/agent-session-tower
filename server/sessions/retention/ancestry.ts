import type { Session } from '../../../shared/types.js';
import type { RetentionMember, RetentionNode, RetentionRelationship } from '../../../shared/retention.js';
import type { RetentionObservation } from './policy.js';

export const nodeAliases = (node: RetentionNode): string[] => [node.id, `${node.provider}:${node.nativeId}`];
export function retentionNodeMap(observation: Pick<RetentionObservation, 'records' | 'ancestry'>): Map<string, RetentionNode> {
  const map=new Map([...observation.ancestry || [], ...observation.records.map(({session}) => session)].flatMap(node => nodeAliases(node).map(alias => [alias,{...node}] as const)));
  for(const node of map.values())if(node.parentId)node.parentId=map.get(node.parentId)?.id??map.get(`${node.provider}:${node.parentId}`)?.id??node.parentId;
  return map;
}

/** Policy/reservation copies only. Never publishes cold sessions or grants access to a transcript. */
export function resolveRetentionLineage(hot: readonly Session[], members: readonly RetentionMember[], launchers: ReadonlyMap<string, readonly string[]> = new Map()) {
  const hotIds=new Set(hot.map(session=>session.id));
  const sessions = hot.map(session => ({...session}));
  const cold: RetentionNode[] = members.filter(member => member.state === 'cold').map(member => ({id:member.sessionId,provider:member.provider,nativeId:member.nativeId,parentId:member.parentId,isSubagent:member.isSubagent,parentLink:member.parentLink,createdAt:member.createdAt}));
  const nodes = new Map<string, RetentionNode>(); const aliases = new Map<string,string>(); const blockedIds = new Set<string>();
  for (const node of [...cold, ...sessions]) {
    const prior = nodes.get(node.id);
    if (prior && (prior.provider !== node.provider || prior.nativeId !== node.nativeId || prior.parentId !== node.parentId || prior.isSubagent !== node.isSubagent || prior.parentLink !== node.parentLink || prior.createdAt !== node.createdAt)) blockedIds.add(node.id);
    nodes.set(node.id,node);
    for (const alias of nodeAliases(node)) {
      const previous = aliases.get(alias);
      if (previous && previous !== node.id) { blockedIds.add(previous); blockedIds.add(node.id); }
      else aliases.set(alias,node.id);
    }
  }
  const canonical = (id:string, provider:string) => aliases.get(id) ?? aliases.get(`${provider}:${id}`) ?? id;
  for (const node of nodes.values()) if (node.parentId) node.parentId=canonical(node.parentId,node.provider);
  const proofs: RetentionRelationship[] = members.flatMap(member => [
    ...(member.isSubagent === true && member.parentId && member.createdAt ? [{id:member.sessionId,provider:member.provider,nativeId:member.nativeId,parentId:member.parentId,isSubagent:true as const,parentLink:member.parentLink,createdAt:member.createdAt}] : []),
    ...member.relationships || [],
  ]);
  const proven = new Map<string, string>();
  for (const proof of proofs) {
    const id=aliases.get(proof.id)??aliases.get(`${proof.provider}:${proof.nativeId}`)??proof.id; const child=nodes.get(id);
    if (!child || !hotIds.has(id)) continue;
    const parent=canonical(proof.parentId,proof.provider), prior=proven.get(id);
    if (child.provider !== proof.provider || child.nativeId !== proof.nativeId || child.createdAt !== proof.createdAt || (prior && prior !== parent) || (child.parentId && (child.parentId !== parent || child.isSubagent === false))) { blockedIds.add(id); continue; }
    proven.set(id,parent); child.parentId=parent;child.isSubagent=true;child.parentLink=proof.parentLink;
  }
  for (const session of sessions) {
    const possible=[...new Set(launchers.get(session.id) ?? launchers.get(`${session.provider}:${session.nativeId}`) ?? [])].map(id=>nodes.get(canonical(id,session.provider)))
      .filter((parent):parent is RetentionNode=>Boolean(parent && parent.id!==session.id && (parent.isSubagent===false || parent.parentLink==='exec')));
    if (proven.has(session.id) && possible.some(parent=>parent.id===proven.get(session.id))) continue;
    if (session.parentId || session.isSubagent || !possible.length) continue;
    if (possible.length!==1) continue; // Ambiguous launchers did not prove a relationship in the native scanner either.
    session.parentId=possible[0].id;session.isSubagent=true;session.parentLink='exec';
  }
  return {sessions, ancestry:cold.map(node=>({...node,parentId:node.parentId?canonical(node.parentId,node.provider):undefined})), nodes, aliases, blockedIds};
}
