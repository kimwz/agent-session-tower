import type { PermissionRequest } from '../../shared/permissions.js';

/** A background intervention must not override a pending decision or the owner's refusal. */
export function permissionProtected(requests: readonly Pick<PermissionRequest, 'sessionId' | 'status' | 'decidedBy'>[], sessionIds: readonly string[]): boolean {
  return requests.some(request => sessionIds.includes(request.sessionId)
    && (request.status === 'pending' || (request.status === 'denied' && request.decidedBy === 'owner')));
}
