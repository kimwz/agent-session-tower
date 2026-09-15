import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunManager } from '../server/runner.js';
import { SessionTitleStore } from '../server/session-titles.js';
import type { Provider, Run, Session } from '../shared/types.js';

const CODEX_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_ID = '20000000-0000-4000-8000-000000000002';

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for created session.');
}

async function fixture(t: test.TestContext, mode = '', maxConcurrent = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-created-'));
  const stateDir = join(directory, 'state');
  const script = join(directory, 'provider.mjs');
  const native = new Map<string, Session>();
  const launches: string[][] = [];
  await writeFile(script, `
import {mkdirSync,rmSync,writeFileSync} from 'node:fs';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  writeFileSync(process.env.RECEIVED_PATH, JSON.stringify({args,prompt,cwd:process.cwd()}));
  const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
  const claude = args.includes('-p');
  const resume = args.includes('--resume') || args.includes('resume');
  const id = claude ? args[args.indexOf(resume ? '--resume' : '--session-id') + 1] : '${CODEX_ID}';
  const mode = process.env.FIXTURE_MODE;
  if (mode === 'break-registry') { rmSync(process.env.CREATED_PATH,{force:true}); mkdirSync(process.env.CREATED_PATH); }
  if (mode === 'fail') { process.stderr.write('authentication expired'); process.exitCode = 2; return; }
  if (mode === 'hold-before-id') { setInterval(() => {}, 1000); return; }
  const actual = mode === 'invalid-id' ? 'bad-id' : mode === 'mismatch' ? '${OTHER_ID}' : id;
  send(claude ? {type:'system',subtype:'init',session_id:actual} : {type:'thread.started',thread_id:actual});
  if (mode === 'double-id') send({type:'thread.started',thread_id:'${OTHER_ID}'});
  if (mode === 'hold') { setInterval(() => {}, 1000); return; }
  if (claude) send({type:'result',is_error:false,result:'Created Claude'});
  else { send({type:'item.completed',item:{type:'agent_message',text:'Created Codex'}}); send({type:'turn.completed'}); }
});
`);
  const manager = new RunManager({ stateDir, getSession: id => native.get(id), refreshSessions: async () => {}, pollMs: 25,
    maxConcurrent, findExecutable: async provider => `/fixture/${provider}`,
    env: { FIXTURE_MODE: mode, RECEIVED_PATH: join(directory, 'received.json'), CREATED_PATH: join(stateDir, 'created-sessions.json') },
    spawnProcess: (_file, args, options) => { launches.push(args); assert.equal(options.shell, false); return spawn(process.execPath, [script, ...args], options); },
  });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { manager, directory, stateDir, native, launches };
}

function finished(manager: RunManager, id: string): Promise<Run> {
  return until(() => manager.list().find(run => run.id === id && ['completed', 'error', 'cancelled'].includes(run.status)));
}

test('new-session model is persisted and passed as a native CLI override', async t => {
  const f = await fixture(t);
  for (const provider of ['claude', 'codex'] as const) {
    const accepted = await f.manager.create({ provider, cwd: f.directory, prompt: 'Create with selected model', model: 'native-model' });
    assert.equal(accepted.run.model, 'native-model');
    assert.equal((await finished(f.manager, accepted.run.id)).status, 'completed');
    const args = f.launches.at(-1)!;
    assert.equal(args[args.indexOf('--model') + 1], 'native-model');
  }
  const count = f.manager.list().length;
  await assert.rejects(f.manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Invalid override', model: '--settings' }), /Invalid model/);
  assert.equal(f.manager.list().length, count);
});

for (const provider of ['claude', 'codex'] as Provider[]) {
  test(`creates a real ${provider} CLI invocation, confirms identity, then resumes that exact conversation`, async t => {
    const f = await fixture(t);
    const prompt = 'Literal $(touch INJECTION) `touch SECOND`\nfirst prompt';
    const accepted = await f.manager.create({ provider, cwd: f.directory, prompt, title: 'My new task' });
    assert.equal(accepted.session.creationPending, true);
    assert.equal(accepted.session.resumable, false);
    assert.equal(accepted.session.nativeId, provider === 'codex' ? '' : accepted.session.id.slice('claude:'.length));
    const initial = await finished(f.manager, accepted.run.id);
    assert.equal(initial.status, 'completed', initial.error);
    const confirmed = f.manager.getSession(accepted.session.id)!;
    assert.equal(confirmed.creationPending, false);
    assert.equal(confirmed.resumable, true);
    if (provider === 'codex') assert.equal(confirmed.nativeId, CODEX_ID);
    assert.equal(confirmed.customTitle, 'My new task');
    assert.equal(confirmed.title, prompt.replace(/\s+/g, ' '));
    const received = JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8'));
    assert.equal(received.prompt, prompt);
    assert.ok(!received.args.includes(prompt));
    assert.ok(!received.args.includes('resume') && !received.args.includes('--resume'));
    assert.ok(!received.args.some((arg: string) => /bypass|dangerously|ephemeral|no-session-persistence/.test(arg)));
    await assert.rejects(stat(join(f.directory, 'INJECTION')), { code: 'ENOENT' });
    await assert.rejects(stat(join(f.directory, 'SECOND')), { code: 'ENOENT' });
    const second = await f.manager.enqueue(confirmed.id, 'continue exactly here');
    assert.equal((await finished(f.manager, second.id)).status, 'completed');
    assert.ok(f.launches[1]!.includes(confirmed.nativeId));
    assert.ok(f.launches[1]!.includes(provider === 'codex' ? 'resume' : '--resume'));
    assert.equal((await stat(join(f.stateDir, 'created-sessions.json'))).mode & 0o777, 0o600);
  });
}

test('native discovery merges under the stable ID and maps child parents; identities survive pruned initial history', async t => {
  const f = await fixture(t);
  const accepted = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'new conversation' });
  await finished(f.manager, accepted.run.id);
  const confirmed = f.manager.getSession(accepted.session.id)!;
  const nativeId = `codex:${CODEX_ID}`;
  const native = { ...confirmed, id: nativeId, title: 'Native title', creationPending: undefined, filePath: '/fixture/native.jsonl', messageCount: 2 };
  const child = { ...native, id: `codex:${OTHER_ID}`, nativeId: OTHER_ID, parentId: nativeId, isSubagent: true };
  f.native.set(native.id, native);
  f.native.set(child.id, child);
  const all = f.manager.sessionList([...f.native.values()]);
  assert.equal(all.length, 2);
  assert.equal(all.find(session => !session.isSubagent)?.id, accepted.session.id);
  assert.equal(all.find(session => session.isSubagent)?.parentId, accepted.session.id);
  assert.equal(f.manager.nativeSessionId(accepted.session.id), nativeId);
  assert.equal(f.manager.getSession(accepted.session.id)?.filePath, native.filePath);
  const nativeAliasRun = await f.manager.enqueue(nativeId, 'native alias also routes to the same monitor owner');
  assert.equal(nativeAliasRun.sessionId, accepted.session.id);
  await finished(f.manager, nativeAliasRun.id);
  await f.manager.close();
  await writeFile(join(f.stateDir, 'runs.json'), '[]'); // Simulate bounded run history aging out the initial turn.
  const restarted = new RunManager({ stateDir: f.stateDir, getSession: id => f.native.get(id), refreshSessions: async () => {}, findExecutable: async () => { throw new Error('Must not launch'); } });
  await restarted.start();
  try {
    assert.equal(restarted.getSession(accepted.session.id)?.nativeId, CODEX_ID);
    assert.equal(restarted.sessionList([...f.native.values()]).find(session => !session.isSubagent)?.id, accepted.session.id);
    f.native.delete(nativeId);
    assert.equal(restarted.getSession(accepted.session.id), undefined, 'removed native sessions do not become permanent placeholders');
  } finally { await restarted.close(); }
});

test('an optional creation name behaves as a custom title and can restore the native title across restart', async t => {
  const f = await fixture(t);
  const accepted = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'first prompt title', title: 'Chosen name' });
  await finished(f.manager, accepted.run.id);
  const native = { ...f.manager.getSession(accepted.session.id)!, id: `codex:${CODEX_ID}`, title: 'Native title', customTitle: undefined };
  f.native.set(native.id, native);
  const titles = new SessionTitleStore(f.stateDir);
  await titles.start();
  const created = f.manager.getSession(accepted.session.id)!;
  assert.equal(titles.apply(created).title, 'Native title');
  assert.equal(titles.apply(created).customTitle, 'Chosen name');
  await titles.set(created, 'Renamed');
  assert.equal(titles.apply(created).customTitle, 'Renamed');
  await titles.set(created, '');
  assert.equal(titles.apply(created).customTitle, undefined);
  await f.manager.close();
  const reloaded = new SessionTitleStore(f.stateDir);
  await reloaded.start();
  assert.equal(reloaded.apply(created).customTitle, undefined);
  assert.equal(reloaded.apply(created).title, 'Native title');
});

test('CLI authentication failure remains visible and cannot be resumed or automatically retried', async t => {
  const f = await fixture(t, 'fail');
  const accepted = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'create once' });
  assert.match((await finished(f.manager, accepted.run.id)).error!, /authentication expired/);
  const session = f.manager.getSession(accepted.session.id)!;
  assert.equal(session.status, 'error');
  assert.equal(session.resumable, false);
  assert.equal(session.creationPending, false);
  await assert.rejects(f.manager.enqueue(session.id, 'retry'), /cannot be resumed/);
  await f.manager.close();
  const restarted = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, spawnProcess: () => { throw new Error('Must never replay'); } });
  await restarted.start();
  try { assert.equal(restarted.getSession(session.id)?.status, 'error'); assert.equal(restarted.getSession(session.id)?.nativeId, ''); }
  finally { await restarted.close(); }
  assert.equal(f.launches.length, 1);
});

test('failure to persist the provider-confirmed UUID cannot report successful creation', async t => {
  const f = await fixture(t, 'break-registry');
  const accepted = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'create once' });
  const result = await finished(f.manager, accepted.run.id);
  assert.equal(result.status, 'error');
  assert.match(result.error!, /Cannot save the new conversation identity/);
  assert.equal(f.launches.length, 1);
  await rm(join(f.stateDir, 'created-sessions.json'), { recursive: true });
  await f.manager.close();
});

for (const [provider, mode] of [['codex', 'invalid-id'], ['codex', 'double-id'], ['claude', 'mismatch']] as const) {
  test(`creation stops on ${provider} ${mode} identity events`, async t => {
    const f = await fixture(t, mode);
    const accepted = await f.manager.create({ provider, cwd: f.directory, prompt: 'create once' });
    assert.equal((await finished(f.manager, accepted.run.id)).status, 'error');
    assert.equal(f.launches.length, 1);
    if (mode !== 'double-id') assert.equal(f.manager.getSession(accepted.session.id)?.resumable, false);
  });
}

test('new sessions share the queue limit, cancel safely before creation, and never replay at restart', async t => {
  const f = await fixture(t, 'hold-before-id', 1);
  const first = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'hold' });
  await until(() => f.manager.list().find(run => run.id === first.run.id && run.status === 'running'));
  const queued = await f.manager.create({ provider: 'claude', cwd: f.directory, prompt: 'queued' });
  await f.manager.cancel(queued.run.id);
  assert.equal(f.manager.getSession(queued.session.id)?.resumable, false);
  assert.equal(f.launches.length, 1);
  await f.manager.cancel(first.run.id);
  await f.manager.close();
  const restarted = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, spawnProcess: () => { throw new Error('Must never replay'); } });
  await restarted.start();
  try {
    assert.equal(restarted.sessionList([]).length, 2);
    assert.ok(restarted.sessionList([]).every(session => !session.resumable && !session.creationPending));
    assert.ok(restarted.list().every(run => run.status === 'cancelled'));
  } finally { await restarted.close(); }
});

test('invalid input and a partially committed admission cannot launch a provider', async t => {
  const f = await fixture(t);
  for (const input of [
    { provider: 'codex', cwd: 'relative', prompt: 'hi' },
    { provider: 'codex', cwd: f.directory, prompt: '' },
    { provider: 'bad', cwd: f.directory, prompt: 'hi' },
    { provider: 'codex', cwd: join(f.directory, 'missing'), prompt: 'hi' },
    { provider: 'codex', cwd: f.directory, prompt: 'hi', title: 't'.repeat(121) },
  ]) await assert.rejects(f.manager.create(input as Parameters<RunManager['create']>[0]), { statusCode: 400 });
  await rm(join(f.stateDir, 'runs.json'));
  await mkdir(join(f.stateDir, 'runs.json'));
  await assert.rejects(f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'must not run later' }), { statusCode: 503 });
  assert.ok(f.manager.list().every(run => run.status === 'error'));
  assert.ok(f.manager.sessionList([]).every(session => session.status === 'error' && !session.creationPending));
  assert.equal(f.launches.length, 0);
  await rm(join(f.stateDir, 'runs.json'), { recursive: true });
  await f.manager.close();
  await writeFile(join(f.stateDir, 'runs.json'), '[]');
  const restarted = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, spawnProcess: () => { throw new Error('Must never replay'); } });
  await restarted.start();
  try { assert.equal(restarted.sessionList([])[0]?.status, 'error'); assert.equal(restarted.sessionList([])[0]?.resumable, false); }
  finally { await restarted.close(); }
});
