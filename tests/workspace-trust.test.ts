import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunManager } from '../server/runner.js';
import { trustWorkspace } from '../server/workspace-trust.js';

async function homes(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-monitor-trust-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: join(directory, 'claude'), CODEX_HOME: join(directory, 'codex') };
  await mkdir(env.CLAUDE_CONFIG_DIR); await mkdir(env.CODEX_HOME);
  return { directory, env, claude: join(env.CLAUDE_CONFIG_DIR, '.claude.json'), codex: join(env.CODEX_HOME, 'config.toml') };
}

test('Claude trust is merged into the existing config without touching other settings', async t => {
  const f = await homes(t);
  await writeFile(f.claude, JSON.stringify({ theme: 'dark', projects: { '/other': { allowedTools: ['x'] }, [f.directory]: { lastCost: 1, hasTrustDialogAccepted: false } } }), { mode: 0o600 });
  await trustWorkspace('claude', f.directory, f.env);
  const config = JSON.parse(await readFile(f.claude, 'utf8'));
  assert.deepEqual(config, { theme: 'dark', projects: { '/other': { allowedTools: ['x'] }, [f.directory]: { lastCost: 1, hasTrustDialogAccepted: true } } });
  assert.equal((await stat(f.claude)).mode & 0o777, 0o600);
  const before = (await stat(f.claude)).mtimeMs;
  await trustWorkspace('claude', f.directory, f.env);
  assert.equal((await stat(f.claude)).mtimeMs, before);
});

test('a missing Claude config is created and a malformed one is never replaced', async t => {
  const f = await homes(t);
  await trustWorkspace('claude', f.directory, f.env);
  assert.equal(JSON.parse(await readFile(f.claude, 'utf8')).projects[f.directory].hasTrustDialogAccepted, true);
  await writeFile(f.claude, '{ broken');
  await trustWorkspace('claude', f.directory, f.env);
  assert.equal(await readFile(f.claude, 'utf8'), '{ broken');
});

test('Codex trust is appended once and an explicit user choice is kept', async t => {
  const f = await homes(t);
  const odd = join(f.directory, 'a "quoted" folder');
  await mkdir(odd);
  await writeFile(f.codex, 'model = "gpt"\n\n[projects."/other"]\ntrust_level = "untrusted"');
  await trustWorkspace('codex', odd, f.env);
  await trustWorkspace('codex', odd, f.env);
  await trustWorkspace('codex', '/other', f.env);
  assert.equal(await readFile(f.codex, 'utf8'),
    `model = "gpt"\n\n[projects."/other"]\ntrust_level = "untrusted"\n\n[projects.${JSON.stringify(odd)}]\ntrust_level = "trusted"\n`);
  await writeFile(f.codex, 'projects = { "/other" = { trust_level = "trusted" } }\n');
  await trustWorkspace('codex', odd, f.env);
  assert.equal(await readFile(f.codex, 'utf8'), 'projects = { "/other" = { trust_level = "trusted" } }\n');
});

test('creating a session makes a missing folder and trusts it before the provider starts', async t => {
  const f = await homes(t);
  const trusted: string[] = [];
  const manager = new RunManager({ stateDir: join(f.directory, 'state'), getSession: () => undefined, refreshSessions: async () => {}, maxConcurrent: 0,
    findExecutable: async provider => `/fixture/${provider}`, spawnProcess: () => { throw new Error('must not launch'); },
    trustWorkspace: async (provider, cwd) => { assert.ok((await stat(cwd)).isDirectory()); trusted.push(`${provider}:${cwd}`); throw new Error('trust is best effort'); } });
  await manager.start();
  const cwd = join(f.directory, 'new', 'nested project');
  const { session } = await manager.create({ provider: 'claude', cwd, prompt: 'hi' });
  assert.equal(session.cwd, cwd);
  assert.deepEqual(trusted, [`claude:${cwd}`]);
  await assert.rejects(manager.create({ provider: 'claude', cwd: join(f.directory, 'state', 'runs.json', 'child'), prompt: 'hi' }), { statusCode: 400 });
  await manager.close();
});
