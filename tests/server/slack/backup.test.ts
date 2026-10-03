import assert from 'node:assert/strict';
import test from 'node:test';
import { automationBackupOf, hasUnfinishedSlackWork, mergeAutomation, restoreSlackConnection, slackAccountKey } from '../../../server/slack/backup.js';

const RULE = { id: 'rule', name: 'Rule', enabled: true, condition: 'Asked', instructions: 'Answer', replyInstructions: 'Reply', provider: 'codex' };

test('automation backups keep the rules; a restore takes valid rules with the local workflows', () => {
  assert.equal(JSON.stringify(automationBackupOf({ rules: [RULE], workflows: [{ id: 'w' }], extra: 1 })), `{"rules":[${JSON.stringify(RULE)}]}`);
  assert.equal(JSON.stringify(automationBackupOf({})), '{"rules":[]}');
  assert.equal(JSON.stringify(mergeAutomation({ rules: [RULE], workflows: [{ id: 'b' }], extra: 1 }, { workflows: [{ id: 'local' }] })), `{"rules":[${JSON.stringify(RULE)}],"workflows":[{"id":"local"}]}`);
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
