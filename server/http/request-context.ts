import type { HeartbeatAdmission } from '../../shared/master.js';
import type { RunOrigin, RunSender } from '../../shared/types.js';

/**
 * Who is asking, set by the entry point that authenticated the request and never read from its body.
 * A remote controller's requests carry its origin and a request ID that makes a retry run only once.
 */
export interface RequestContext {
  /**
   * The signed-in owner's page or the verified master sent this. Forwarded only for an execution worker of 1.129–1.132,
   * which requires it for sessions an owner connected to the secret broker (#116); newer workers ignore it, and nothing
   * here grants anything by it.
   */
  brokerOwnerAuthorized?: boolean;
  heartbeat?: HeartbeatAdmission;
  origin?: RunOrigin;
  requestId?: string;
  /** The verified master sent this (see RunSender); shown on the run, never trusted for anything. */
  sender?: RunSender;
  /** Unverified local reporting credential. Only the execution worker may resolve it. */
  callerCapability?: string;
}
