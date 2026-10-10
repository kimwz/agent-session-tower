import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalStorageFixture, backupWorkflow } from '../remote/external-storage-fixture.js';
import { collectAutomationSettings, restoreAutomationSettings } from '../../../server/slack/backup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { automationBackupOf, hasUnfinishedSlackWork, mergeAutomation, restoreSlackConnection, slackAccountKey } from '../../../server/slack/backup.js';

const RULE = { id: 'rule', name: 'Rule', enabled: true, condition: 'Asked', instructions: 'Answer', replyInstructions: 'Reply', provider: 'codex' };

test('automation backups keep the rules; a restore takes valid rules with the local workflows', () => {
  assert.equal(JSON.stringify(automationBackupOf({ rules: [RULE], workflows: [{ id: 'w' }], extra: 1 })), `{"rules":[${JSON.stringify(RULE)}]}`);
  assert.equal(JSON.stringify(automationBackupOf({})), '{"rules":[]}');
  assert.equal(JSON.stringify(mergeAutomation({ rules: [RULE], workflows: [{ id: 'b' }], extra: 1 }, { workflows: [{ id: 'local' }] })), `{"workflows":[{"id":"local"}],"rules":[${JSON.stringify(RULE)}]}`);
  assert.equal(JSON.stringify(mergeAutomation({ rules: [] }, [])), '{"rules":[],"workflows":[]}');
  for (const invalid of [undefined, { rules: {} }, { rules: [{ ...RULE, provider: 'gemini' }] }]) assert.equal(mergeAutomation(invalid, {}), undefined);
});

test('the Slack account and unfinished work decide a connection swap; a connection the service refuses is never taken', () => {
  assert.equal(slackAccountKey({ account: { teamId: 'T', userId: 'U' } }), 'T:U');
  assert.equal(slackAccountKey(undefined), '');
  for (const status of ['received', 'matching', 'dispatching', 'running', 'composing', 'sending', 'reply-uncertain']) assert.equal(hasUnfinishedSlackWork({ workflows: [{ status }] }), true, status);
  for (const automation of [{ workflows: [{ status: 'completed' }] }, { workflows: 'x' }, undefined]) assert.equal(hasUnfinishedSlackWork(automation), false);
  assert.deepEqual(restoreSlackConnection({ enabled: true }), { enabled: true });
  assert.equal(restoreSlackConnection({ enabled: 'yes' }), undefined);
});

test('SQL workflow owner backs up and restores rules without exposing local work or source secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-slack-backup-'));
  const workflow = backupWorkflow('local');
  const source = JSON.stringify({ rules: [RULE], workflows: [workflow], secret: 'fixture-source-secret' });
  await writeFile(join(directory, 'slack-automation.json'), source, { mode: 0o600 });
  const f = await externalStorageFixture(t, directory);
  t.after(async () => { await f.storage.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(await collectAutomationSettings(f.workflows, 'slack'), { rules: [RULE] });
  const local = f.workflows.source(await f.workflows.loadRows(), 'slack').workflows;
  await restoreAutomationSettings(f.workflows, 'slack', { rules: [] });
  assert.deepEqual(await collectAutomationSettings(f.workflows, 'slack'), { rules: [] });
  assert.deepEqual(f.workflows.source(await f.workflows.loadRows(), 'slack').workflows, local);
  assert.equal(await readFile(join(directory, 'slack-automation.json'), 'utf8'), source);
});
