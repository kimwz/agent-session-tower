import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhLogin, ghAuthStatus, providerLogin } from '../../../server/link/readiness.js';
import type { ProviderHealth } from '../../../shared/types.js';

const health = (fields: Partial<ProviderHealth>): ProviderHealth => ({ provider: 'claude', available: true, sessionCount: 0, ...fields });

test('a provider counts as signed in from what Tower already reads of it, and missing when it is not there or says so', () => {
  assert.equal(providerLogin(undefined), 'missing');
  assert.equal(providerLogin(health({ available: false })), 'missing');
  assert.equal(providerLogin(health({ usage: { status: 'unavailable', windows: [], reason: 'not_signed_in' } })), 'missing');
  assert.equal(providerLogin(health({ account: { email: 'ka***@example.com' } })), 'ok');
  assert.equal(providerLogin(health({ usage: { status: 'available', windows: [] } })), 'ok');
  assert.equal(providerLogin(health({ usage: { status: 'error', windows: [], reason: 'rate_limited' } })), 'unknown');
  assert.equal(providerLogin(health({ usage: { status: 'loading', windows: [] } })), 'unknown');
});

test('gh counts by `gh auth status`\'s exit code alone, and is asked again only after a few minutes', async t => {
  const bin = await mkdtemp(join(tmpdir(), 'tower-gh-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const fake = async (code: number) => {
    await writeFile(join(bin, 'gh'), `#!/bin/sh\n[ "$1 $2" = "auth status" ] || exit 9\necho "Token: gho_secret"\nexit ${code}\n`);
    await chmod(join(bin, 'gh'), 0o755);
  };
  const env = { ...process.env, PATH: bin };
  await fake(0);
  assert.equal(await ghAuthStatus(env), 'ok');
  await fake(1);
  assert.equal(await ghAuthStatus(env), 'missing');
  await fake(4);
  assert.equal(await ghAuthStatus(env), 'unknown');

  let clock = 0, checks = 0;
  const login = new GhLogin({ now: () => clock, check: async () => { checks++; return 'ok'; } });
  assert.equal(await login.state(), 'ok');
  clock += 60_000;
  await login.state();
  assert.equal(checks, 1);
  clock += 5 * 60_000;
  await login.state();
  assert.equal(checks, 2);
  const failing = new GhLogin({ check: async () => { throw new Error('spawn failed'); } });
  assert.equal(await failing.state(), 'unknown');
});
