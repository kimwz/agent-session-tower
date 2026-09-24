import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import { SessionTitleStore } from '../../../server/stores/session-titles.js';
import type { Provider, Run, Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

const CODEX_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_ID = '20000000-0000-4000-8000-000000000002';


async function fixture(t: test.TestContext, mode = '', maxConcurrent = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-created-'));
  const stateDir = join(directory, 'state');
  const script = join(directory, 'provider.mjs');
  const native = new Map<string, Session>();
  const launches: string[][] = [];
  await writeFile(script, `
import {mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import { startCodexFixture } from ${JSON.stringify(new URL('./fixtures/provider-stdio.mjs', import.meta.url).href)};
let prompt = '';
process.stdin.setEncoding('utf8');
if (process.argv.includes('-p')) createInterface({input:process.stdin}).on('line', line => {
  const message=JSON.parse(line);
  if(message.type==='control_request'&&message.request.subtype==='initialize') process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{}}})+'\\n');
  else if(message.type==='user'){prompt=message.message.content[0].text;processPrompt();}
});
else startCodexFixture({defaultId:'${CODEX_ID}',otherId:'${OTHER_ID}',created:true});
function processPrompt() {
  const args = process.argv.slice(2);
  writeFileSync(process.env.RECEIVED_PATH, JSON.stringify({args,prompt,cwd:process.cwd()}));
  const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
  const claude = args.includes('-p');
  const resume = args.includes('--resume') || args.includes('resume');
  const id = claude ? args[args.indexOf(resume ? '--resume' : '--session-id') + 1] : '${CODEX_ID}';
  const mode = process.env.FIXTURE_MODE;
  if (mode === 'break-registry') { rmSync(process.env.CREATED_PATH,{force:true}); mkdirSync(process.env.CREATED_PATH); }
  if (mode === 'fail') { process.stderr.write('authentication expired'); process.exit(2); return; }
  if (mode === 'hold-before-id') { setInterval(() => {}, 1000); return; }
  const actual = mode === 'invalid-id' ? 'bad-id' : mode === 'mismatch' ? '${OTHER_ID}' : id;
  send(claude ? {type:'system',subtype:'init',session_id:actual} : {type:'thread.started',thread_id:actual});
  if (mode === 'double-id') send({type:'thread.started',thread_id:'${OTHER_ID}'});
  if (mode === 'hold') { setInterval(() => {}, 1000); return; }
  if (claude) send({type:'result',is_error:false,result:'Created Claude'});
  else { send({type:'item.completed',item:{type:'agent_message',text:'Created Codex'}}); send({type:'turn.completed'}); }
}
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

test('new-session model is persisted and passed as a native override', async t => {
  const f = await fixture(t);
  for (const provider of ['claude', 'codex'] as const) {
    const accepted = await f.manager.create({ provider, cwd: f.directory, prompt: 'Create with selected model', model: 'native-model' });
    assert.equal(accepted.run.model, 'native-model');
    assert.equal((await finished(f.manager, accepted.run.id)).status, 'completed');
    const args = f.launches.at(-1)!;
    if (provider === 'claude') assert.equal(args[args.indexOf('--model') + 1], 'native-model');
    else assert.equal(JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8')).threadParams.model, 'native-model');
  }
  const count = f.manager.list().length;
  await assert.rejects(f.manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Invalid override', model: '--settings' }), /Invalid model/);
  assert.equal(f.manager.list().length, count);
});

test("Tower's own Codex turns hand approvals to the automatic reviewer, new or resumed, whatever a page asks", async t => {
  const f = await fixture(t);
  const threadParams = async () => JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8')).threadParams;
  const owner = { origin: { kind: 'owner' as const } };
  const accepted = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Create', codexApprovalsReviewer: 'user' }, owner);
  assert.equal(accepted.run.codexApprovalsReviewer, undefined);
  assert.equal((await finished(f.manager, accepted.run.id)).status, 'completed');
  assert.equal((await threadParams()).approvalsReviewer, 'auto_review');
  const resumed = await f.manager.enqueue(accepted.session.id, 'continue in the same conversation', {}, owner);
  assert.equal((await finished(f.manager, resumed.id)).status, 'completed');
  assert.equal((await threadParams()).approvalsReviewer, 'auto_review');
  const unrecorded = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'No recorded origin' });
  assert.equal((await finished(f.manager, unrecorded.run.id)).status, 'completed');
  assert.equal((await threadParams()).approvalsReviewer, 'auto_review');
  const claude = await f.manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Claude ignores it', codexApprovalsReviewer: 'auto_review' });
  assert.equal(claude.run.codexApprovalsReviewer, undefined);
  await assert.rejects(f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Invalid reviewer', codexApprovalsReviewer: 'always' as 'user' }), { statusCode: 400 });
});

test('a trigger keeps the reviewer it chose for a new Codex conversation, and never sends one on resume', async t => {
  const f = await fixture(t);
  const threadParams = async () => JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8')).threadParams;
  const trigger = { origin: { kind: 'trigger' as const, triggerId: 'daily' } };
  const chosen = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Scheduled', codexApprovalsReviewer: 'user' }, trigger);
  assert.equal(chosen.run.codexApprovalsReviewer, 'user');
  assert.equal((await finished(f.manager, chosen.run.id)).status, 'completed');
  assert.equal((await threadParams()).approvalsReviewer, 'user');
  const resumed = await f.manager.enqueue(chosen.session.id, 'continue in the same conversation', {}, trigger);
  assert.equal((await finished(f.manager, resumed.id)).status, 'completed');
  assert.equal((await threadParams()).approvalsReviewer, undefined, 'Codex keeps the choice with the thread');
  const untouched = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Scheduled with the Codex default' }, trigger);
  assert.equal((await finished(f.manager, untouched.run.id)).status, 'completed');
  assert.equal((await threadParams()).approvalsReviewer, undefined);
});

test("a Codex that does not confirm the automatic reviewer still runs the owner's turn, never unattended work", async t => {
  const f = await fixture(t, 'old-reviewer');
  const owner = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Create' }, { origin: { kind: 'owner' } });
  const done = await finished(f.manager, owner.run.id);
  assert.equal(done.status, 'completed');
  assert.match(done.output, /^\[Tower\] Codex did not confirm Auto approval review\. Approval requests will wait for you in Tower\.\n/);
  const trigger = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Scheduled', codexApprovalsReviewer: 'auto_review' },
    { origin: { kind: 'trigger', triggerId: 'daily' }, unattended: true });
  const refused = await finished(f.manager, trigger.run.id);
  assert.equal(refused.status, 'error');
  assert.match(refused.error ?? '', /did not confirm Auto approval review\. No message was submitted/);
});

test("a Codex that refuses the automatic reviewer still runs the owner's new and resumed turns, never unattended work", async t => {
  const f = await fixture(t, 'refuse-reviewer');
  const threadParams = async () => JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8')).threadParams;
  const note = /^\[Tower\] Codex did not confirm Auto approval review\. Approval requests will wait for you in Tower\.\n/;
  const owner = { origin: { kind: 'owner' as const } };
  const created = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Create' }, owner);
  const done = await finished(f.manager, created.run.id);
  assert.equal(done.status, 'completed');
  assert.match(done.output, note);
  assert.equal((await threadParams()).approvalsReviewer, undefined);
  const resumed = await f.manager.enqueue(created.session.id, 'continue', {}, owner);
  const next = await finished(f.manager, resumed.id);
  assert.equal(next.status, 'completed');
  assert.match(next.output, note);
  assert.equal((await threadParams()).threadId, CODEX_ID);
  const trigger = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Scheduled', codexApprovalsReviewer: 'auto_review' },
    { origin: { kind: 'trigger', triggerId: 'daily' }, unattended: true });
  const refused = await finished(f.manager, trigger.run.id);
  assert.equal(refused.status, 'error');
  assert.match(refused.error ?? '', /unknown variant `auto_review`/);
});

test("any other refusal of the owner's Codex thread is reported, never retried", async t => {
  const f = await fixture(t, 'refuse-thread');
  const created = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Create' }, { origin: { kind: 'owner' } });
  const failed = await finished(f.manager, created.run.id);
  assert.equal(failed.status, 'error');
  assert.match(failed.error ?? '', /thread is not available/);
  assert.equal(f.launches.length, 1);
});

test('a queued creation keeps its approval reviewer across a Tower restart', async t => {
  const f = await fixture(t, 'hold-before-id', 1);
  const trigger = { origin: { kind: 'trigger' as const, triggerId: 'daily' } };
  const holding = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'hold', codexApprovalsReviewer: 'user' }, trigger);
  await until(() => f.manager.list().find(run => run.id === holding.run.id && run.status === 'running'));
  const queued = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'queued', codexApprovalsReviewer: 'auto_review' }, trigger);
  const claude = await f.manager.create({ provider: 'claude', cwd: f.directory, prompt: 'queued claude', codexApprovalsReviewer: 'auto_review' }, trigger);
  await f.manager.close();
  const restarted = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {},
    findExecutable: async () => { throw new Error('Restart verification must not launch providers'); } });
  await restarted.start();
  try {
    assert.equal(restarted.list().find(run => run.id === queued.run.id)?.codexApprovalsReviewer, 'auto_review');
    assert.equal(restarted.list().find(run => run.id === claude.run.id)?.codexApprovalsReviewer, undefined);
  } finally { await restarted.close(); }
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
    if (provider === 'claude') {
      assert.ok(f.launches[1]!.includes(confirmed.nativeId));
      assert.ok(f.launches[1]!.includes('--resume'));
    } else {
      const resumed = JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8'));
      assert.equal(resumed.threadMethod, 'thread/resume');
      assert.equal(resumed.threadParams.threadId, confirmed.nativeId);
    }
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

for (const [provider, mode] of [['codex', 'invalid-id'], ['codex', 'unconfirmed-turn'], ['claude', 'mismatch']] as const) {
  test(`creation stops on ${provider} ${mode} identity events`, async t => {
    const f = await fixture(t, mode);
    const accepted = await f.manager.create({ provider, cwd: f.directory, prompt: 'create once' });
    assert.equal((await finished(f.manager, accepted.run.id)).status, 'error');
    assert.equal(f.launches.length, 1);
    if (mode !== 'unconfirmed-turn') assert.equal(f.manager.getSession(accepted.session.id)?.resumable, false);
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
    { provider: 'codex', cwd: join(f.stateDir, 'runs.json', 'child'), prompt: 'hi' },
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

for (const provider of ['claude', 'codex'] as const) {
  test(`created ${provider} project keeps its chosen folder after native discovery and restart`, async t => {
    const f = await fixture(t);
    const accepted = await f.manager.create({ provider, cwd: f.directory, prompt: 'Create in the chosen folder' });
    assert.equal((await finished(f.manager, accepted.run.id)).status, 'completed');
    const confirmed = f.manager.getSession(accepted.session.id)!;
    const nativeId = f.manager.nativeSessionId(confirmed.id);
    for (const cwd of ['', join(f.directory, 'different-project')]) {
      f.native.set(nativeId, { ...confirmed, id: nativeId, cwd, project: 'Changed native project', title: 'Native title', creationPending: undefined });
      const merged = f.manager.getSession(confirmed.id)!;
      assert.equal(merged.cwd, f.directory);
      assert.equal(merged.project, accepted.session.project);
      assert.equal(merged.title, 'Native title');
      assert.equal(f.manager.getSession(nativeId)?.cwd, f.directory);
      assert.equal(f.manager.sessionList([...f.native.values()])[0].cwd, f.directory);
    }
    // A subsequent launch also uses the creation folder, not the discovered cwd.
    const resumed = await f.manager.enqueue(confirmed.id, 'Continue in the original project');
    assert.equal((await finished(f.manager, resumed.id)).status, 'completed');
    assert.equal(JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8')).cwd, await realpath(f.directory));
    await f.manager.close();
    const restarted = new RunManager({ stateDir: f.stateDir, getSession: id => f.native.get(id), refreshSessions: async () => {},
      findExecutable: async () => { throw new Error('Restart verification must not launch providers'); } });
    try {
      await restarted.start();
      assert.equal(restarted.getSession(confirmed.id)?.cwd, f.directory);
      assert.equal(restarted.getSession(confirmed.id)?.project, accepted.session.project);
    } finally { await restarted.close(); }
  });
}
