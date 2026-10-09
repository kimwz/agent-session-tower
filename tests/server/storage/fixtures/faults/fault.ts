import { dirname, join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import type { ThreadHello, ThreadRequest } from '../../../../../server/storage/contract.js';
import { runStorageThread } from '../../../../../server/storage/thread/runtime.js';
import { fixtureDomain, plainDomain } from '../fixture-domain.js';

/**
 * Fault threads: the fixture thread with one thing wrong, each bundled from its own fixed entry in this folder. The
 * fixture parent (helpers.ts) trusts each source with the fixture contract, so the worker's checks after trust (the
 * hello, the copy check, the open) are what refuses them.
 */

/** The thread whose hello `change` rewrites. */
export function helloFault(change: (hello: ThreadHello) => ThreadHello): void {
  const port = parentPort!;
  const post = port.postMessage.bind(port);
  let first = true;
  port.postMessage = (message: unknown) => {
    if (first) { first = false; post(change(message as ThreadHello)); return; }
    post(message);
  };
  runStorageThread([fixtureDomain, plainDomain]);
}

/** The thread that runs `before` on every request it receives, before handling it. */
export function requestFault(before: (request: ThreadRequest) => void): void {
  const port = parentPort!;
  const on = port.on.bind(port);
  port.on = ((event: string, listener: (value: unknown) => void) => on(event, event === 'message'
    ? (request: ThreadRequest) => { before(request); listener(request); }
    : listener)) as typeof port.on;
  runStorageThread([fixtureDomain, plainDomain]);
}

/** As another process would: writes to the live database beside the private copy being checked. */
export function writeLiveBeside(copy: string): void {
  const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const live = new sqlite.DatabaseSync(join(dirname(dirname(copy)), 'state.sqlite'));
  try { live.exec('PRAGMA user_version = 77'); } finally { live.close(); }
}

export const spin = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* busy */ } };
