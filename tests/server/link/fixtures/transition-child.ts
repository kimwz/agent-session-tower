/**
 * A separate process taking the computer's transition turn, as the web, the update helper and the CLI each do. It
 * appends `enter <pid>` and `leave <pid>` to `marks` around `holdMs` inside the turn, then answers one JSON line;
 * exit code 3 when the turn was refused.
 */
import { appendFileSync } from 'node:fs';
import { withStorageTransition } from '../../../../server/link/storage-transition-lock.js';

const [stateDir, marks, holdMs] = process.argv.slice(2);
withStorageTransition(stateDir!, async () => {
  appendFileSync(marks!, `enter ${process.pid}\n`);
  await new Promise(resolve => setTimeout(resolve, Number(holdMs)));
  appendFileSync(marks!, `leave ${process.pid}\n`);
}, { waitMs: 30_000 }).then(
  () => { process.stdout.write(`${JSON.stringify({ ok: true })}\n`); },
  (error: Error & { code?: string }) => { process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`); process.exitCode = 3; },
);
