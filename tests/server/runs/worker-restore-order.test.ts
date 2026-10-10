import { workerLegacyFiles } from '../../../server/runs/storage-transfer.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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


test('all seven authorities precede restore and effects; completed offline SDK uses the initialized global hold callback', async () => {
  const source = await readFile(new URL('../../../server/runs/worker.ts', import.meta.url), 'utf8');
  const completed = source.slice(source.indexOf('// Completed maintenance may reopen'), source.indexOf('  evaluation = await evaluate();'));
  assert.match(completed, /openStorage\(\{[^\n]*onUnavailable:unavailable/);
  assert.ok(source.indexOf('  const unavailable =') < source.indexOf('// Completed maintenance may reopen'));
  assert.ok(source.indexOf('  let storageStatus:') < source.indexOf('// Completed maintenance may reopen'));
  assert.ok(source.indexOf('domainsReady = true') < source.indexOf('await takeWorkerRestore'));
  for (const owner of ['bootstrapFreshPermissions(permissionRepository', 'bootstrapExternal(repository', 'permissionRepository.load()', 'earlyRetentionBootstrap()', 'bootstrapTriggers(earlyTriggerRepository']) assert.ok(source.indexOf(owner) < source.indexOf('domainsReady = true'));
  const skills = source.slice(source.indexOf('const skills = new SkillService'), source.indexOf('// Skills never keep'));
  assert.match(skills, /runAutoPromptModel\(request, \{ stateDir, beforeSpawn:requireEffects/);
});


test('all seven fresh probes require actual absence and hold each additional domain source, seal and pending evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-fresh-probes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const domain of ['runs', 'retention', 'triggers', 'permissions', 'remote', 'auto-prompt', 'automation-workflows']) assert.equal(await workerLegacyFiles(dir, domain), 'absent');
  for (const [domain, names] of [
    ['permissions', ['permissions.json', 'permissions-storage-migrations', 'storage-permissions-pending.json']],
    ['remote', ['remote-requests.json', 'remote-storage-migrations']],
    ['auto-prompt', ['auto-prompts.json', 'auto-prompt-storage-migrations']],
    ['automation-workflows', ['slack-automation.json', 'github-automation.json', 'automation-workflows-storage-migrations']],
  ] as const) {
    for (const name of names) {
      const fixture = join(dir, `${domain}-${name}`);
      await mkdir(fixture, { mode: 0o700 });
      await writeFile(join(fixture, name), '', { mode: 0o600 });
      assert.equal(await workerLegacyFiles(fixture, domain), 'present');
    }
  }
});
