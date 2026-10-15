import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../../../server/auth/store.js';
import { createMonitorServer, type Backend } from '../../../server/http/server.js';
import { ownerSecretControl } from '../../../server/link/secret-routes.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity.js';
import type { SecretSessionView, SecretSettingsView, SecretValue } from '../../../shared/secrets.js';
import type { Snapshot } from '../../../shared/types.js';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { FixtureRuns, vaultTemplate } from '../../helpers/secrets.js';
import { fastVaultKdf } from '../../helpers/fast-kdf.js';
import { fastScrypt } from '../../helpers/fast-scrypt.js';

fastVaultKdf();
fastScrypt();

/** The value routes over HTTP, from a remote HTTPS page and a loopback page, in front of a real secret runtime on a fixture vault. */
const RECOVERY = 'fixture-value-http-recovery';
const TOWER = 'fixture-password-123';
const CANARY = 'VALUE_VIEW_HTTP_CANARY_481';
/** A file an atomic write renamed away while the state was scanned. */
const gone = (error: NodeJS.ErrnoException): string => { if (error.code === 'ENOENT') return ''; throw error; };
const vaults = vaultTemplate(RECOVERY);
before(() => vaults.ready());
after(() => vaults.dispose());
const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: '' };
interface Answer { status: number; headers: IncomingHttpHeaders; body: Record<string, unknown> }

async function fixture(t: TestContext, account: 'configured' | 'unconfigured' | 'none' = 'configured') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-value-view-http-')));
  const stateDir = join(root, 'state'), project = join(root, 'project'); await mkdir(stateDir); await mkdir(project);
  const service = await vaults.open(stateDir); const runs = new FixtureRuns(); runs.session('codex:value-session', project);
  const runtime = new SecretRuntime({ stateDir, service, runs });
  let auth: AuthStore | undefined; let cookie = '';
  if (account === 'configured') ({ auth, cookie } = await createRemoteAuthFixture(root));
  else if (account === 'unconfigured') { auth = new AuthStore(join(root, 'auth')); await auth.start(); }
  const actions: string[] = []; let valueView = true; const masterSecret = 'd'.repeat(64);
  // The web's owner control in front of this worker, as server/index.ts wires it.
  const worker = { supports: (capability: string) => capability !== 'secretValueView' || valueView, secretCall: async (operation: string, args: unknown[] = []) => {
    if (operation === 'peers') return runtime.peers(); if (operation === 'device') return runtime.device();
    actions.push(String(args[0])); return runtime.control(String(args[0]), args[1] as Record<string, unknown>, args[2]);
  } };
  const backend: Backend = { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('No native provider may run in this fixture'); }, cancel: async () => {}, subscribe: () => () => {},
    secrets: (action, input) => ownerSecretControl(undefined, worker, action, input) };
  const origins = new Set<string>();
  const monitor = createMonitorServer({ port: 0, clientDir: stateDir, ...(auth ? { auth } : {}), remote: { origins }, backend, master: { callerSecret: masterSecret, handle: async () => false } });
  await new Promise<void>((resolve, reject) => { monitor.server.once('error', reject); monitor.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    monitor.dispose(); monitor.server.closeAllConnections(); if (monitor.server.listening) await new Promise<void>(resolve => monitor.server.close(() => resolve()));
    runtime.close(); if (auth) { await auth.flush(); auth.close(); } await rm(root, { recursive: true, force: true });
  });
  const port = (monitor.server.address() as AddressInfo).port;
  const secure = `secure.test:${port}`; origins.add(`https://${secure}`);
  /** `remote`: a signed-in page through an HTTPS origin; otherwise this computer's own loopback page. */
  const call = (path: string, options: { body?: unknown; headers?: Record<string, string>; remote?: boolean; cookie?: string } = {}) => new Promise<Answer>((resolve, reject) => {
    const headers: Record<string, string> = { host: options.remote ? secure : `127.0.0.1:${port}`, ...(options.remote ? { origin: `https://${secure}`, 'x-forwarded-for': '192.0.2.1' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.body !== undefined ? { 'content-type': 'application/json', [REQUEST_TOKEN_HEADER]: monitor.token } : {}), ...options.headers };
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.body !== undefined ? 'POST' : 'GET', headers }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('error', reject);
      response.once('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text ? JSON.parse(text) : {} }); });
    });
    req.once('error', reject); req.end(options.body !== undefined ? JSON.stringify(options.body) : undefined);
  });
  const remote = (path: string, body?: unknown, signedIn = cookie) => call(path, { remote: true, cookie: signedIn, ...(body !== undefined ? { body } : {}) });
  return { root, stateDir, service, runtime, auth, cookie, actions, call, remote, masterSecret, workerValueView: (value: boolean) => { valueView = value; } };
}
const code = (answer: Answer) => [answer.status, answer.body.code];

test('a signed-in browser reads and edits values only after unlocking value viewing with the Tower password; nothing is cached', async t => {
  const f = await fixture(t);
  const secret = await f.service.create({ name: 'HTTP value', kind: 'scalar', value: CANARY });
  const settings = await f.remote('/api/secrets/settings');
  assert.equal(settings.status, 200); assert.equal(settings.body.valueView, false); assert.equal((settings.body as unknown as SecretSettingsView).status.towerPassword, undefined, 'only while locked');
  const read = (expectedVersion = 1, signedIn?: string) => f.remote('/api/secrets/value', { secretId: secret.id, expectedVersion }, signedIn);
  assert.deepEqual(code(await read()), [403, 'view-locked']);
  assert.deepEqual(code(await f.remote('/api/secrets/value-update', { secretId: secret.id, expectedVersion: 1, value: 'NO' })), [403, 'view-locked']);
  // A wrong Tower password counts toward the sign-in block like a failed login.
  const wrong = await f.remote('/api/secrets/view-unlock', { password: 'not-the-tower-password' });
  assert.deepEqual(code(wrong), [401, 'login-required']); assert.equal(f.auth!.overview().attempts[0]!.result, 'failure');
  assert.deepEqual(code(await f.remote('/api/secrets/view-unlock', { password: TOWER, generation: 'page-chosen' })), [400, undefined]);
  const unlocked = await f.remote('/api/secrets/view-unlock', { password: TOWER });
  assert.equal(unlocked.status, 200); assert.equal(unlocked.body.valueView, true);
  assert.equal(f.service.vault.hasTower(f.auth!.currentCredentialId()!), true, 'the first use wrapped the open vault for this login');
  const shown = await read();
  assert.equal(shown.status, 200); assert.deepEqual(shown.body, { id: secret.id, version: 1, kind: 'scalar', value: CANARY } satisfies SecretValue);
  assert.equal(shown.headers['cache-control'], 'no-store');
  assert.deepEqual(code(await read(2)), [409, 'conflict']);
  const edited = await f.remote('/api/secrets/value-update', { secretId: secret.id, expectedVersion: 1, value: `${CANARY}_EDITED` });
  assert.equal(edited.status, 200); assert.equal(edited.headers['cache-control'], 'no-store');
  assert.equal(edited.body.valueView, true); assert.equal((edited.body as unknown as SecretSettingsView).secrets[0]!.version, 2);
  assert.equal(JSON.stringify(edited.body).includes(CANARY), false, 'the settings answer carries no value');
  assert.deepEqual(code(await f.remote('/api/secrets/value-update', { secretId: secret.id, expectedVersion: 1, value: 'STALE' })), [409, 'conflict']);
  // Another browser of the owner's has its own value viewing.
  const { sessionId: other } = await f.auth!.login('127.0.0.1', 'monitor', TOWER); await f.auth!.flush();
  assert.deepEqual(code(await read(2, `tower_session=${other}`)), [403, 'view-locked']);
  // The page's own lock, then the vault's lock end it; the Tower password opens the locked vault again.
  assert.equal((await f.remote('/api/secrets/view-lock', {})).body.valueView, false);
  assert.deepEqual(code(await read(2)), [403, 'view-locked']);
  assert.equal((await f.remote('/api/secrets/view-unlock', { password: TOWER })).status, 200);
  const locked = await f.remote('/api/secrets/lock', {});
  assert.deepEqual([locked.status, (locked.body as unknown as SecretSettingsView).status.towerPassword, locked.body.valueView], [200, 'ready', false]);
  assert.deepEqual(code(await read(2)), [403, 'view-locked']);
  const view = await f.remote(`/api/secrets/session?sessionId=${encodeURIComponent('codex:value-session')}`);
  assert.equal((view.body as unknown as SecretSessionView).status.towerPassword, 'ready');
  const reopened = await f.remote('/api/secrets/view-unlock', { password: TOWER });
  assert.deepEqual([reopened.status, reopened.body.valueView, f.service.status().locked], [200, true, false]);
  assert.equal((await read(2)).body.value, `${CANARY}_EDITED`);
  // Reading values changes nothing: more than a minute's change budget (30) of reads all answer.
  for (let n = 0; n < 31; n++) assert.equal((await read(2)).status, 200);
  // Signed out: the cookie no longer reaches anything.
  assert.equal((await f.remote('/api/auth/logout', {})).status, 200);
  assert.deepEqual(code(await read(2)), [401, 'login-required']);
  // No password in any file of this Tower's state.
  const files = async (directory: string): Promise<string> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : readFile(join(directory, entry.name), 'utf8').catch(gone)))).join('');
  const stored = await files(f.root); assert.equal(stored.includes(TOWER), false); assert.equal(stored.includes(CANARY), false);
});

test('a loopback page signs in to unlock value viewing; an older worker and a vault without a wrapper are answered with their codes', async t => {
  const f = await fixture(t);
  const secret = await f.service.create({ name: 'local value', kind: 'scalar', value: CANARY });
  assert.equal((await f.call('/api/secrets/settings')).body.valueView, false);
  const read = (cookie?: string) => f.call('/api/secrets/value', { body: { secretId: secret.id, expectedVersion: 1 }, ...(cookie ? { cookie } : {}) });
  assert.deepEqual(code(await read()), [401, 'login-required']);
  assert.deepEqual(code(await f.call('/api/secrets/view-unlock', { body: { password: 'not-the-tower-password' } })), [401, 'login-required']);
  const unlocked = await f.call('/api/secrets/view-unlock', { body: { password: TOWER } });
  assert.equal(unlocked.status, 200); assert.equal(unlocked.body.valueView, true);
  const cookie = String(unlocked.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
  assert.match(cookie, /^tower_session=[A-Za-z0-9_-]{32,}$/);
  assert.deepEqual(code(await read()), [401, 'login-required'], 'loopback alone never reads a value');
  assert.equal((await read(cookie)).body.value, CANARY);
  assert.equal((await f.call('/api/secrets/settings', { cookie })).body.valueView, true);
  // An older worker is not asked; the page learns that the new one is pending.
  f.workerValueView(false); const asked = f.actions.length;
  assert.deepEqual(code(await f.call('/api/secrets/view-unlock', { body: { password: TOWER }, cookie })), [503, 'worker-update-pending']);
  assert.deepEqual(code(await read(cookie)), [503, 'worker-update-pending']);
  assert.deepEqual(f.actions.slice(asked), [], 'neither reached the worker');
  f.workerValueView(true);
  // A locked vault without a wrapper for this login (changed while locked, or made before this release) needs the recovery password once.
  await f.service.towerPrune('0'.repeat(64)); await f.service.lock();
  const lockedView = (await f.call('/api/secrets/settings', { cookie })).body as unknown as SecretSettingsView;
  assert.deepEqual([lockedView.status.towerPassword, lockedView.valueView], ['missing', false]);
  assert.deepEqual(code(await f.call('/api/secrets/view-unlock', { body: { password: TOWER }, cookie })), [409, 'needs-recovery']);
  const recovered = await f.call('/api/secrets/view-unlock', { body: { password: TOWER, recoveryPassword: RECOVERY }, cookie });
  assert.deepEqual([recovered.status, recovered.body.valueView], [200, true]);
  assert.equal((await read(cookie)).body.value, CANARY);
  // The vault password still unlocks the vault by itself, as the recovery path.
  await f.service.lock();
  assert.equal(((await f.call('/api/secrets/unlock', { body: { password: RECOVERY }, cookie })).body as unknown as SecretSettingsView).status.locked, false);
});

test('value viewing needs a Tower login account; the old update route is gone', async t => {
  for (const account of ['unconfigured', 'none'] as const) {
    const f = await fixture(t, account);
    const answer = await f.call('/api/secrets/view-unlock', { body: { password: TOWER } });
    assert.deepEqual(code(answer), [409, 'account-required']); assert.match(String(answer.body.error), /로컬 계정 관리/);
    assert.deepEqual(code(await f.call('/api/secrets/value', { body: { secretId: 'x', expectedVersion: 1 } })), [409, 'account-required']);
    assert.equal((await f.call('/api/secrets/settings')).body.valueView, false);
    assert.equal((await f.call('/api/secrets/update', { body: { id: 'x', value: 'NO' } })).status, 404);
  }
});

test('only the owner\'s own local page changes the login; the answer says what happened to the vault', async t => {
  const f = await fixture(t);
  await f.runtime.control('tower-wrap', { password: TOWER, credentialId: f.auth!.currentCredentialId() });
  const before = f.auth!.currentCredentialId()!; const body = { username: 'monitor', password: 'fixture-changed-password' };
  const callers: Record<string, string>[] = [{ 'x-tower-agent': 'local' }, { 'x-tower-master': f.masterSecret }, { 'x-tower-master': 'not-the-master' }, { [CALLER_CAPABILITY_HEADER]: 'e'.repeat(64) }];
  for (const caller of callers) {
    assert.equal((await f.call('/api/auth/credentials', { body, headers: caller })).status, 403, Object.keys(caller)[0]);
  }
  assert.equal((await f.remote('/api/auth/credentials', body)).status, 403, 'account management stays local');
  assert.equal(f.auth!.currentCredentialId(), before); assert.deepEqual(f.actions, [], 'the vault was not asked');
  const changed = await f.call('/api/auth/credentials', { body });
  assert.equal(changed.status, 200); assert.equal(changed.body.vault, 'rewrapped'); assert.equal(changed.body.username, 'monitor');
  const after = f.auth!.currentCredentialId()!; assert.notEqual(after, before);
  assert.deepEqual([f.service.vault.hasTower(before), f.service.vault.hasTower(after)], [false, true]);
  assert.equal(await f.service.towerUnlock('fixture-changed-password', after), false, 'the new password unwraps the open key');
  assert.equal((await f.remote('/api/secrets/settings')).status, 401, 'everyone was signed out');
});
