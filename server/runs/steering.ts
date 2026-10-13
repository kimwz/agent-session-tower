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
