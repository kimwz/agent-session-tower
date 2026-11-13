import { TowerError } from '../../shared/errors.js';
/** A rejected input is safe to leave queued; an uncertain input must never be resent automatically. */
export class SteeringError extends TowerError {
  declare readonly disposition: 'rejected' | 'uncertain';
  constructor(message: string, disposition: 'rejected' | 'uncertain') { super('conflict', message, { disposition }); }
}

export interface SteeringInput {
  id: string;
  prompt: string;
  imagePaths?: readonly string[];
}

/**
 * Whether inserting `run` moves the turn's foreground work aside so the turn takes it at once (see ClaudeControl.steer):
 * yes for a message someone sent, no for Tower's own notices (update wrap-up, permission decisions), which wait for the
 * step underway.
 */
export function movesForegroundAside(run: { updateWrapUp?: true; permissionNotice?: unknown }): boolean {
  return !run.updateWrapUp && !run.permissionNotice;
}
