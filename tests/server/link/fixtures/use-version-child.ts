/**
 * A separate CLI process asking for `useVersion(stateDir, version)`, as `service install` and `join` do. It says on
 * stdout when it starts asking, then answers one JSON line; exit code 3 when useVersion refused.
 */
import { useVersion } from '../../../../server/link/service.js';

const [stateDir, version] = process.argv.slice(2);
process.stdout.write('asking\n');
useVersion(stateDir!, version!).then(
  () => { process.stdout.write(`${JSON.stringify({ ok: true })}\n`); },
  (error: Error & { code?: string }) => { process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`); process.exitCode = 3; },
);
