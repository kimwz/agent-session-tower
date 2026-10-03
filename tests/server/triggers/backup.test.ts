import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTriggerSecrets, secretsBackupOf, triggerBackupOf } from '../../../server/triggers/backup.js';
import { validStoredSecret } from '../../../server/triggers/secrets.js';

const secret = (id: string, value = `v-${id}`) => ({ id, name: id, origin: 'https://example.com', value, createdAt: '2026-10-01T00:00:00.000Z' });

test('a trigger backup keeps the named fields in order and passes triggers through as saved', () => {
  const encoded = { id: 'o', source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 0 31 2 *', timezone: 'UTC' } }, onceSchedule: { at: '2026-12-01T09:00:00.000Z', enabled: true, revision: 1 }, archivedAt: 'x' };
  assert.equal(JSON.stringify(triggerBackupOf({ events: [1], triggers: [encoded], onceConsumed: { o: { at: 'a', eventId: 'e' } }, cursors: { o: { github: { handled: [] } } } })),
    `{"onceConsumed":{"o":{"at":"a","eventId":"e"}},"triggers":[${JSON.stringify(encoded)}],"settings":{},"trustedFolders":[],"secretGrants":{},"fired":{},"github":{"o":{"handled":[]}}}`);
  assert.equal(triggerBackupOf([]), undefined);
  assert.equal(triggerBackupOf(undefined), undefined);
});

test('trigger secrets: the file is kept as it is; a restore takes the backup\'s per id and keeps local-only ones, and needs every entry valid', () => {
  assert.deepEqual(secretsBackupOf([secret('a')]), [secret('a')]);
  assert.deepEqual(secretsBackupOf({ odd: true }), { odd: true });
  assert.equal(secretsBackupOf('x'), undefined);
  assert.deepEqual(mergeTriggerSecrets([secret('a', 'new')], [secret('a', 'old'), secret('b')]), [secret('a', 'new'), secret('b')]);
  for (const invalid of [{}, [{ ...secret('a'), value: 1 }], [['a']]]) assert.equal(mergeTriggerSecrets(invalid, []), undefined);
  // One check of the shape, with no count limit (a restore may keep more than the 50 that can be created).
  assert.equal(Array.from({ length: 60 }, (_, index) => secret(String(index))).every(validStoredSecret), true);
});
