/**
 * A separate process acting on the update's handoff hold, as the update helper or another web does. `turn <ms>`: takes
 * the transition turn, appends `enter <pid>` to `marks`, waits `ms`, writes (refreshes or creates) the hold of `version`
 * inside the same turn, then appends `leave <pid>`. `write`: writes the hold of `version`. `remove`: removes the hold of
 * `version`. Answers one JSON line with what it did (or the error's code).
 */
import { appendFileSync } from 'node:fs';
import { removeHold, writeHold } from '../../../../server/link/storage-hold.js';
import { withStorageTransition } from '../../../../server/link/storage-transition-lock.js';

const [stateDir, marks, op, version, holdMs] = process.argv.slice(2);
const answer = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const act = async () => {
  if (op === 'turn') {
    return withStorageTransition(stateDir!, async () => {
      appendFileSync(marks!, `enter ${process.pid}\n`);
      await new Promise(resolve => setTimeout(resolve, Number(holdMs)));
      const written = await writeHold(stateDir!, version!);
      appendFileSync(marks!, `leave ${process.pid}\n`);
      return written;
    }, { waitMs: 30_000 });
  }
  if (op === 'write') return writeHold(stateDir!, version!);
  if (op === 'remove') return removeHold(stateDir!, { version: version! });
  throw new Error(`unknown op ${op}`);
};
act().then(result => answer({ ok: true, result }), (error: Error & { code?: string }) => { answer({ ok: false, code: error.code, message: error.message }); process.exitCode = 3; });
