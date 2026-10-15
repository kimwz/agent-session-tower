/**
 * A separate process taking the computer's transition turn, as the web, the update helper and the CLI each do. It
 * prints `{"trying":<pid>}` before it asks for the turn; inside the turn it prints `{"entered":<pid>}` and waits for one line on stdin (the parent's release), or the end of its
 * input; then it leaves the turn and answers `{"ok":true}`, or the refusal with exit code 3. Nothing here waits on a
 * clock: the parent decides when each turn ends.
 */
import { withStorageTransition } from '../../../../server/link/storage-transition-lock.js';

const [stateDir] = process.argv.slice(2);
const answer = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const released = () => new Promise<void>(resolve => {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { if (String(chunk).includes('\n')) resolve(); });
  process.stdin.on('end', () => resolve());
});
answer({ trying: process.pid });
withStorageTransition(stateDir!, async () => {
  answer({ entered: process.pid });
  await released();
}, { waitMs: 120_000 }).then(
  () => answer({ ok: true }),
  (error: Error & { code?: string }) => { answer({ ok: false, code: error.code, message: error.message }); process.exitCode = 3; },
).finally(() => process.stdin.destroy());
