/**
 * A separate process keeping the update's transition turn, as the update helper or another web does: takes the turn,
 * appends `enter <pid>` to `marks`, waits until a line arrives on stdin, writes (refreshes or creates) the hold of
 * `version` inside the same turn, then appends `leave <pid>`. Exits 0 when the hold was written, 3 otherwise.
 */
import { appendFileSync } from 'node:fs';
import { once } from 'node:events';
import { writeHold } from '../../../../server/link/storage-hold.js';
import { withStorageTransition } from '../../../../server/link/storage-transition-lock.js';

const [stateDir, marks, version] = process.argv.slice(2);
withStorageTransition(stateDir!, async () => {
  appendFileSync(marks!, `enter ${process.pid}\n`);
  await once(process.stdin, 'data');
  process.stdin.pause();
  const written = await writeHold(stateDir!, version!);
  appendFileSync(marks!, `leave ${process.pid}\n`);
  return written;
}, { waitMs: 30_000 }).then(() => undefined, () => { process.exitCode = 3; });
