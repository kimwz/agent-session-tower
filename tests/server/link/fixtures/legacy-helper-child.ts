/**
 * The released 1.114.1 update helper (the legacy fixture's own runUpdateHelper, unchanged), run as a separate process
 * on `stateDir` to update to `version`. It publishes its real helper lock and stops inside its install, printing
 * `{"event":"install-paused"}`, until a line arrives on stdin; then its install fails on purpose and the helper ends the
 * way it ends any failed install (its record says `install-failed`, its lock goes). Nothing is installed or restarted.
 */
import { runUpdateHelper, type UpdateHelperSteps } from './legacy-1.114.1/server/link/update.js';

const [stateDir, version] = process.argv.slice(2);
const line = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const unexpected = (step: string) => async () => { throw new Error(`unexpected ${step}`); };
const steps: UpdateHelperSteps = {
  free: async () => Number.MAX_SAFE_INTEGER,
  install: async () => {
    line({ event: 'install-paused', pid: process.pid });
    // Released by the parent's line, or by the end of its input (a parent that went away): never by a clock.
    await new Promise<void>(resolve => { process.stdin.once('data', () => resolve()); process.stdin.once('end', () => resolve()); });
    process.stdin.destroy();
    throw new Error('controlled fixture completion; nothing was installed');
  },
  check: unexpected('check'), point: unexpected('point'), restart: unexpected('restart'),
  health: async () => undefined, controllers: async () => [], sleep: async () => {}, now: () => Date.now(), log: () => {},
};
runUpdateHelper(stateDir!, version!, steps).then(
  status => line({ event: 'finished', stage: status?.stage, code: status?.code }),
  (error: Error) => { line({ event: 'fixture-error', message: error.message }); process.exitCode = 1; },
);
