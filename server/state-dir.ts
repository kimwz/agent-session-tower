import { homedir } from 'node:os';
import { join } from 'node:path';
import { STATE_DIR_NAME } from '../shared/app-identity.js';

/** Where Tower keeps its own state when --state-dir is not given. */
export function defaultStateDir(): string {
  return join(homedir(), STATE_DIR_NAME);
}
