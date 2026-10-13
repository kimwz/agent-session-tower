import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, sessionKey } from '../../../server/auth/store.js';
import { VaultPassword, type Viewer } from '../../../server/auth/vault-password.js';
import { ownerSecretControl } from '../../../server/link/secret-routes.js';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import { SecretService } from '../../../server/secrets/service.js';
import { VIEW_IDLE_MS, ViewGrants } from '../../../server/secrets/view-grants.js';
import type { SecretSettingsView, SecretValue } from '../../../shared/secrets.js';
import { FixtureRuns, secretService, vaultTemplate } from '../../helpers/secrets.js';

/** The web's coordinator on fixture state: a real AuthStore and a real secret runtime behind the owner control, with injectable failures. */
const USER = 'monitor';
const RECOVERY = 'fixture-vault-password-recovery';
const password = (n: number) => `fixture-tower-password-${n}`;
const IP = '192.0.2.10';
const vaults = vaultTemplate(RECOVERY);
before(() => vaults.ready());
after(() => vaults.dispose());
type Auth = NonNullable<ConstructorParameters<typeof VaultPassword>[0]>;
type Refusal = Error & { kind?: string; code?: string };
const refused = (kind: string, code?: string) => (error: Refusal) => error.kind === kind && error.code === code && !/fixture-tower-password|fixture-vault-password/.test(error.message);

async function fixture(t: TestContext, options: { vault?: 'open' | 'locked' | 'none'; valueView?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-vault-password-')));
  const authDir = join(directory, 'auth'), stateDir = join(directory, 'state');
  const store = new AuthStore(authDir); await store.start(); await store.setCredentials(USER, password(0));
  // Sign-in writes finish before the folder goes (hooks run in the order they were added).
  t.after(async () => { await store.flush(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const service = options.vault === 'none' ? await secretService(stateDir) : await vaults.open(stateDir);
  const runtime = new SecretRuntime({ stateDir, service, runs: new FixtureRuns() }); t.after(() => runtime.close());
  const valueView = options.valueView ?? true; const actions: string[] = [];
  const worker = { supports: (capability: string) => capability !== 'secretValueView' || valueView, secretCall: async (operation: string, args: unknown[] = []) => {
    if (operation === 'peers') return runtime.peers(); if (operation === 'device') return runtime.device();
    actions.push(String(args[0])); return runtime.control(String(args[0]), args[1] as Record<string, unknown>, args[2]);
  } };
  // Each named point of a change counts its calls; `failAt` throws at one of them, as a failed write or a process that died there would stop.
  let failAt: string | undefined; const seen = new Map<string, number>();
  const point = (name: string) => { const n = (seen.get(name) ?? 0) + 1; seen.set(name, n); if (`${name}#${n}` === failAt) throw new Error(`injected failure at ${name}#${n}`); };
  const secrets = async (action: string, input: Record<string, unknown>) => {
    point(`before ${action}`); const answer = await ownerSecretControl(undefined, worker, action, input); point(`after ${action}`); return answer;
  };
  const auth: Auth = {
    configured: () => store.configured(), username: () => store.username(), currentCredentialId: () => store.currentCredentialId(),
    session: (token, ip) => store.session(token, ip), login: (ip, username, value) => store.login(ip, username, value),
    verifyPassword: (ip, value) => store.verifyPassword(ip, value), onRevoke: listener => store.onRevoke(listener),
    prepareCredentials: async (username, value) => {
      point('before prepare'); const prepared = await store.prepareCredentials(username, value); point('after prepare');
      return { credentialId: prepared.credentialId, commit: async () => { point('before commit'); await prepared.commit(); point('after commit'); } };
    },
  };
  const vault = new VaultPassword(auth, secrets); t.after(() => vault.close());
  if (options.vault !== 'none') { await runtime.control('tower-wrap', { password: password(0), credentialId: store.currentCredentialId() }); if (options.vault === 'locked') await service.lock(); }
  const signIn = async (value: string) => { const { sessionId } = await store.login(IP, USER, value); assert.ok(sessionId); return { token: sessionId, ip: IP, local: false } satisfies Viewer; };
  /** The next change fails at `at` (`before tower-wrap#1`, `after commit#1`, …), or nowhere. */
  const failing = (at?: string) => { failAt = at; seen.clear(); };
  return { directory, authDir, stateDir, store, service, runtime, vault, actions, signIn, failing };
}

test('a credentials change wraps the vault key for the new password before auth.json names it: wherever it stops, the current password keeps a wrapper', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  const warn = t.mock.method(console, 'warn', () => undefined);
  let n = 0; let current = 0;
  const holds = (label: string) => {
    const id = f.store.currentCredentialId()!; const wrappers = (f.service.vault as unknown as { wrappers(): { credentialId: string }[] }).wrappers();
    assert.equal(f.service.vault.hasTower(id), true, `${label}: the credentials auth.json names keep their wrapper`);
    assert.ok(wrappers.length <= 2, `${label}: at most the current wrapper and one candidate`);
  };
  const change = async (at: string | undefined, committed: boolean) => {
    const before = f.store.currentCredentialId(); f.failing(at); n++;
    const attempt = f.vault.changeCredentials(USER, password(n));
    if (at?.includes('#1')) await assert.rejects(attempt, (error: Error) => !error.message.includes('fixture-tower-password'), at);
    else assert.equal(await attempt, 'rewrapped', String(at));
    if (committed) current = n;
    if (committed) assert.notEqual(f.store.currentCredentialId(), before, String(at)); else assert.equal(f.store.currentCredentialId(), before, String(at));
    holds(String(at));
  };
  // Stopped before its commit, the login stays as it was; stopped after it, the new login is already wrapped.
  for (const at of ['before tower-prune#1', 'after tower-prune#1', 'before prepare#1', 'after prepare#1', 'before tower-wrap#1', 'after tower-wrap#1', 'before commit#1', 'before commit#1']) await change(at, false);
  // The login saved twice without success: the password in use still opens the locked vault with its wrapper.
  await f.service.lock();
  await f.vault.viewUnlock(await f.signIn(password(current)), { password: password(current) }, () => {});
  assert.equal(f.service.status().locked, false);
  await change('after commit#1', true);
  // A failed removal of the previous wrapper after the commit is only logged: a harmless extra wrapper the next change removes.
  for (const at of ['before tower-prune#2', 'after tower-prune#2', undefined]) await change(at, true);
  assert.equal(warn.mock.calls.length, 2, 'each failed removal is reported, without the password');
  assert.equal(JSON.stringify(warn.mock.calls.map(call => call.arguments)).includes('fixture-tower-password'), false);
  // Restarted from disk (a process that died after the last step): the saved login opens the vault with its own wrapper.
  const store = new AuthStore(f.authDir); await store.start(); t.after(() => store.close());
  const service = new SecretService({ stateDir: f.stateDir }); await service.start();
  assert.equal(store.currentCredentialId(), f.store.currentCredentialId());
  assert.equal(await service.towerUnlock(password(current), store.currentCredentialId()!), true);
});

test('a credentials change and a value-view unlock never interleave: an old password never wraps the new credentials', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  // The change first: it signs everyone out, so the unlock that waited is refused before the worker sees its password.
  const viewer = await f.signIn(password(0));
  const [changed, unlocked] = await Promise.allSettled([f.vault.changeCredentials(USER, password(1)), f.vault.viewUnlock(viewer, { password: password(0) }, () => {})]);
  assert.deepEqual(changed, { status: 'fulfilled', value: 'rewrapped' });
  assert.equal(unlocked.status, 'rejected'); assert.ok(refused('unauthorized', 'login-required')((unlocked as PromiseRejectedResult).reason));
  assert.equal(f.actions.filter(action => action === 'view-unlock').length, 0);
  const next = f.store.currentCredentialId()!;
  await assert.rejects(f.service.towerUnlock(password(0), next), /Cannot unlock vault/);
  assert.equal(await f.service.towerUnlock(password(1), next), false, 'the new password unwraps the open key');
  // The unlock first: it is granted, then the change ends every grant and moves the wrapper to its own password.
  const second = await f.signIn(password(1));
  const [opened, moved] = await Promise.allSettled([f.vault.viewUnlock(second, { password: password(1) }, () => {}), f.vault.changeCredentials(USER, password(2))]);
  assert.equal(opened.status, 'fulfilled'); assert.deepEqual(moved, { status: 'fulfilled', value: 'rewrapped' });
  assert.equal(f.vault.grants.has(sessionKey(second.token)), false);
  assert.deepEqual([f.service.vault.hasTower(next), f.service.vault.hasTower(f.store.currentCredentialId()!)], [false, true]);
});

test('value viewing belongs to one sign-in: idle expiry, sign-out, lock, a credentials change and an ended generation each end it', { timeout: 120_000 }, async t => {
  let now = 0; const grants = new ViewGrants(() => now);
  grants.set('a', 'g1'); now += VIEW_IDLE_MS - 1; assert.equal(grants.has('a'), true);
  now += 1; assert.equal(grants.has('a'), false, 'a view that only reads the settings does not keep it alive');
  grants.set('a', 'g1'); now += VIEW_IDLE_MS - 1; assert.equal(grants.use('a'), 'g1'); now += VIEW_IDLE_MS - 1; assert.equal(grants.use('a'), 'g1', 'each value read keeps it alive');
  now += VIEW_IDLE_MS; assert.equal(grants.use('a'), undefined);
  grants.set('a', 'g1'); grants.set('b', 'g1'); grants.set('c', 'g2');
  assert.deepEqual(['a', 'b', 'c'].map(key => grants.has(key)), [false, false, true], 'a newer generation ends the grants of the older one');

  const f = await fixture(t);
  const secret = await f.service.create({ name: 'fixture key', kind: 'scalar', value: 'FIXTURE_VALUE' });
  const read = (viewer: Viewer) => f.vault.value(viewer, 'value', { secretId: secret.id, expectedVersion: 1 }) as Promise<SecretValue>;
  const owner = await f.signIn(password(0)), other = await f.signIn(password(0));
  await assert.rejects(read(owner), refused('forbidden', 'view-locked'));
  const token = await f.vault.viewUnlock(owner, { password: password(0) }, () => { throw new Error('a signed-in page signs in no further'); });
  assert.equal(token, owner.token);
  assert.equal((await read(owner)).value, 'FIXTURE_VALUE');
  await assert.rejects(read(other), refused('forbidden', 'view-locked'), 'another browser has its own');
  await assert.rejects(read({ token: '', ip: '127.0.0.1', local: true }), refused('unauthorized', 'login-required'), 'loopback alone reads no value');
  await assert.rejects(f.vault.value(owner, 'value', { secretId: secret.id, expectedVersion: 1, generation: 'page-chosen' }), refused('invalid'));
  // Viewing settings reports it; the page's own lock ends it.
  const shown = await f.vault.view(await f.runtime.control('settings', {}), owner) as SecretSettingsView;
  assert.equal(shown.valueView, true); assert.equal((await f.vault.view(await f.runtime.control('settings', {}), other) as SecretSettingsView).valueView, false);
  f.vault.viewLock(owner); await assert.rejects(read(owner), refused('forbidden', 'view-locked'));
  // Sign-out ends it.
  f.vault.grants.set(sessionKey(owner.token), f.service.lockGeneration); assert.equal((await read(owner)).value, 'FIXTURE_VALUE');
  f.store.logout(owner.token); assert.equal(f.vault.grants.has(sessionKey(owner.token)), false);
  await assert.rejects(read(owner), refused('unauthorized', 'login-required'));
  // A generation that ended (the worker locked and opened again, or another worker took over): refused, and the grant goes.
  const third = await f.signIn(password(0)); f.vault.grants.set(sessionKey(third.token), 'ended-generation');
  const asked = f.actions.length;
  await assert.rejects(read(third), refused('forbidden', 'view-locked')); assert.equal(f.actions.length, asked + 1);
  await assert.rejects(read(third), refused('forbidden', 'view-locked')); assert.equal(f.actions.length, asked + 1, 'the dropped grant is not sent again');
  // Locking the vault ends every grant; so does a credentials change, before its first step.
  f.vault.grants.set(sessionKey(third.token), f.service.lockGeneration); f.vault.grants.set(sessionKey(other.token), f.service.lockGeneration);
  await f.vault.lock({}); assert.equal(f.vault.grants.has(sessionKey(third.token)) || f.vault.grants.has(sessionKey(other.token)), false);
  const view = await f.vault.view(await f.runtime.control('settings', {}), third) as SecretSettingsView;
  assert.deepEqual([view.status.towerPassword, view.valueView], ['ready', false]);
  f.vault.grants.set(sessionKey(third.token), f.service.lockGeneration);
  f.failing('before tower-prune#1');
  await assert.rejects(f.vault.changeCredentials(USER, password(1)));
  assert.equal(f.vault.grants.has(sessionKey(third.token)), false);
});

test('a change while the vault is locked asks for the recovery password once; without a vault or with an older worker the vault is untouched', { timeout: 120_000 }, async t => {
  const locked = await fixture(t, { vault: 'locked' });
  const old = locked.store.currentCredentialId()!;
  assert.equal(await locked.vault.changeCredentials(USER, password(1)), 'locked');
  assert.deepEqual([locked.service.vault.hasTower(old), locked.service.vault.hasTower(locked.store.currentCredentialId()!)], [false, false], 'the old password no longer opens the vault');
  const viewer = await locked.signIn(password(1));
  assert.equal((await locked.vault.view(await locked.runtime.control('settings', {}), viewer) as SecretSettingsView).status.towerPassword, 'missing');
  await assert.rejects(locked.vault.viewUnlock(viewer, { password: password(1) }, () => {}), refused('conflict', 'needs-recovery'));
  await locked.vault.viewUnlock(viewer, { password: password(1), recoveryPassword: RECOVERY }, () => {});
  assert.equal(locked.service.status().locked, false); assert.equal(locked.service.vault.hasTower(locked.store.currentCredentialId()!), true);

  const none = await fixture(t, { vault: 'none' });
  assert.equal(await none.vault.changeCredentials(USER, password(1)), 'unavailable');
  assert.equal(none.service.status().initialized, false);

  const older = await fixture(t, { valueView: false });
  const before = older.store.currentCredentialId()!; older.actions.length = 0;
  assert.equal(await older.vault.changeCredentials(USER, password(1)), 'unavailable');
  assert.notEqual(older.store.currentCredentialId(), before, 'the login changes anyway');
  assert.deepEqual(older.actions, [], 'nothing new is sent to an older worker');
  assert.equal(older.service.vault.hasTower(before), true, 'its wrapper stays for an update undone');
  const signedIn = await older.signIn(password(1));
  await assert.rejects(older.vault.viewUnlock(signedIn, { password: password(1) }, () => {}), refused('unavailable', 'worker-update-pending'));
  assert.equal((await older.vault.view({ status: { initialized: true, locked: true }, peers: [], secrets: [] }, signedIn) as SecretSettingsView).status.towerPassword, undefined);
});

test('without a login account value viewing is refused with how to set one up', async () => {
  const vault = new VaultPassword(undefined, async () => ({}));
  for (const attempt of [() => vault.viewUnlock({ token: '', ip: '127.0.0.1', local: true }, { password: password(0) }, () => {}), () => vault.value({ token: '', ip: '127.0.0.1', local: true }, 'value', {})]) {
    await assert.rejects(attempt(), (error: Refusal) => error.code === 'account-required' && error.kind === 'conflict' && /로컬 계정 관리/.test(error.message));
  }
  assert.equal((await vault.view({ status: { initialized: true, locked: false }, peers: [], secrets: [] }, { token: '', ip: '127.0.0.1', local: true }) as SecretSettingsView).valueView, false);
});
