import type { RunOrigin } from '../../shared/types.js';

/**
 * Who is asking, set by the entry point that authenticated the request and never read from its body.
 * A remote controller's requests carry its origin and a request ID that makes a retry run only once.
 */
export interface RequestContext {
  origin?: RunOrigin;
  requestId?: string;
}
