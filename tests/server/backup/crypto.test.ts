import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptBackup, encryptBackup, readBackupHeader } from '../../../server/backup/crypto.js';

const meta = { towerVersion: '1.91.0', from: 'studio', createdAt: '2026-09-30T00:00:00.000Z' };

test('a backup opens only with its passphrase and gives back exactly what was put in', async () => {
  const payload = { version: 1, secret: 'xoxp-token', nested: { list: [1, 2, 3] } };
  const text = await encryptBackup(payload, 'correct horse', meta);
  assert.doesNotMatch(text, /xoxp-token/, 'nothing is readable without the passphrase');
  const header = readBackupHeader(text);
  assert.equal(header.from, 'studio');
  assert.equal(header.kdf.name, 'scrypt');
  const opened = await decryptBackup(text, 'correct horse');
  assert.deepEqual(opened.payload, payload);
  assert.equal(opened.header.createdAt, meta.createdAt);
  await assert.rejects(decryptBackup(text, 'wrong horse'), /암호가 맞지 않거나/);
});

test('a changed header or body is refused, and so are files that are not backups or ask for too much work', async () => {
  const text = await encryptBackup({ version: 1 }, 'correct horse', meta);
  const envelope = JSON.parse(text);
  await assert.rejects(decryptBackup(JSON.stringify({ ...envelope, from: 'elsewhere' }), 'correct horse'), /암호가 맞지 않거나/, 'the header is authenticated');
  const data = Buffer.from(envelope.data, 'base64'); data[0] ^= 1;
  await assert.rejects(decryptBackup(JSON.stringify({ ...envelope, data: data.toString('base64') }), 'correct horse'), /암호가 맞지 않거나/);
  await assert.rejects(decryptBackup(JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, N: 2 ** 24 } }), 'correct horse'), /손상/);
  await assert.rejects(decryptBackup(JSON.stringify({ ...envelope, version: 2 }), 'correct horse'), /새 버전/);
  await assert.rejects(decryptBackup(JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, N: 2 ** 20, r: 16 } }), 'correct horse'), /손상/, 'more memory than allowed is a damaged file, not a crash');
  await assert.rejects(decryptBackup('{"format":"other"}', 'correct horse'), /백업 파일이 아닙니다/);
  await assert.rejects(decryptBackup('not json', 'correct horse'), /백업 파일이 아닙니다/);
  await assert.rejects(encryptBackup({}, 'short', meta), /8자 이상/);
});
