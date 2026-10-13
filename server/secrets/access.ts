import type { SecretSubjectMode } from '../../shared/secrets.js';
import type { Run, Session } from '../../shared/types.js';
import { publicAgentTrigger, type SessionOrigin } from '../runs/origin.js';
import { inMasterFolder } from '../runs/subscription.js';

/** Why a turn gets no secret tools at all. */
export type SecretRefusal = 'no-session' | 'closed' | 'pending' | 'joined-computer' | 'master' | 'public-agent' | 'unknown-parent';
/**
 * Who uses secrets in a session: `owner` (the owner's own conversation; no review), `reviewed` (any other session here;
 * attack-only review before a value resolves) or `none` (no secret tools).
 */
export type SecretSubject = { mode: SecretSubjectMode } | { mode: 'none'; reason: SecretRefusal };
/** A session the server knows, with the provenance Tower recorded if it created it. */
export interface KnownSession { session: Session; provenance?: SessionOrigin }

/** Parents followed for a public agent's descendants; a longer or circular chain is refused, not guessed. */
const MAX_ANCESTORS = 16;
const none = (reason: SecretRefusal): SecretSubject => ({ mode: 'none', reason });

/**
 * Decided from what the server knows now, never from what the caller says. `root` is the session's folder with links
 * followed, when the caller resolved it; `lookup` finds the parents the server knows. Children never inherit a parent's
 * exemption: a native child (`parentId`, subagent, agent- or trigger-launched) is reviewed unless its own provenance is the owner's.
 */
export function secretSubject(input: { run?: Pick<Run, 'origin'>; session?: Session; provenance?: SessionOrigin; stateDir: string; root?: string; lookup(id: string): KnownSession | undefined }): SecretSubject {
  const { run, session, provenance } = input;
  if (!session) return none('no-session');
  if (session.closed) return none('closed');
  if (session.creationPending) return none('pending');
  // A joined computer's session uses its own computer's broker.
  if (session.node) return none('joined-computer');
  if (session.master || inMasterFolder(input.stateDir, session.cwd) || (input.root !== undefined && inMasterFolder(input.stateDir, input.root))) return none('master');
  if (publicAgentTrigger(run?.origin?.triggerId)) return none('public-agent');
  // Outsiders' words reach a public agent's native children too.
  const seen = new Set([session.id]);
  let current: KnownSession = { session, provenance };
  for (;;) {
    if (publicAgentTrigger(current.provenance?.triggerId) || publicAgentTrigger(current.session.launchedBy?.triggerId)) return none('public-agent');
    const parentId = current.session.parentId;
    if (!parentId) break;
    if (seen.has(parentId) || seen.size > MAX_ANCESTORS) return none('unknown-parent');
    seen.add(parentId);
    const parent = input.lookup(parentId);
    if (!parent) return none('unknown-parent');
    current = parent;
  }
  // Outside content in the owner's own conversation keeps it the owner's.
  if (provenance?.kind === 'owner') return { mode: 'owner' };
  // A native conversation the owner opened in Tower has no provenance; only the owner's own turn in it at top level counts.
  if (!provenance && run?.origin?.kind === 'owner' && !session.parentId && !session.isSubagent && !session.launchedByAgent && !session.launchedBy) return { mode: 'owner' };
  return { mode: 'reviewed' };
}
