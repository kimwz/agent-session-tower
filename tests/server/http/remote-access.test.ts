import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { accessPasswordPath, loadAccessPassword, networkAccess } from '../../../server/http/remote-access.js';

function entry(address: string, internal = false, family = 'IPv4'): NetworkInterfaceInfo {
  return { address, internal, family, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24`, scopeid: 0 } as NetworkInterfaceInfo;
}

const interfaces = {
  lo0: [entry('127.0.0.1', true), entry('::1', true, 'IPv6')],
  en0: [entry('203.0.113.10'), entry('2001:db8::1', false, 'IPv6')],
  en1: [entry('192.168.0.12'), entry('203.0.113.10')],
};

test('wildcard IPv4 bind requires authentication and permits only the current IPv4 interface origins', () => {
  const access = networkAccess('0.0.0.0', 8000, interfaces);
  assert.equal(access.remote, true);
  assert.equal(access.browserUrl, 'http://localhost:8000');
  assert.deepEqual([...access.origins], ['http://203.0.113.10:8000', 'http://192.168.0.12:8000']);
  assert.equal(access.origins.has('http://0.0.0.0:8000'), false);
});

test('explicit bind trusts only that address and opens a reachable URL', () => {
  const access = networkAccess('203.0.113.10', 8000, interfaces);
  assert.equal(access.remote, true);
  assert.deepEqual([...access.origins], ['http://203.0.113.10:8000']);
  assert.equal(access.browserUrl, 'http://203.0.113.10:8000');
  assert.equal(networkAccess('127.0.0.1', 8000, interfaces).remote, false);
  assert.equal(networkAccess('127.0.0.2', 8000, interfaces).remote, false);
  assert.equal(networkAccess('127.0.0.2', 8000, interfaces).browserUrl, 'http://127.0.0.2:8000');
  assert.deepEqual([...networkAccess('203.0.113.10', 80, interfaces).origins], ['http://203.0.113.10']);
  assert.throws(() => networkAccess('example.com', 8000, interfaces), /IPv4/);
  assert.throws(() => networkAccess('::', 8000, interfaces), /IPv4/);
});

test('remote password is strong, private, stable across restart, and repairs file permissions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-password-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await loadAccessPassword(dir);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  const path = accessPasswordPath(dir);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, 'utf8'), `${first}\n`);
  await chmod(path, 0o644);
  assert.equal(await loadAccessPassword(dir), first);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('invalid or symlinked password files are rejected instead of exposing a weak password', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-invalid-password-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = accessPasswordPath(dir);
  await writeFile(path, 'weak');
  await assert.rejects(loadAccessPassword(dir), /Invalid access password file/);
  await rm(path);
  const target = join(dir, 'unrelated');
  await writeFile(target, 'unrelated file');
  await symlink(target, path);
  await assert.rejects(loadAccessPassword(dir));
  assert.equal(await readFile(target, 'utf8'), 'unrelated file');
});
