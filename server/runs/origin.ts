import type { RunOrigin } from '../../shared/types.js';
import { UUID } from './saved-state.js';

/** The provenance Tower keeps for a session it created. External content never leaves it. */
export interface SessionOrigin {
  kind: RunOrigin['kind'];
  /** Slack, GitHub or HTTP content entered this conversation at some point. */
  untrustedInput: boolean;
  workflowId?: string;
  triggerId?: string;
  eventId?: string;
  /** The paired controller whose remote request created this conversation. */
  controllerId?: string;
}

const KINDS = new Set<RunOrigin['kind']>(['owner', 'agent', 'trigger', 'slack', 'unknown']);
const REFERENCE = /^[\w:.-]{1,200}$/;
/** Controller IDs are derived from the controller's pinned key: lowercase letters and digits. */
export const CONTROLLER_ID = /^[a-z0-9]{16,64}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Returns undefined for anything malformed; callers decide whether that means "unknown".
 * Run origins name their Slack workflow or trigger. Session records classified from older data may not.
 */
export function parseRunOrigin(value: unknown, references: 'required' | 'optional' = 'required'): RunOrigin | undefined {
  if (!record(value) || !KINDS.has(value.kind as RunOrigin['kind'])) return undefined;
  if (Object.keys(value).some(key => !['kind', 'workflowId', 'triggerId', 'eventId', 'runId', 'controllerId'].includes(key))) return undefined;
  const kind = value.kind as RunOrigin['kind'];
  for (const key of ['workflowId', 'triggerId', 'eventId'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !REFERENCE.test(value[key]))) return undefined;
  }
  if (value.runId !== undefined && (typeof value.runId !== 'string' || !UUID.test(value.runId))) return undefined;
  // Only the owner's own remote requests, and agents they start, can come from a controller.
  if (value.controllerId !== undefined && (typeof value.controllerId !== 'string' || !CONTROLLER_ID.test(value.controllerId) || (kind !== 'owner' && kind !== 'agent'))) return undefined;
  if (value.workflowId !== undefined && !UUID.test(value.workflowId as string)) return undefined;
  if (references === 'required' && kind === 'slack' && value.workflowId === undefined) return undefined;
  if (references === 'required' && kind === 'trigger' && value.triggerId === undefined) return undefined;
  return { kind, ...(value.workflowId ? { workflowId: value.workflowId as string } : {}), ...(value.triggerId ? { triggerId: value.triggerId as string } : {}),
    ...(value.eventId ? { eventId: value.eventId as string } : {}), ...(value.runId ? { runId: value.runId as string } : {}),
    ...(value.controllerId ? { controllerId: value.controllerId as string } : {}) };
}

/** A saved record that cannot be read back never becomes owner work. */
export function restoredSessionOrigin(value: unknown): SessionOrigin | undefined {
  if (value === undefined) return undefined;
  const origin = record(value) ? parseRunOrigin({ kind: value.kind, workflowId: value.workflowId, triggerId: value.triggerId, eventId: value.eventId, controllerId: value.controllerId }, 'optional') : undefined;
  if (!origin || !record(value) || typeof value.untrustedInput !== 'boolean') return { kind: 'unknown', untrustedInput: true };
  return { ...origin, untrustedInput: value.untrustedInput } as SessionOrigin;
}

export function sessionOriginOf(origin: RunOrigin | undefined, untrustedInput: boolean): SessionOrigin {
  const { runId: _caller, ...rest } = origin ?? { kind: 'unknown' as const };
  return { ...rest, untrustedInput };
}

/** Runs without a recorded origin compare as unknown. */
export function sameOrigin(a: RunOrigin | undefined, b: RunOrigin | undefined): boolean {
  const left = a ?? { kind: 'unknown' as const };
  const right = b ?? { kind: 'unknown' as const };
  return left.kind === right.kind && left.workflowId === right.workflowId && left.triggerId === right.triggerId && left.eventId === right.eventId
    && left.runId === right.runId && left.controllerId === right.controllerId;
}
