/** A rejected input is safe to leave queued; an uncertain input must never be resent automatically. */
export class SteeringError extends Error {
  readonly statusCode = 409;
  constructor(message: string, readonly disposition: 'rejected' | 'uncertain') { super(message); }
}

export interface SteeringInput {
  id: string;
  prompt: string;
  imagePaths?: readonly string[];
}
