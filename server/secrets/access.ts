import type { SecretSubjectMode } from '../../shared/secrets.js';
import type { Run, RunDelegation, Session } from '../../shared/types.js';
import { publicAgentTrigger, type SessionOrigin } from '../runs/origin.js';

/** Why a turn gets no secret tools at all. */
export type SecretRefusal = 'no-session' | 'closed' | 'pending' | 'joined-computer' | 'public-agent' | 'unknown-parent' | 'unknown-caller';
/**
 * Who uses secrets in a session: `owner` (the owner's own conversation; no review), `reviewed` (any other session here;
 * attack-only review before a value resolves) or `none` (no secret tools).
 */
export type SecretSubject = { mode: SecretSubjectMode } | { mode: 'none'; reason: SecretRefusal };
/**
 * When it is asked. `issue`: whether a turn gets the broker at all, or the owner may view and connect a session; every turn
 * that started this one must still be known. `discover`: a turn holding its credential lists the tools. `use`: it asks for a
 * secret now. Before `use`, a session still being created is judged as it will be, since its provider fixes the turn's tools
 * before the creation is confirmed; `use` waits for the confirmation. After `issue`, a calling turn that has left history
 * is not checked again: its origin and callers cannot change. At `issue` too, one is judged by what was found when the turn
 * it started was admitted (`RunDelegation.publicChain`), so a delegated session's later turns keep their tools.
 */
export type SecretStage = 'issue' | 'discover' | 'use';
/** A session the server knows, with the provenance Tower recorded if it created it. */
export interface KnownSession { session: Session; provenance?: SessionOrigin }
/** What decides a turn's part: who started it and from which calling turn. */
export type KnownRun = Pick<Run, 'origin' | 'delegation' | 'sessionId'>;

/** Parents and calling turns followed; a longer or circular chain is refused, not guessed. */
const MAX_ANCESTORS = 16;
const none = (reason: SecretRefusal): SecretSubject => ({ mode: 'none', reason });

/** Whether a session, or a native parent of it the server knows, is a public agent's: outsiders' words reach all of them. */
function publicLineage(start: KnownSession, lookup: (id: string) => KnownSession | undefined): SecretRefusal | undefined {
  const seen = new Set([start.session.id]);
  for (let current = start; ;) {
    if (publicAgentTrigger(current.provenance?.triggerId) || publicAgentTrigger(current.session.launchedBy?.triggerId)) return 'public-agent';
    const parentId = current.session.parentId;
    if (!parentId) return undefined;
    if (seen.has(parentId) || seen.size > MAX_ANCESTORS) return 'unknown-parent';
    seen.add(parentId);
    const parent = lookup(parentId);
    if (!parent) return 'unknown-parent';
    current = parent;
  }
}

type Known = { lookup(id: string): KnownSession | undefined; findRun(id: string): KnownRun | undefined };

/**
 * Why the turns that started a delegated turn, and theirs, each with its own conversation, refuse it secrets, if they do.
 * A calling turn that has left history counts as checked when a turn it started kept `publicChain: false`; otherwise
 * `strict` refuses it.
 */
function callerRefusal(delegation: RunDelegation, strict: boolean, known: Known): SecretRefusal | undefined {
  if (delegation.publicChain) return 'public-agent';
  const kept = delegation.publicChain === false;
  const callers = [{ id: delegation.parentRunId, kept }, { id: delegation.rootRunId, kept }];
  const seen = new Set<string>();
  for (let item = callers.shift(); item; item = callers.shift()) {
    if (seen.has(item.id)) continue;
    if (seen.size >= MAX_ANCESTORS) return 'unknown-caller';
    seen.add(item.id);
    const caller = known.findRun(item.id), session = caller && known.lookup(caller.sessionId);
    if (!caller || !session) { if (strict && !item.kept) return 'unknown-caller'; continue; }
    if (publicAgentTrigger(caller.origin?.triggerId) || caller.delegation?.publicChain) return 'public-agent';
    const lineage = publicLineage(session, known.lookup);
    if (lineage) return lineage;
    const next = item.kept || caller.delegation?.publicChain === false;
    if (caller.delegation) callers.push({ id: caller.delegation.parentRunId, kept: next }, { id: caller.delegation.rootRunId, kept: next });
  }
  return undefined;
}

/**
 * What a delegated turn keeps when it is admitted (`RunDelegation.publicChain`): whether a public agent is among the turns
 * that started it, or `undefined` when one is not known, which leaves later turns to today's check.
 */
export function publicChain(delegation: RunDelegation, known: Known): boolean | undefined {
  const refused = callerRefusal(delegation, true, known);
  return refused === undefined ? false : refused === 'public-agent' ? true : undefined;
}

/**
 * Decided from what the server knows now, never from what the caller says. `lookup` finds the sessions and `findRun` the
 * turns the server knows. Nothing is inherited downwards: a native child (`parentId`, subagent, agent- or trigger-launched)
 * is reviewed unless its own provenance is the owner's, and a turn another turn started with its calling credential
 * (`run.delegation`) is reviewed, or refused when a public agent is among the turns that started it.
 */
export function secretSubject(input: { run?: KnownRun; session?: Session; provenance?: SessionOrigin; stage: SecretStage;
  lookup(id: string): KnownSession | undefined; findRun(id: string): KnownRun | undefined }): SecretSubject {
  const { run, session, provenance } = input;
  if (!session) return none('no-session');
  if (session.closed) return none('closed');
  if (session.creationPending && input.stage === 'use') return none('pending');
  // A joined computer's session uses its own computer's broker.
  if (session.node) return none('joined-computer');
  if (publicAgentTrigger(run?.origin?.triggerId)) return none('public-agent');
  const lineage = publicLineage({ session, provenance }, input.lookup);
  if (lineage) return none(lineage);
  const refused = run?.delegation && callerRefusal(run.delegation, input.stage === 'issue', input);
  if (refused) return none(refused);
  // Delegated work is reviewed, even in a conversation a calling credential opened as the owner's.
  if (run?.delegation) return { mode: 'reviewed' };
  // Outside content in the owner's own conversation keeps it the owner's.
  if (provenance?.kind === 'owner') return { mode: 'owner' };
  // A native conversation the owner opened in Tower has no provenance; only the owner's own turn in it at top level counts.
  if (!provenance && run?.origin?.kind === 'owner' && !session.parentId && !session.isSubagent && !session.launchedByAgent && !session.launchedBy) return { mode: 'owner' };
  return { mode: 'reviewed' };
}
