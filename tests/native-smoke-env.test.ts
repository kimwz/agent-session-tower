import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedSmokeEnv } from '../scripts/native-smoke-env.js';

for (const provider of ['codex', 'claude'] as const) test(`${provider} smoke tests require separate storage before provider startup`, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'tower-smoke-home-guard-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const selector = provider === 'codex' ? 'TOWER_SMOKE_CODEX_HOME' : 'TOWER_SMOKE_CLAUDE_HOME';
  const variable = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const otherVariable = provider === 'codex' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const normal = join(fixture, 'personal');
  const otherNormal = join(fixture, 'other-personal');
  const isolated = join(fixture, 'test-profile');
  const nested = join(normal, 'nested');
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(otherNormal), mkdir(isolated)]);
  const original = { [variable]: normal, [otherVariable]: otherNormal, UNRELATED_SETTING: 'unchanged' };
  await assert.rejects(isolatedSmokeEnv(provider, original), new RegExp(selector));
  const use = (path: string) => isolatedSmokeEnv(provider, { ...original, [selector]: path });
  await assert.rejects(use(normal), /must be separate/);
  await assert.rejects(use(otherNormal), /must be separate/);
  await assert.rejects(use(nested), /must be separate/);
  await assert.rejects(use(fixture), /must be separate/);
  const personalAlias = join(fixture, 'personal-alias');
  await symlink(normal, personalAlias);
  await assert.rejects(use(personalAlias), /must be separate/);
  for (const name of ['.codex', '.claude']) {
    const defaultHome = join(homedir(), name);
    if (await realpath(defaultHome).catch(() => undefined)) await assert.rejects(use(defaultHome), /must be separate/);
  }
  const result = await use(isolated);
  assert.equal(result[variable], await realpath(isolated));
  assert.equal(result.UNRELATED_SETTING, 'unchanged');
  assert.equal(original[variable], normal);

  // Top-level and deeper date/project symlinks must not escape into a personal profile.
  const storage = provider === 'codex' ? 'sessions' : 'projects';
  const target = join(normal, storage);
  await mkdir(target);
  await symlink(target, join(isolated, storage));
  await assert.rejects(use(isolated), /must not contain symbolic links/);
  await rm(join(isolated, storage));
  await mkdir(join(isolated, storage));
  await symlink(target, join(isolated, storage, 'nested-link'));
  await assert.rejects(use(isolated), /must not contain symbolic links/);
  await rm(join(isolated, storage, 'nested-link'));
  assert.equal((await use(isolated))[variable], await realpath(isolated));
});
