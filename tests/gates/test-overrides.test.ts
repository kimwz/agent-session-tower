import test from 'node:test';
import assert from 'node:assert/strict';
import { mentions, scriptFiles } from '../helpers/source-scan.js';

/**
 * Delays and limits that tests shorten are options no server code sets: only the modules that define and read them
 * name them (as a name or as a string property name), so the running Tower always uses their production values (each
 * default has its own test). Every script outside the tests is read, whatever its extension and however deep.
 */
const OVERRIDES: Record<string, string[]> = {
  // RunManager option → claude-turn.ts, default CLAUDE_FINISH_RECHECK_MS (runner-background-tasks.test.ts)
  'claudeFinishRecheckMs': ['server/runs/claude-turn.ts', 'server/runs/manager.ts', 'server/runs/turn-host.ts'],
  // TriggerService limits → fire(), default MAX_FIRED_PER_TRIGGER (triggers/limits.test.ts)
  'firedPerTrigger': ['server/triggers/engine.ts', 'server/triggers/polls.ts', 'server/triggers/service.ts', 'server/triggers/store.ts'],
  // startRunnerHost option → the worker's handoff and idle checks, default everySecond / WORKER_CHECK_MS (runs/worker-checks.test.ts)
  'scheduleChecks': ['server/runs/worker.ts'],
};

const naming = (files: Map<string, string>, name: string) => [...files].filter(([path, text]) => mentions(path, text, name) > 0).map(([path]) => path).sort();

test('the check below finds an override set in any kind of script, by name or by string property name, computed keys included', () => {
  const fixtures = new Map([
    ['server/runs/fixture-set.mjs', "export const options = { 'claudeFinishRecheckMs': 1 };\n"],
    ['scripts/deep/fixture-index.cjs', "module.exports = options => { options['firedPerTrigger'] = 1; };\n"],
    ['client/src/fixture-name.tsx', 'export const host = { scheduleChecks: () => () => {} };\n'],
    ['server/fixture-computed.ts', "export const host = { ['scheduleChecks']: () => () => {} };\nexport class Limits { ['firedPerTrigger'] = 1; }\n"],
    ['shared/fixture-text.ts', "// scheduleChecks\nexport const words = 'claudeFinishRecheckMs';\n"],
  ]);
  assert.deepEqual(naming(fixtures, 'claudeFinishRecheckMs'), ['server/runs/fixture-set.mjs'], 'a string property name counts; plain text does not');
  assert.deepEqual(naming(fixtures, 'firedPerTrigger'), ['scripts/deep/fixture-index.cjs', 'server/fixture-computed.ts'], 'a computed string key counts too');
  assert.deepEqual(naming(fixtures, 'scheduleChecks'), ['client/src/fixture-name.tsx', 'server/fixture-computed.ts']);
});

test('test-only delays and limits are named only where they are defined and read, never set by other server code', async () => {
  const files = await scriptFiles(['server', 'shared', 'client/src', 'scripts']);
  for (const [name, owners] of Object.entries(OVERRIDES)) assert.deepEqual(naming(files, name), [...owners].sort(), name);
});
