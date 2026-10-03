import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePermissions, permissionsBackupOf } from '../../../server/permissions/backup.js';

test('a backup keeps the permission rules and reviewer settings; a restore keeps this computer\'s requests, Codex files and lost note', () => {
  assert.equal(JSON.stringify(permissionsBackupOf({ version: 1, rules: [{ id: 'r' }], requests: [{ id: 'q' }], codex: [], autoReview: { enabled: true } })), '{"rules":[{"id":"r"}],"autoReview":{"enabled":true}}');
  assert.equal(JSON.stringify(permissionsBackupOf({ rules: 'x', autoReview: [] })), '{"rules":[]}');
  assert.equal(JSON.stringify(mergePermissions({ rules: [{ id: 'new' }] }, { requests: [{ id: 'pending', notification: {} }], codex: [{ path: '/c' }], lost: 'note', rules: [{ id: 'old' }] })),
    '{"version":1,"requests":[{"id":"pending","notification":{}}],"codex":[{"path":"/c"}],"lost":"note","rules":[{"id":"new"}]}');
  assert.equal(JSON.stringify(mergePermissions({ rules: [], autoReview: { enabled: false } }, undefined)), '{"version":1,"requests":[],"codex":[],"rules":[],"autoReview":{"enabled":false}}');
  for (const invalid of [undefined, [], { rules: {} }]) assert.equal(mergePermissions(invalid, {}), undefined);
});
