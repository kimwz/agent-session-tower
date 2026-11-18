import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/skip-fsync.js';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_REMOTE_MCP_KEYS, REMOTE_MCP_KEYS_FILE, RemoteMcpKeys } from '../../../server/remote-mcp/keys.js';

async function folder(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-remote-mcp-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a key is shown once, kept only as its hash in an owner-only file, and works until it is revoked', async t => {
  const dir = await folder(t);
  const keys = await RemoteMcpKeys.open(dir);
  const { key, created } = await keys.create({ name: ' laptop ', scope: 'read' });
  assert.match(key, /^tower_mcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.name, 'laptop');
  assert.equal(created.hint, key.slice(-4));
  const file = join(dir, REMOTE_MCP_KEYS_FILE);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = await readFile(file, 'utf8');
  assert.ok(!saved.includes(key) && !saved.includes(key.slice('tower_mcp_'.length)), 'the key itself is never written');
  assert.ok(!JSON.stringify(keys.list()).includes(JSON.parse(saved).keys[0].hash), 'the page never sees the hash either');

  assert.equal(keys.verify(key)?.id, created.id);
  assert.ok(keys.verify(key)?.lastUsedAt, 'its use is noted');
  assert.equal(keys.verify(`${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`), undefined, 'another key of the same shape');
  for (const wrong of [undefined, '', key.toUpperCase(), ` ${key}`, [key], 'tower_mcp_short']) assert.equal(keys.verify(wrong), undefined);

  const reopened = await RemoteMcpKeys.open(dir);
  assert.equal(reopened.verify(key)?.scope, 'read', 'a restart keeps the key');
  await keys.revoke(created.id);
  assert.equal(keys.verify(key), undefined, 'revoked at once');
  assert.equal((await RemoteMcpKeys.open(dir)).verify(key), undefined, 'and after a restart');
  await assert.rejects(keys.revoke(created.id), /찾을 수 없습니다/);
});

test('names, scopes and the number of keys are checked', async t => {
  const keys = await RemoteMcpKeys.open(await folder(t));
  await assert.rejects(keys.create({ name: '  ', scope: 'read' }), /1~60자/);
  await assert.rejects(keys.create({ name: 'x'.repeat(61), scope: 'read' }), /1~60자/);
  await assert.rejects(keys.create({ name: 'a', scope: 'admin' }), /read 또는 write/);
  for (let index = 0; index < MAX_REMOTE_MCP_KEYS; index++) await keys.create({ name: `k${index}`, scope: index % 2 ? 'write' : 'read' });
  await assert.rejects(keys.create({ name: 'one more', scope: 'read' }), /20개까지/);
  assert.equal(keys.list().keys.length, MAX_REMOTE_MCP_KEYS);
});

test('writes keep their order, so a revocation is never undone by an earlier write', async t => {
  const dir = await folder(t);
  const keys = await RemoteMcpKeys.open(dir);
  const first = await keys.create({ name: 'first', scope: 'read' });
  const [second] = await Promise.all([keys.create({ name: 'second', scope: 'write' }), keys.revoke(first.created.id)]);
  await keys.flush();
  const reopened = await RemoteMcpKeys.open(dir);
  assert.equal(reopened.verify(first.key), undefined);
  assert.equal(reopened.verify(second.key)?.scope, 'write');
});

test('a file this build cannot read is set aside and reported, and no key from it works', async t => {
  const dir = await folder(t);
  await writeFile(join(dir, REMOTE_MCP_KEYS_FILE), '{"version":1,"keys":[{"id":"nope"}]}', { mode: 0o600 });
  const logged: string[] = [];
  const keys = await RemoteMcpKeys.open(dir, message => logged.push(message));
  assert.match(keys.list().error ?? '', /읽지 못해/);
  assert.equal(logged.length, 1);
  assert.ok((await readdir(dir)).some(name => name.startsWith(`${REMOTE_MCP_KEYS_FILE}.unreadable-`)), 'kept for inspection');
  const { key } = await keys.create({ name: 'new', scope: 'read' });
  assert.equal(keys.list().error, undefined, 'a new key clears the notice');
  assert.ok(keys.verify(key));
});
