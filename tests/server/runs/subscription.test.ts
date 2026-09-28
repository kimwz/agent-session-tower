import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams, execFile } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import { checkClaudeSubscription, checkCodexAccount, markMaster, subscriptionOnly, withoutMasterFolder, SubscriptionError, withoutKeys } from '../../../server/runs/subscription.js';
import type { Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

const nativeId = '10000000-0000-4000-8000-000000000009';
const status = (value: unknown) => ((_file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => { done(null, JSON.stringify(value)); }) as unknown as typeof execFile;

test('only a claude.ai sign-in with Anthropic\'s own service passes; anything else is refused before a turn', async () => {
  await checkClaudeSubscription('/x/claude', '/tmp', {}, status({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }));
  for (const value of [{ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }, { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }, { loggedIn: false }, 'not json']) {
    await assert.rejects(checkClaudeSubscription('/x/claude', '/tmp', {}, status(value)), SubscriptionError);
  }
  const failing = ((_file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => { done(new Error('no claude'), ''); }) as unknown as typeof execFile;
  await assert.rejects(checkClaudeSubscription('/x/claude', '/tmp', {}, failing), SubscriptionError);
  checkCodexAccount({ account: { type: 'chatgpt', email: null, planType: 'pro' } });
  for (const value of [{ account: { type: 'apiKey' } }, { account: null }, { account: { type: 'amazonBedrock' } }, undefined]) assert.throws(() => checkCodexAccount(value), SubscriptionError);
  assert.deepEqual(withoutKeys({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', OPENAI_API_KEY: 'o', CODEX_API_KEY: 'c', CLAUDE_CODE_USE_BEDROCK: '1', HOME: '/h' }), { PATH: '/bin', HOME: '/h' });
  assert.equal(subscriptionOnly('/state', '/state/master-session'), true);
  assert.equal(subscriptionOnly('/state', '/state/master-session/'), true);
  assert.equal(subscriptionOnly('/state', '/state/other'), false);
});

/** A Claude session in `folder`, run by a manager whose sign-in check and processes are fakes. */
async function fixture(t: TestContext, folder: (stateDir: string) => string, signedIn: boolean) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-subscription-'));
  const cwd = folder(stateDir);
  await mkdir(cwd, { recursive: true });
  const session: Session = { id: `claude:${nativeId}`, nativeId, provider: 'claude', title: 'Fixture', cwd, project: 'fixture', status: 'completed', statusReason: 'Done',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const checked: NodeJS.ProcessEnv[] = [];
  const spawned: NodeJS.ProcessEnv[] = [];
  const manager = new RunManager({ stateDir, getSession: id => id === session.id ? session : undefined, refreshSessions: async () => {}, findExecutable: async () => '/fixture/claude', pollMs: 10,
    env: { ANTHROPIC_API_KEY: 'sk-ant-should-not-reach', OPENAI_API_KEY: 'sk-should-not-reach' },
    checkClaudeSubscription: async (_executable, _cwd, env) => { checked.push(env); if (!signedIn) throw new SubscriptionError('마스터는 Claude 구독 로그인(claude.ai)으로만 대화합니다.'); },
    spawnProcess: (_file, _args, options) => {
      spawned.push(options.env ?? {});
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      const exit = () => { if (child.exitCode !== null) return; Object.assign(child, { exitCode: 0 }); child.emit('close', 0, null); };
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: () => { exit(); return true; },
        stdin: new Writable({ write(_chunk, _encoding, done) { setImmediate(() => { child.stdout.push(JSON.stringify({ type: 'result', session_id: nativeId, is_error: false }) + '\n'); child.stdout.push(null); exit(); }); done(); } }) });
      return child;
    } });
  await manager.start();
  // One cleanup, in order: the manager saves before its folder goes.
  t.after(async () => { await manager.close(); await rm(stateDir, { recursive: true, force: true }); });
  const run = await manager.enqueue(session.id, 'hello', {}, { origin: { kind: 'owner' } });
  await until(() => ['completed', 'error'].includes(manager.list().find(item => item.id === run.id)?.status ?? '') || undefined);
  return { run: manager.list().find(item => item.id === run.id)!, checked, spawned };
}

test('a turn of the master runs only after its Claude sign-in is confirmed, without any key in its environment', async t => {
  const master = await fixture(t, stateDir => join(stateDir, 'master-session'), true);
  assert.equal(master.checked.length, 1);
  assert.equal(master.spawned.length, 1);
  for (const env of [...master.checked, ...master.spawned]) {
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
  }
  const refused = await fixture(t, stateDir => join(stateDir, 'master-session'), false);
  assert.equal(refused.run.status, 'error');
  assert.match(String(refused.run.error), /구독 로그인/);
  assert.equal(refused.spawned.length, 0, 'nothing is started for a keyed sign-in');
  const ordinary = await fixture(t, stateDir => join(stateDir, 'project'), false);
  assert.equal(ordinary.checked.length, 0, 'other sessions are not checked');
  assert.equal(ordinary.spawned[0]?.ANTHROPIC_API_KEY, 'sk-ant-should-not-reach', 'nor is their environment changed');
});

test('the master\'s folder is recognised through a linked state directory too', async t => {
  const base = await mkdtemp(join(tmpdir(), 'tower-subscription-link-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = join(base, 'real');
  await mkdir(join(real, 'master-session'), { recursive: true });
  await symlink(real, join(base, 'linked'));
  assert.equal(subscriptionOnly(join(base, 'linked'), join(real, 'master-session')), true);
  assert.equal(subscriptionOnly(real, join(base, 'linked', 'master-session')), true);
  assert.equal(subscriptionOnly(join(base, 'linked'), join(real, 'elsewhere')), false);
  // The master's folder itself a link to somewhere else: the session's folder is recorded where it leads.
  const away = join(base, 'away');
  await mkdir(away);
  await mkdir(join(base, 'state2'));
  await symlink(away, join(base, 'state2', 'master-session'));
  assert.equal(subscriptionOnly(join(base, 'state2'), away), true);
  assert.equal(subscriptionOnly(join(base, 'state2'), join(base, 'state2', 'master-session')), true);
});

test('sessions in the master\'s folder, below it, or reached through a linked state folder are marked; others are not', async t => {
  // A CLI records the folder it runs in with links followed (the temporary folder itself is one on macOS).
  const base = await realpath(await mkdtemp(join(tmpdir(), 'tower-mark-master-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = join(base, 'real');
  await mkdir(join(real, 'master-session'), { recursive: true });
  await symlink(real, join(base, 'linked'));
  const at = (cwd: string) => ({ id: cwd, cwd } as Session);
  const marked = markMaster([at(join(real, 'master-session')), at(join(real, 'master-session', 'sub')), at(join(real, 'master-session-2')), at(join(real, 'other')), at('')], join(base, 'linked'));
  assert.deepEqual(marked.map(session => Boolean(session.master)), [true, true, false, false, false]);
  assert.deepEqual(markMaster([at('/state/master-session/')], '/state').map(session => session.master), [true]);
  // A folder setting for it (such as hiding it by hand) is not shown as a project either.
  assert.deepEqual(withoutMasterFolder([{ cwd: '/state/master-session', hidden: true }, { cwd: '/work', pinned: true }], '/state'), [{ cwd: '/work', pinned: true }]);
});
