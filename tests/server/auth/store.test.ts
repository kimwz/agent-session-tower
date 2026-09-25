import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, canonicalIp, isLoopbackAddress } from '../../../server/auth/store.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tower-auth-'));
  const store = new AuthStore(dir); await store.start();
  return { dir, store, cleanup: async () => { store.close(); await store.flush(); await rm(dir, { recursive: true, force: true }); } };
}
test('normalizes mapped addresses and only trusts actual loopback', () => {
  assert.equal(canonicalIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(canonicalIp('0:0:0:0:0:FFFF:7f00:1'), '127.0.0.1');
  assert.equal(isLoopbackAddress('127.12.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:192.168.1.1'), false);
  assert.equal(isLoopbackAddress('localhost'), false);
});
test('credentials are hashed and private; sessions bind IP and revoke on change', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.store.login('192.0.2.1', 'admin', 'bad')).status, 'unconfigured');
    await f.store.setCredentials(' admin ', 'password-test-123');
    const raw = await readFile(join(f.dir, 'auth.json'), 'utf8');
    assert.ok(!raw.includes('password-test-123'));
    assert.equal((await stat(join(f.dir, 'auth.json'))).mode & 0o777, 0o600);
    const result = await f.store.login('192.0.2.1', 'admin', 'password-test-123');
    assert.equal(result.status, 'success'); assert.ok(result.sessionId);
    assert.ok(f.store.session(result.sessionId, '::ffff:192.0.2.1'));
    assert.equal(f.store.session(result.sessionId, '192.0.2.2'), false);
    const revoked: string[] = []; f.store.onRevoke(token => revoked.push(token));
    await f.store.setCredentials('admin', 'new-password-test');
    assert.deepEqual(revoked, [result.sessionId]);
    assert.equal(f.store.session(result.sessionId, '192.0.2.1'), false);
  } finally { await f.cleanup(); }
});
test('five cumulative failures permanently block across restarts and successful logins; manual unblock resets', async () => {
  const f = await fixture();
  try {
    await f.store.setCredentials('admin', 'password-test-123');
    for (let i = 0; i < 3; i++) assert.equal((await f.store.login('192.0.2.1', 'admin', 'wrong')).status, 'failure');
    const success = await f.store.login('192.0.2.1', 'admin', 'password-test-123');
    assert.equal(success.status, 'success');
    const results = await Promise.all(Array.from({ length: 4 }, () => f.store.login('192.0.2.1', 'admin', 'wrong')));
    assert.deepEqual(results.map(result => result.status), ['failure', 'blocked', 'blocked', 'blocked']);
    assert.equal(f.store.session(success.sessionId!, '192.0.2.1'), false);
    f.store.close();
    const restarted = new AuthStore(f.dir); await restarted.start();
    try {
      assert.equal((await restarted.login('192.0.2.1', 'admin', 'password-test-123')).status, 'blocked');
      assert.equal(restarted.overview().blockedIps.length, 1);
      assert.ok(restarted.overview().attempts.some(attempt => attempt.result === 'success'));
      assert.ok(restarted.overview().attempts.some(attempt => attempt.result === 'failure'));
      await restarted.unblock('192.0.2.1');
      assert.equal((await restarted.login('192.0.2.1', 'admin', 'password-test-123')).status, 'success');
      assert.equal((await restarted.login('192.0.2.1', 'admin', 'wrong')).status, 'failure');
    } finally { restarted.close(); await restarted.flush(); }
  } finally { await f.cleanup(); }
});
test('malformed state fails closed', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'auth-security.json'), JSON.stringify({ version: 1, attempts: [], failures: { '192.0.2.1': 5 }, blockedIps: [] }));
    await assert.rejects(new AuthStore(f.dir).start(), /Missing blocked/);
    await writeFile(join(f.dir, 'auth.json'), '{}');
    await assert.rejects(new AuthStore(f.dir).start(), /Invalid auth.json/);
  } finally { await f.cleanup(); }
});
test('limits pending work and does not grant sessions when audit persistence fails', async () => {
  const f = await fixture();
  try {
    await f.store.setCredentials('admin', 'password-test-123');
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => f.store.login('192.0.2.10', 'admin', 'wrong')));
    assert.equal(results.filter(result => result.status === 'rejected').length, 4);
    for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.statusCode, 429);
    await rm(join(f.dir, 'auth-security.json'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(f.dir, 'auth-security.json'));
    await assert.rejects(f.store.login('192.0.2.11', 'admin', 'password-test-123'));
    await assert.rejects(f.store.login('192.0.2.11', 'admin', 'password-test-123'), /not running/);
  } finally { await f.cleanup(); }
});
test('sessions expire after seven days with proactive revocation and never survive restart', async context => {
  const f = await fixture();
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-01-01T00:00:00Z') });
  try {
    await f.store.setCredentials('admin', 'password-test-123');
    const login = await f.store.login('192.0.2.1', 'admin', 'password-test-123');
    assert.ok(login.sessionId);
    const revoked: string[] = [];
    f.store.onRevoke(token => revoked.push(token));
    context.mock.timers.tick(7 * 24 * 60 * 60 * 1000 - 1);
    assert.equal(f.store.session(login.sessionId, '192.0.2.1'), true);
    assert.deepEqual(revoked, []);
    context.mock.timers.tick(1);
    // The timer must notify stream consumers without waiting for another request.
    assert.deepEqual(revoked, [login.sessionId]);
    assert.equal(f.store.session(login.sessionId, '192.0.2.1'), false);
    const fresh = await f.store.login('192.0.2.1', 'admin', 'password-test-123');
    assert.ok(fresh.sessionId);
    assert.equal(f.store.session(fresh.sessionId, '192.0.2.1'), true);
    f.store.close();
    const restarted = new AuthStore(f.dir);
    await restarted.start();
    try {
      assert.equal(restarted.configured(), true);
      assert.equal(restarted.session(fresh.sessionId, '192.0.2.1'), false);
    } finally { restarted.close(); await restarted.flush(); }
  } finally { await f.cleanup(); context.mock.timers.reset(); }
});
