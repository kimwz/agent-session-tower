import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccounts } from '../../../server/providers/claude-accounts/accounts.js';
import { ClaudeLogin } from '../../../server/providers/claude-accounts/login.js';
import { claudeStorage, readClaudeStore, writeClaudeOAuth, writeOAuthAccount, type Keychain } from '../../../server/providers/claude-accounts/storage.js';
import { until } from '../../helpers/until.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-13T00:00:00Z');

/** An in-memory keychain: one item per service, as `security` keeps them for one user. */
function fakeKeychain() {
  const items = new Map<string, string>();
  let locked = false;
  const keychain: Keychain = {
    read: async (_account, service) => { if (locked) throw new Error('security find-generic-password failed (exit 36)'); return items.get(service); },
    write: async (_account, service, data) => { items.set(service, data); },
    remove: async (_account, service) => { items.delete(service); },
  };
  return { items, keychain, lock: (value: boolean) => { locked = value; } };
}

const oauth = (name: string, expiresAt = NOW + 8 * HOUR) => ({ accessToken: `access-${name}`, refreshToken: `refresh-${name}`, expiresAt, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' });

/** Anthropic as the accounts see it: profiles by token, refreshes that rotate, and quota by token. */
function fakeAnthropic() {
  const profiles = new Map<string, { uuid: string; email: string; org: string }>();
  const rejected = new Set<string>();
  const refreshes: string[] = [];
  const usageReads: string[] = [];
  let generation = 0;
  const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const token = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace('Bearer ', '');
    if (url.endsWith('/v1/oauth/token')) {
      const body = JSON.parse(String(init?.body));
      refreshes.push(body.refresh_token);
      if (rejected.has(body.refresh_token)) return new Response('{"error":"invalid_grant"}', { status: 400 });
      const name = String(body.refresh_token).replace(/^refresh-/, '').replace(/~\d+$/, '');
      const next = `${name}~${++generation}`;
      const owner = profiles.get(`access-${name}`) ?? [...profiles.entries()].find(([key]) => key.startsWith(`access-${name}~`))?.[1];
      if (owner) profiles.set(`access-${next}`, owner);
      return Response.json({ access_token: `access-${next}`, refresh_token: `refresh-${next}`, expires_in: 28_800, scope: body.scope });
    }
    if (url.endsWith('/api/oauth/profile')) {
      const profile = profiles.get(token);
      if (!profile) return new Response('{}', { status: 401 });
      return Response.json({ account: { uuid: profile.uuid, email: profile.email }, organization: { uuid: profile.org, name: `${profile.org} org` } });
    }
    if (url.endsWith('/api/oauth/usage')) {
      usageReads.push(token);
      // The usage reader judges resets by the real clock (an elapsed reset marks the reading stale), not the accounts' NOW.
      return Response.json({ five_hour: { utilization: 42, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() }, seven_day: { utilization: 7, resets_at: new Date(Date.now() + 72 * HOUR).toISOString() } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, profiles, rejected, refreshes, usageReads };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'claude-accounts-'));
  // One cleanup: everything that may still write in the folder stops before the folder goes.
  const stops: Array<() => Promise<void>> = [];
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, 'home');
  const defaultDir = join(root, 'default-claude');
  await mkdir(home, { recursive: true });
  await mkdir(defaultDir, { recursive: true });
  // A configured store directory keeps every test away from this computer's own Claude sign-in.
  const env = { USER: 'tester', CLAUDE_CONFIG_DIR: defaultDir };
  const { items, keychain, lock } = fakeKeychain();
  const anthropic = fakeAnthropic();
  let changes = 0;
  const meter: number[] = [];
  const accounts = new ClaudeAccounts({ stateDir: join(root, 'state'), env, platform: 'darwin', keychain, fetch: anthropic.fetch, now: () => NOW, home,
    onChange: () => { changes++; }, refreshMeter: () => { meter.push(1); } });
  stops.push(() => accounts.stop());
  const store = { env, platform: 'darwin', keychain };
  const signIn = async (name: string, uuid: string, email: string, expiresAt?: number) => {
    anthropic.profiles.set(`access-${name}`, { uuid, email, org: `org-${uuid}` });
    await writeClaudeOAuth(oauth(name, expiresAt), store);
    await writeOAuthAccount({ accountUuid: uuid, emailAddress: email, organizationUuid: `org-${uuid}`, organizationName: 'Full profile' }, env);
  };
  const active = async () => {
    const reading = await readClaudeStore(store);
    return reading.kind === 'stored' ? (reading.blob.claudeAiOauth as { refreshToken: string }).refreshToken : undefined;
  };
  const observe = async () => {
    const reading = await readClaudeStore(store);
    const record = reading.kind === 'stored' ? reading.blob.claudeAiOauth as Record<string, unknown> : undefined;
    const { credentialOf } = await import('../../../server/providers/capabilities.js');
    accounts.observe(credentialOf(record, NOW), { status: 'available', windows: [{ id: 'five_hour', usedPercent: 90, windowMinutes: 300 }], updatedAt: new Date(NOW).toISOString() });
  };
  return { root, stops, home, env, items, keychain, lock, anthropic, accounts, store, signIn, active, observe, meter, changes: () => changes };
}

test('only the claudeAiOauth record is replaced; other sign-ins in the store and the file fallback stay', async t => {
  const { env, items, keychain, root } = await fixture(t);
  const service = claudeStorage(env).service;
  items.set(service, JSON.stringify({ claudeAiOauth: oauth('old'), mcpOAuth: { server: { token: 'kept' } } }));
  // An existing plaintext copy (what an SSH login leaves) follows the keychain, so a locked keychain falls back to the same account.
  await writeFile(join(root, 'default-claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth('stale'), other: 1 }));
  await writeClaudeOAuth(oauth('new'), { env, platform: 'darwin', keychain });
  const blob = JSON.parse(items.get(service)!);
  assert.equal(blob.claudeAiOauth.refreshToken, 'refresh-new');
  assert.deepEqual(blob.mcpOAuth, { server: { token: 'kept' } });
  const file = JSON.parse(await readFile(join(root, 'default-claude', '.credentials.json'), 'utf8'));
  assert.equal(file.claudeAiOauth.refreshToken, 'refresh-new');
  assert.equal(file.other, 1);
});

test('no plaintext copy is made where none existed, and an unreadable keychain item is never overwritten', async t => {
  const { env, items, keychain, root } = await fixture(t);
  await writeClaudeOAuth(oauth('a'), { env, platform: 'darwin', keychain });
  await assert.rejects(readFile(join(root, 'default-claude', '.credentials.json')), { code: 'ENOENT' });
  items.set(claudeStorage(env).service, 'not json');
  await assert.rejects(writeClaudeOAuth(oauth('b'), { env, platform: 'darwin', keychain }));
  assert.equal(items.get(claudeStorage(env).service), 'not json');
});

test('a sign-in kept only in the file moves into a new keychain item whole, and a keychain Tower cannot read is never written', async t => {
  const { env, items, keychain, root, lock } = await fixture(t);
  const service = claudeStorage(env).service;
  const file = join(root, 'default-claude', '.credentials.json');
  await writeFile(file, JSON.stringify({ claudeAiOauth: oauth('old'), mcpOAuth: { server: { token: 'kept' } } }));
  await writeClaudeOAuth(oauth('new'), { env, platform: 'darwin', keychain });
  const blob = JSON.parse(items.get(service)!);
  assert.equal(blob.claudeAiOauth.refreshToken, 'refresh-new');
  assert.deepEqual(blob.mcpOAuth, { server: { token: 'kept' } }, 'the keychain now read first still holds the MCP sign-ins');
  lock(true);
  await assert.rejects(writeClaudeOAuth(oauth('other'), { env, platform: 'darwin', keychain }));
  lock(false);
  assert.equal(JSON.parse(items.get(service)!).claudeAiOauth.refreshToken, 'refresh-new');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).claudeAiOauth.refreshToken, 'refresh-new');
});

test('a sign-in Tower sees for the first time is saved automatically, with its full profile', async t => {
  const f = await fixture(t);
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com');
  await f.observe();
  const account = await until(() => f.accounts.list().length === 1 && f.accounts.list().find(item => item.usage));
  assert.equal(account.email, 'alpha@example.com');
  assert.equal(account.active, true);
  assert.equal(account.plan, 'max');
  assert.equal(account.usage?.windows[0].usedPercent, 90);
  const saved = await readClaudeStore({ env: f.accounts.accountEnv(account.id), platform: 'darwin', keychain: f.keychain });
  assert.equal(saved.kind === 'stored' && (saved.blob.claudeAiOauth as { refreshToken: string }).refreshToken, 'refresh-alpha');
  const profile = JSON.parse(await readFile(join(f.accounts.accountDirectory(account.id), '.claude.json'), 'utf8'));
  assert.equal(profile.oauthAccount.organizationName, 'Full profile');
});

test('switching saves the account in use first, then signs Claude Code in with the other one', async t => {
  const f = await fixture(t);
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com');
  await f.observe();
  await until(() => f.accounts.list().length === 1);
  // A terminal `/login` to another account: it is saved too.
  await f.signIn('beta', 'u-beta', 'beta@example.com');
  await f.observe();
  await until(() => f.accounts.list().length === 2 && f.accounts.list().find(item => item.email === 'beta@example.com')?.active);
  // Claude Code renewed beta's token meanwhile; the switch must keep that newest token, not the first copy.
  await writeClaudeOAuth({ ...oauth('beta'), accessToken: 'access-beta-renewed', refreshToken: 'refresh-beta-renewed' }, f.store);
  f.anthropic.profiles.set('access-beta-renewed', { uuid: 'u-beta', email: 'beta@example.com', org: 'org-u-beta' });
  const alpha = f.accounts.list().find(item => item.email === 'alpha@example.com')!;
  const beta = f.accounts.list().find(item => item.email === 'beta@example.com')!;
  const after = await f.accounts.switchTo(alpha.id);
  assert.equal(await f.active(), 'refresh-alpha');
  assert.deepEqual(after.map(item => [item.email, item.active]), [['alpha@example.com', true], ['beta@example.com', false]]);
  const betaStore = await readClaudeStore({ env: f.accounts.accountEnv(beta.id), platform: 'darwin', keychain: f.keychain });
  assert.equal(betaStore.kind === 'stored' && (betaStore.blob.claudeAiOauth as { refreshToken: string }).refreshToken, 'refresh-beta-renewed');
  const config = JSON.parse(await readFile(join(f.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8'));
  assert.equal(config.oauthAccount.emailAddress, 'alpha@example.com');
  assert.equal(f.meter.length, 1);
});

test('an inactive account is renewed by Tower, and the rotated token is kept before its usage is read', async t => {
  const f = await fixture(t);
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com', NOW + 60_000);
  await f.observe();
  await until(() => f.accounts.list().length === 1);
  // Beta, the account in use, is about to expire too: its token is Claude Code's, so Tower must not renew it.
  await f.signIn('beta', 'u-beta', 'beta@example.com', NOW + 60_000);
  await f.observe();
  await until(() => f.accounts.list().find(item => item.email === 'beta@example.com')?.active);
  await f.accounts.poll();
  // Only alpha (inactive, about to expire) was renewed.
  assert.deepEqual(f.anthropic.refreshes, ['refresh-alpha']);
  const alpha = f.accounts.list().find(item => item.email === 'alpha@example.com')!;
  const store = await readClaudeStore({ env: f.accounts.accountEnv(alpha.id), platform: 'darwin', keychain: f.keychain });
  assert.match(store.kind === 'stored' ? (store.blob.claudeAiOauth as { refreshToken: string }).refreshToken : '', /^refresh-alpha~\d+$/);
  assert.equal(alpha.usage?.windows.find(window => window.id === 'five_hour')?.usedPercent, 42);
  assert.ok(f.anthropic.usageReads.every(token => token.startsWith('access-alpha~')));
});

test('a refused saved sign-in asks for a new sign-in and is not switched to', async t => {
  const f = await fixture(t);
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com', NOW - 1);
  // Expired alpha cannot be identified yet; renew it as Claude Code would.
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com');
  await f.observe();
  await until(() => f.accounts.list().length === 1);
  await f.signIn('beta', 'u-beta', 'beta@example.com');
  await f.observe();
  await until(() => f.accounts.list().find(item => item.email === 'beta@example.com')?.active);
  const alpha = f.accounts.list().find(item => item.email === 'alpha@example.com')!;
  await writeClaudeOAuth(oauth('alpha', NOW - 1), { env: f.accounts.accountEnv(alpha.id), platform: 'darwin', keychain: f.keychain });
  f.anthropic.rejected.add('refresh-alpha');
  await assert.rejects(f.accounts.switchTo(alpha.id), /다시 로그인/);
  assert.equal(await f.active(), 'refresh-beta');
  assert.equal(f.accounts.list().find(item => item.id === alpha.id)?.problem, 'sign_in_again');
});

test('the account in use cannot be removed; another one is removed with its store', async t => {
  const f = await fixture(t);
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com');
  await f.observe();
  await until(() => f.accounts.list().length === 1);
  await f.signIn('beta', 'u-beta', 'beta@example.com');
  await f.observe();
  await until(() => f.accounts.list().find(item => item.email === 'beta@example.com')?.active);
  const [alpha, beta] = f.accounts.list();
  await assert.rejects(f.accounts.remove(beta.id), /지금 쓰고 있는 계정/);
  const service = claudeStorage(f.accounts.accountEnv(alpha.id)).service;
  assert.ok(f.items.has(service));
  await f.accounts.remove(alpha.id);
  assert.equal(f.items.has(service), false);
  assert.deepEqual(f.accounts.list().map(item => item.email), ['beta@example.com']);
  assert.deepEqual((await readdir(f.accounts.directory)).sort(), ['accounts.json', beta.id].sort());
});

test('adding an account runs claude auth login in its own folder, hands it the code, and saves the account without touching the one in use', async t => {
  const f = await fixture(t);
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com');
  await f.observe();
  await until(() => f.accounts.list().length === 1);
  f.anthropic.profiles.set('access-gamma', { uuid: 'u-gamma', email: 'gamma@example.com', org: 'org-u-gamma' });
  // A stand-in for `claude auth login`: prints the sign-in address, reads the code, and writes its own folder's store.
  // A parent CLAUDE_SECURESTORAGE_CONFIG_DIR must not reach it, or it would sign the default store in.
  const bin = join(f.root, 'fake-claude');
  await writeFile(bin, `#!/bin/sh
[ -n "$CLAUDE_SECURESTORAGE_CONFIG_DIR" ] && { echo "Login failed: secure storage leaked" >&2; exit 1; }
[ "$BROWSER" = /usr/bin/true ] || { echo "Login failed: a browser would open" >&2; exit 1; }
printf 'Opening browser to sign in…\\nIf the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\nPaste code here if prompted > '
read code
[ "$code" = "good-code#abc" ] || { echo "Login failed: That code wasn't accepted." >&2; exit 1; }
printf '{"claudeAiOauth":{"accessToken":"access-gamma","refreshToken":"refresh-gamma","expiresAt":${NOW + 8 * HOUR},"scopes":["user:profile"],"subscriptionType":"pro"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
printf '{"oauthAccount":{"accountUuid":"u-gamma","emailAddress":"gamma@example.com","organizationUuid":"org-u-gamma"}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
`);
  await chmod(bin, 0o755);
  const login = new ClaudeLogin({ directory: f.accounts.directory, executable: async () => bin, adopt: directory => f.accounts.adopt(directory), onChange: () => {},
    env: { ...f.env, PATH: process.env.PATH, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/must/not/leak' }, platform: 'darwin', keychain: f.keychain });
  f.stops.push(() => login.stop());
  await login.start();
  const waiting = await until(() => login.status()?.state === 'waiting_code' && login.status());
  assert.equal(waiting.url, 'https://claude.com/cai/oauth/authorize?code=true&state=abc');
  assert.throws(() => login.submitCode('two\nlines'), /코드 형식/);
  login.submitCode('good-code#abc');
  const done = await until(() => ['done', 'failed'].includes(login.status()?.state ?? '') && login.status());
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.account?.email, 'gamma@example.com');
  assert.equal(await f.active(), 'refresh-alpha');
  assert.deepEqual(f.accounts.list().map(item => [item.email, item.active]), [['alpha@example.com', true], ['gamma@example.com', false]]);
  // The login's own folder is gone; the account lives in its saved folder.
  assert.equal((await readdir(f.accounts.directory)).some(name => name.startsWith('login-')), false);
});

test('a refused code fails the sign-in with Claude Code’s reason and leaves nothing behind', async t => {
  const f = await fixture(t);
  const bin = join(f.root, 'fake-claude');
  await writeFile(bin, `#!/bin/sh
printf 'visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\nPaste code here if prompted > '
read code
echo "Login failed: That code wasn't accepted." >&2
exit 1
`);
  await chmod(bin, 0o755);
  await mkdir(f.accounts.directory, { recursive: true });
  const login = new ClaudeLogin({ directory: f.accounts.directory, executable: async () => bin, adopt: directory => f.accounts.adopt(directory), onChange: () => {}, env: { ...f.env, PATH: process.env.PATH }, platform: 'darwin', keychain: f.keychain });
  f.stops.push(() => login.stop());
  await login.start();
  await until(() => login.status()?.state === 'waiting_code');
  login.submitCode('bad');
  const failed = await until(() => login.status()?.state === 'failed' && login.status());
  assert.equal(failed.error, "That code wasn't accepted.");
  await until(async () => !(await readdir(f.accounts.directory)).some(name => name.startsWith('login-')));
  assert.deepEqual(f.accounts.list(), []);
});

test('a sign-in Tower cannot identify is never switched away from, and nothing is renewed while it is in use', async t => {
  const f = await fixture(t);
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com', NOW + 60_000);
  await f.observe();
  await until(() => f.accounts.list().length === 1);
  // A `/login` to an account whose profile cannot be read (the profile service refuses it).
  await writeClaudeOAuth(oauth('mystery'), f.store);
  const alpha = f.accounts.list()[0];
  await assert.rejects(f.accounts.switchTo(alpha.id), /확인하지 못해/);
  assert.equal(await f.active(), 'refresh-mystery', 'the unidentified sign-in stays');
  await f.accounts.poll();
  assert.deepEqual(f.anthropic.refreshes, [], 'with the account in use unknown, no saved copy is renewed');
  await assert.rejects(f.accounts.remove(alpha.id), /확인하지 못해/);
});

test('an account a terminal /login just made the one in use cannot be removed before the next meter reading', async t => {
  const f = await fixture(t);
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com');
  await f.observe();
  await until(() => f.accounts.list().length === 1);
  await f.signIn('beta', 'u-beta', 'beta@example.com');
  await f.observe();
  await until(() => f.accounts.list().find(item => item.email === 'beta@example.com')?.active);
  const alpha = f.accounts.list().find(item => item.email === 'alpha@example.com')!;
  // Back to alpha in a terminal; Tower has not read the meter since.
  const stored = await readClaudeStore({ env: f.accounts.accountEnv(alpha.id), platform: 'darwin', keychain: f.keychain });
  await writeClaudeOAuth(stored.kind === 'stored' ? stored.blob.claudeAiOauth as Record<string, unknown> : {}, f.store);
  await assert.rejects(f.accounts.remove(alpha.id), /지금 쓰고 있는 계정/);
});

test('a refused saved sign-in shows its last usage as an earlier reading', async t => {
  const f = await fixture(t);
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com', NOW + 60_000);
  await f.observe();
  await until(() => f.accounts.list().find(item => item.usage));
  await f.signIn('beta', 'u-beta', 'beta@example.com');
  await f.observe();
  await until(() => f.accounts.list().find(item => item.email === 'beta@example.com')?.active);
  f.anthropic.rejected.add('refresh-alpha');
  await f.accounts.poll();
  const alpha = f.accounts.list().find(item => item.email === 'alpha@example.com')!;
  assert.equal(alpha.problem, 'sign_in_again');
  assert.equal(alpha.stale, true);
  assert.equal(alpha.reason, 'not_signed_in');
  assert.equal(alpha.usage?.windows[0].usedPercent, 90);
});

test('after a sign-in Tower could not identify, going back to a saved account shows it in use again', async t => {
  const f = await fixture(t);
  await f.signIn('alpha', 'u-alpha', 'alpha@example.com');
  await f.observe();
  await until(() => f.accounts.list()[0]?.active);
  const alpha = f.accounts.list()[0];
  const saved = await readClaudeStore({ env: f.accounts.accountEnv(alpha.id), platform: 'darwin', keychain: f.keychain });
  // A `/login` to an account whose profile cannot be read, then back to alpha.
  await writeClaudeOAuth(oauth('mystery'), f.store);
  await f.observe();
  await until(() => !f.accounts.list()[0].active);
  await writeClaudeOAuth(saved.kind === 'stored' ? saved.blob.claudeAiOauth as Record<string, unknown> : {}, f.store);
  await f.observe();
  await until(() => f.accounts.list()[0].active);
});
