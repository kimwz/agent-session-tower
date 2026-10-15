/**
 * A separate process acting on the update's handoff hold, as the update helper or another web does. `turn`: takes the
 * transition turn, prints `{"entered":<pid>}`, waits for one line on stdin (the parent's release), then writes
 * (refreshes or creates) the hold of `version` inside the same turn. `write`: writes the hold of `version`. `remove`:
 * removes the hold of `version`. Answers one JSON line with what it did (or the error's code). Nothing here waits on a
 * clock: the parent decides when the turn ends.
 */
import { removeHold, writeHold } from '../../../../server/link/storage-hold.js';
import { withStorageTransition } from '../../../../server/link/storage-transition-lock.js';

const [stateDir, op, version] = process.argv.slice(2);
const answer = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
/** Resolves on the parent's first line, or on the end of its input: a parent that went away releases the turn. */
const released = () => new Promise<void>(resolve => {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { if (String(chunk).includes('\n')) resolve(); });
  process.stdin.on('end', () => resolve());
});
const act = async () => {
  if (op === 'turn') {
    return withStorageTransition(stateDir!, async () => {
      answer({ entered: process.pid });
      await released();
      return writeHold(stateDir!, version!);
    }, { waitMs: 60_000 });
  }
  if (op === 'write') return writeHold(stateDir!, version!);
  if (op === 'remove') return removeHold(stateDir!, { version: version! });
  throw new Error(`unknown op ${op}`);
};
act().then(result => answer({ ok: true, result }), (error: Error & { code?: string }) => {
  answer({ ok: false, code: error.code, message: error.message });
  process.exitCode = 3;
}).finally(() => process.stdin.destroy());
