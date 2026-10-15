/**
 * A separate process keeping the update's transition turn, as the update helper or another web does: takes the turn,
 * appends `enter <pid>` to `marks` and prints `entered` on stdout, waits until a line arrives on stdin (or its end), writes (refreshes or creates) the hold of
 * `version` inside the same turn, then appends `leave <pid>`. Exits 0 when the hold was written, 3 otherwise.
 */
import { appendFileSync } from 'node:fs';
import { once } from 'node:events';
import { writeHold } from '../../../../server/link/storage-hold.js';
import { withStorageTransition } from '../../../../server/link/storage-transition-lock.js';

const [stateDir, marks, version] = process.argv.slice(2);
withStorageTransition(stateDir!, async () => {
  appendFileSync(marks!, `enter ${process.pid}\n`);
  process.stdout.write('entered\n');
  await Promise.race([once(process.stdin, 'data'), once(process.stdin, 'end')]);
  process.stdin.pause();
  const written = await writeHold(stateDir!, version!);
  appendFileSync(marks!, `leave ${process.pid}\n`);
  return written;
}, { waitMs: 60_000 }).then(() => undefined, () => { process.exitCode = 3; }).finally(() => process.stdin.destroy());
