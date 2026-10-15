import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The worker applies a restore before any service reads its files, and hands off only after the skills are restored.
test('the worker restores in order: files before services, the Vault before triggers, skills before a handoff', async () => {
  const source = await readFile(new URL('../../../server/runs/worker.ts', import.meta.url), 'utf8');
  const at = (text: string) => { const index = source.indexOf(text); assert.notEqual(index, -1, text); return index; };
  assert.ok(at('openWorkerStorage(') < at("database.gate('core')"));
  assert.ok(at("database.gate('core')") < at('runs.useStorage(database!)'));
  assert.ok(at('runs.useStorage(database!)') < at('takeWorkerRestore('));
  assert.ok(at('takeWorkerRestore(') < at('sessions.start()'));
  assert.ok(at('await sessions.quiesce()') < at('takeWorkerRestore('));
  assert.ok(at('new SecretService(') < at('new TriggerService('));
  assert.ok(at('triggers.start(restoring') < at('runs.markReady()'));
  assert.ok(at('runs.markReady()') < at('restoring.finish('));
  assert.match(source, /inFlight: \(\) => secrets\.inFlight\(\) \|\| restoringSkills \|\|/);
  assert.match(source, /transient: \(\) => secrets\.inFlight\(\) \|\| restoringSkills \|\|/);
  assert.match(source, /importPending: \(id, password\) => importPendingSecret\([^\n]*restoreTriggers: async backup => \{[^\n]*triggerEngine\.restoreBackup\(backup\)/);
});

test('all seven authorities precede restore and effects; the storage opens with the global hold callback', async () => {
  const source = await readFile(new URL('../../../server/runs/worker.ts', import.meta.url), 'utf8');
  const at = (text: string) => { const index = source.indexOf(text); assert.notEqual(index, -1, text); return index; };
  const opening = source.slice(at('  const attempt = async'), at('  const closeStorage ='));
  assert.match(opening, /openWorkerStorage\(\{[^\n]*onUnavailable: unavailable/);
  assert.ok(at('  const unavailable =') < at('  const attempt = async'));
  assert.ok(at('  let storageStatus:') < at('  const attempt = async'));
  assert.ok(at('openWorkerStorage(') < at('runs.useStorage(database!)'));
  assert.ok(at('permissionRepository.load()') < at('domainsReady = true'));
  assert.ok(at('domainsReady = true') < at('await takeWorkerRestore'));
  const skills = source.slice(at('const skills = new SkillService'), at('// Skills never keep'));
  assert.match(skills, /runAutoPromptModel\(request, \{ stateDir, beforeSpawn:requireEffects/);
});
