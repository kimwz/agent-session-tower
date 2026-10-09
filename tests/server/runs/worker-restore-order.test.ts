import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The worker applies a restore before any service reads its files, and hands off only after the skills are restored.
test('the worker restores in order: files before services, the Vault before triggers, skills before a handoff', async () => {
  const source = await readFile(new URL('../../../server/runs/worker.ts', import.meta.url), 'utf8');
  const at = (text: string) => { const index = source.indexOf(text); assert.notEqual(index, -1, text); return index; };
  assert.ok(at("database.gate('core')") < at('runs.useStorage(database!)'));
  assert.ok(at('runs.useStorage(database!)') < at('await bootstrapRuns()'));
  assert.ok(at('await bootstrapRuns()') < at('takeWorkerRestore('));
  assert.ok(at('takeWorkerRestore(') < at('sessions.start()'));
  assert.ok(at('await sessions.quiesce()') < at('takeWorkerRestore('));
  assert.ok(at('new SecretService(') < at('new TriggerService('));
  assert.ok(at('triggers.start(restoring') < at('runs.markReady()'));
  assert.ok(at('runs.markReady()') < at('restoring.finish('));
  assert.match(source, /inFlight: \(\) => secrets\.inFlight\(\) \|\| restoringSkills \|\|/);
  assert.match(source, /transient: \(\) => secrets\.inFlight\(\) \|\| restoringSkills \|\|/);
  assert.match(source, /importPending: \(id, password\) => importPendingSecret\([^\n]*restoreTriggers: async backup => \{[^\n]*triggerEngine\.restoreBackup\(backup\)/);
});
