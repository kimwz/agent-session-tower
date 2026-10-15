import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, canonicalIp, isLoopbackAddress, sessionKey } from '../../../server/auth/store.js';
import { statusOf } from '../../../shared/errors.js';
import { blockRename } from '../../helpers/private-writes.js';
import { fastScrypt } from '../../helpers/fast-scrypt.js';

fastScrypt();

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
    const saved = JSON.parse(raw);
    assert.deepEqual([saved.algorithm, saved.N, saved.r, saved.p, saved.salt.length, saved.hash.length], ['scrypt', 131072, 8, 1, 64, 128]);
    assert.equal((await stat(join(f.dir, 'auth.json'))).mode & 0o777, 0o600);
    const result = await f.store.login('192.0.2.1', 'admin', 'password-test-123');
    assert.equal(result.status, 'success'); assert.ok(result.sessionId);
    assert.ok(f.store.session(result.sessionId, '::ffff:192.0.2.1'));
    assert.equal(f.store.session(result.sessionId, '192.0.2.2'), false);
    const revoked: string[] = []; f.store.onRevoke(token => revoked.push(token));
    await f.store.setCredentials('admin', 'new-password-test');
    assert.deepEqual(revoked, [sessionKey(result.sessionId)]);
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
    for (const result of results) if (result.status === 'rejected') assert.equal(statusOf(result.reason), 429);
    await rm(join(f.dir, 'auth-security.json'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(f.dir, 'auth-security.json'));
    await assert.rejects(f.store.login('192.0.2.11', 'admin', 'password-test-123'));
    await assert.rejects(f.store.login('192.0.2.11', 'admin', 'password-test-123'), /not running/);
  } finally { await f.cleanup(); }
});
test('sessions expire after seven days with proactive revocation', async context => {
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
    assert.deepEqual(revoked, [sessionKey(login.sessionId)]);
    assert.equal(f.store.session(login.sessionId, '192.0.2.1'), false);
    const fresh = await f.store.login('192.0.2.1', 'admin', 'password-test-123');
    assert.ok(fresh.sessionId);
    assert.equal(f.store.session(fresh.sessionId, '192.0.2.1'), true);
  } finally { await f.cleanup(); context.mock.timers.reset(); }
});
test('sign-ins survive a restart until they expire, log out, or the password changes; only token digests are saved', async () => {
  const f = await fixture();
  const restart = async (store: AuthStore) => { store.close(); await store.flush(); const next = new AuthStore(f.dir); await next.start(); return next; };
  let store = f.store;
  try {
    await store.setCredentials('admin', 'password-test-123');
    const kept = (await store.login('192.0.2.1', 'admin', 'password-test-123')).sessionId!;
    const leaving = (await store.login('192.0.2.2', 'admin', 'password-test-123')).sessionId!;
    store.logout(leaving);
    await store.flush();
    const saved = await readFile(join(f.dir, 'auth-sessions.json'), 'utf8');
    assert.ok(!saved.includes(kept) && saved.includes(sessionKey(kept)));
    assert.equal((await stat(join(f.dir, 'auth-sessions.json'))).mode & 0o777, 0o600);
    store = await restart(store);
    assert.equal(store.session(kept, '192.0.2.1'), true);
    assert.equal(store.session(kept, '192.0.2.9'), false);
    assert.equal(store.session(leaving, '192.0.2.2'), false);
    // An expired record is not restored.
    const record = JSON.parse(await readFile(join(f.dir, 'auth-sessions.json'), 'utf8'));
    await writeFile(join(f.dir, 'auth-sessions.json'), JSON.stringify({ ...record, sessions: record.sessions.map((entry: { expires: number }) => ({ ...entry, expires: Date.now() - 1 })) }));
    const expired = new AuthStore(f.dir); await expired.start();
    assert.equal(expired.session(kept, '192.0.2.1'), false);
    expired.close(); await expired.flush();
    await writeFile(join(f.dir, 'auth-sessions.json'), JSON.stringify(record));
    store.close(); await store.flush();
    store = new AuthStore(f.dir); await store.start();
    assert.equal(store.session(kept, '192.0.2.1'), true);
    await store.setCredentials('admin', 'new-password-test');
    store = await restart(store);
    assert.equal(store.session(kept, '192.0.2.1'), false);
    // An unreadable file signs everyone out instead of stopping Tower.
    await writeFile(join(f.dir, 'auth-sessions.json'), 'not json');
    store = await restart(store);
    assert.equal(store.configured(), true);
  } finally { store.close(); await store.flush(); await rm(f.dir, { recursive: true, force: true }); }
});
test('verifying the password counts toward the same IP block as sign-ins and signs nobody in', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.store.verifyPassword('192.0.2.1', 'password-test-123'), { status: 'unconfigured' });
    await f.store.setCredentials('admin', 'password-test-123');
    const signedIn = (await f.store.login('192.0.2.1', 'admin', 'password-test-123')).sessionId!;
    await f.store.flush(); const sessions = await readFile(join(f.dir, 'auth-sessions.json'), 'utf8');
    assert.deepEqual(await f.store.verifyPassword('::ffff:192.0.2.1', 'password-test-123'), { status: 'success' });
    await f.store.flush(); assert.equal(await readFile(join(f.dir, 'auth-sessions.json'), 'utf8'), sessions, 'no sign-in was added');
    assert.deepEqual({ ...f.store.overview().attempts[0], id: '', at: '' }, { id: '', at: '', ip: '192.0.2.1', username: 'admin', result: 'success' });
    const blockedSession = (await f.store.login('192.0.2.2', 'admin', 'password-test-123')).sessionId!;
    for (let i = 0; i < 3; i++) assert.equal((await f.store.login('192.0.2.2', 'admin', 'wrong')).status, 'failure');
    assert.deepEqual(await f.store.verifyPassword('192.0.2.2', 'wrong-password-1'), { status: 'failure' });
    assert.deepEqual(await f.store.verifyPassword('192.0.2.2', 'wrong-password-2'), { status: 'blocked' });
    assert.equal(f.store.session(blockedSession, '192.0.2.2'), false, 'a block reached by verifying signs that IP out');
    assert.equal((await f.store.login('192.0.2.2', 'admin', 'password-test-123')).status, 'blocked');
    assert.deepEqual(await f.store.verifyPassword('192.0.2.2', 'password-test-123'), { status: 'blocked' });
    assert.deepEqual(f.store.overview().blockedIps.map(entry => entry.ip), ['192.0.2.2']);
    assert.equal(f.store.session(signedIn, '192.0.2.1'), true);
    assert.deepEqual(await f.store.verifyPassword('192.0.2.1', 'password-test-123'), { status: 'success' });
  } finally { await f.cleanup(); }
});
test('prepared credentials change nothing until committed; the commit saves them and signs everyone out once', async () => {
  const f = await fixture();
  try {
    assert.equal(f.store.currentCredentialId(), undefined);
    await assert.rejects(f.store.prepareCredentials('admin', 'short'), error => statusOf(error) === 400);
    await f.store.setCredentials('admin', 'password-test-123');
    const current = f.store.currentCredentialId()!; assert.match(current, /^[a-f0-9]{64}$/);
    const signedIn = (await f.store.login('192.0.2.1', 'admin', 'password-test-123')).sessionId!;
    const saved = await readFile(join(f.dir, 'auth.json'), 'utf8');
    const revoked: string[] = []; f.store.onRevoke(key => revoked.push(key));
    const prepared = await f.store.prepareCredentials(' admin ', 'new-password-test');
    assert.match(prepared.credentialId, /^[a-f0-9]{64}$/); assert.notEqual(prepared.credentialId, current);
    // A change abandoned before its commit (the vault could not be wrapped) leaves everything as it was.
    assert.equal(await readFile(join(f.dir, 'auth.json'), 'utf8'), saved); assert.equal(f.store.currentCredentialId(), current);
    assert.equal(f.store.session(signedIn, '192.0.2.1'), true);
    assert.equal((await f.store.login('192.0.2.1', 'admin', 'new-password-test')).status, 'failure');
    const restore = await blockRename(join(f.dir, 'auth.json'));
    await assert.rejects(prepared.commit());
    await restore();
    assert.equal(await readFile(join(f.dir, 'auth.json'), 'utf8'), saved); assert.equal(f.store.currentCredentialId(), current);
    assert.equal(f.store.session(signedIn, '192.0.2.1'), true); assert.deepEqual(revoked, []);
    await prepared.commit();
    assert.equal(f.store.currentCredentialId(), prepared.credentialId); assert.deepEqual(revoked, [sessionKey(signedIn)]);
    const fresh = (await f.store.login('192.0.2.1', 'admin', 'new-password-test')).sessionId!;
    await prepared.commit();
    assert.equal(f.store.session(fresh, '192.0.2.1'), true, 'a repeated commit signs nobody out again');
    f.store.close(); await f.store.flush();
    const restarted = new AuthStore(f.dir); await restarted.start();
    try { assert.equal(restarted.currentCredentialId(), prepared.credentialId, 'the credential ID follows auth.json'); } finally { restarted.close(); await restarted.flush(); }
  } finally { await f.cleanup(); }
});
