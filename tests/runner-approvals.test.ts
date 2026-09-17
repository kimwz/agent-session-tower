import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunManager } from '../server/runner.js';
import type { RunApproval, RunApprovalResponse, Session } from '../shared/types.js';

const ID = '40000000-0000-4000-8000-000000000001';
async function until<T>(read: () => T | undefined): Promise<T> {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for approval state.');
}
async function fixture(t: test.TestContext, mode = '') {
  const directory = await mkdtemp(join(tmpdir(), 'tower-approval-runner-'));
  const stateDir = join(directory, 'state');
  const script = join(directory, 'claude.mjs');
  const replies = join(directory, 'replies.jsonl');
  await writeFile(script, `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const value=JSON.parse(line);
 if(value.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{}}});
 if(value.type==='user'){
  send({type:'system',subtype:'init',session_id:'${ID}'});
  send({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'tool-1',input:{command:'gh --version'},description:'Read CLI version'}});
  if(process.env.FIXTURE_MODE==='finish-pending')send({type:'result',is_error:false,result:'Finished without executing the pending tool'});
 }
 if(value.type==='control_response'){
  appendFileSync(process.env.REPLIES,JSON.stringify(value)+'\\n');
  const denied=value.response.response.behavior==='deny';
  send({type:'result',is_error:false,result:denied?'Declined':'Tool permitted',permission_denials:denied?[{tool_name:'Bash'}]:[]});
 }
});
`);
  const session: Session = { id: `claude:${ID}`, nativeId: ID, provider: 'claude', title: 'Approval fixture', cwd: directory, project: 'fixture',
    status: 'idle', statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
  const manager = new RunManager({ stateDir, getSession: id => id === session.id ? session : undefined, refreshSessions: async () => {}, pollMs: 20,
    findExecutable: async () => '/fixture/claude', env: { REPLIES: replies, FIXTURE_MODE: mode },
    spawnProcess: (_file, args, options) => spawn(process.execPath, [script, ...args], options),
  });
  await manager.start(); t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const accepted = await manager.enqueue(session.id, 'Read the CLI version');
  return { manager, accepted, replies, stateDir, session };
}

test('runner publishes a live approval, keeps stdin open, and sends only an explicit allow', async t => {
  const f = await fixture(t);
  const pending = await until(() => f.manager.list().find(run => run.id === f.accepted.id && run.approvals?.length));
  assert.equal(pending.status, 'running'); assert.equal(pending.approvals![0].toolName, 'Bash');
  await assert.rejects(readFile(f.replies), { code: 'ENOENT' });
  pending.approvals![0].input.command = 'tampered copy';
  await assert.rejects(f.manager.respondToApproval(f.accepted.id, 'permission-1', { answers: { q: { answers: ['unsupported'] } } }), { statusCode: 400 });
  await assert.rejects(f.manager.respondToApproval(f.accepted.id, 'permission-1', { action: 'accept', content: {} }), { statusCode: 400 });
  assert.equal(f.manager.list()[0].approvals?.length, 1);
  await assert.rejects(readFile(f.replies), { code: 'ENOENT' });
  await f.manager.respondToApproval(f.accepted.id, 'permission-1', 'allow');
  await assert.rejects(f.manager.respondToApproval(f.accepted.id, 'permission-1', 'allow'), { statusCode: 409 });
  const finished = await until(() => f.manager.list().find(run => run.id === f.accepted.id && run.status === 'completed'));
  assert.equal(finished.approvals, undefined);
  const frames = (await readFile(f.replies, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.length, 1); assert.equal(frames[0].response.response.updatedInput.command, 'gh --version');
});

test('a denied tool call does not fail a turn that Claude still completed', async t => {
  const f = await fixture(t);
  await until(() => f.manager.list().find(run => run.approvals?.length));
  await f.manager.respondToApproval(f.accepted.id, 'permission-1', 'deny');
  const finished = await until(() => f.manager.list().find(run => run.id === f.accepted.id && run.status === 'completed'));
  assert.equal(finished.error, undefined); assert.match(finished.output, /Declined/); assert.equal(finished.approvals, undefined);
});

test('cancel and restart cannot revive or answer a pending permission request', async t => {
  const f = await fixture(t);
  await until(() => f.manager.list().find(run => run.approvals?.length));
  await (f.manager as unknown as { flush(): Promise<void> }).flush();
  const liveSaved = await readFile(join(f.stateDir, 'runs.json'), 'utf8');
  assert.equal(JSON.parse(liveSaved)[0].approvals, undefined);
  assert.doesNotMatch(liveSaved, /gh --version/);
  await f.manager.cancel(f.accepted.id); await f.manager.close();
  await assert.rejects(f.manager.respondToApproval(f.accepted.id, 'permission-1', 'allow'), { statusCode: 409 });
  assert.equal(f.manager.list()[0].approvals, undefined);
  const saved = JSON.parse(await readFile(join(f.stateDir, 'runs.json'), 'utf8'));
  assert.equal(saved[0].approvals, undefined);
  // Even a file written by an older version cannot restore a live decision.
  saved[0].approvals = [{ id: 'stale', toolName: 'Bash', input: { command: 'must not execute' } }];
  await writeFile(join(f.stateDir, 'runs.json'), JSON.stringify(saved));
  const restarted = new RunManager({ stateDir: f.stateDir, getSession: () => f.session, refreshSessions: async () => {}, spawnProcess: () => { throw new Error('Must not start'); } });
  await restarted.start();
  try { assert.equal(restarted.list()[0].approvals, undefined); await assert.rejects(restarted.respondToApproval(f.accepted.id, 'stale', 'allow'), { statusCode: 409 }); }
  finally { await restarted.close(); }
  await assert.rejects(readFile(f.replies), { code: 'ENOENT' });
});

test('a terminal native result clears an unanswered approval before process shutdown', async t => {
  const f = await fixture(t, 'finish-pending');
  const finished = await until(() => f.manager.list().find(run => run.id === f.accepted.id && run.status === 'completed'));
  assert.equal(finished.approvals, undefined);
  await assert.rejects(f.manager.respondToApproval(f.accepted.id, 'permission-1', 'allow'), { statusCode: 409 });
});

test('runner forwards structured Codex answers and keeps child form metadata live without persisting answers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-structured-approval-runner-'));
  const session: Session = { id: `codex:${ID}`, nativeId: ID, provider: 'codex', title: 'Structured approvals', cwd: directory, project: 'fixture', status: 'idle', statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
  const questions: RunApproval = { id: 'child-question', toolName: 'Questions', input: {}, origin: { threadId: 'child', turnId: 'child-turn', agentName: 'Researcher' }, interaction: { type: 'questions', questions: [{ id: 'secret', header: 'Credential', question: 'Enter secret', isOther: false, isSecret: true, options: null }] } };
  const form: RunApproval = { id: 'child-form', toolName: 'MCP form', input: {}, interaction: { type: 'mcp-form', serverName: 'fixture', schema: { type: 'object', properties: { enabled: { type: 'boolean' }, count: { type: 'integer' } } } } };
  const responses: Array<{ id: string; response: RunApprovalResponse }> = [];
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const manager = new RunManager({ stateDir: directory, getSession: id => id === session.id ? session : undefined, refreshSessions: async () => {}, pollMs: 20,
    findExecutable: async () => '/fixture/codex', openCodexStdio: async options => ({ done,
      start: async () => { await options.onSession(ID); options.onStarted?.('parent-turn'); options.onApproval(questions); options.onApproval(form); },
      respondToApproval: async (id, response) => { responses.push({ id, response }); options.onApprovalCancelled?.(id); },
      cancel: async () => { options.onFinished({ status: 'cancelled' }); resolveDone(); }, close: () => resolveDone(),
    }),
  });
  await manager.start(); t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const accepted = await manager.enqueue(session.id, 'Collect inputs');
  const pending = await until(() => manager.list().find(run => run.id === accepted.id && run.approvals?.length === 2));
  assert.deepEqual(pending.approvals![0].origin, questions.origin);
  const published = pending.approvals![0].interaction;
  if (published?.type !== 'questions') throw new Error('Questions were not published.');
  published.questions[0].question = 'tampered snapshot';
  assert.equal((manager.list()[0].approvals![0].interaction as typeof published).questions[0].question, 'Enter secret');
  const answer = { answers: { secret: { answers: ['private-token-not-saved'] } } };
  const formResponse = { action: 'accept' as const, content: { count: 0, enabled: false } };
  await manager.respondToApproval(accepted.id, questions.id, answer);
  assert.equal(manager.list()[0].approvals?.length, 1);
  await manager.respondToApproval(accepted.id, form.id, formResponse);
  assert.deepEqual(responses, [{ id: questions.id, response: answer }, { id: form.id, response: formResponse }]);
  assert.equal(manager.list()[0].approvals, undefined);
  await assert.rejects(manager.respondToApproval(accepted.id, questions.id, answer), { statusCode: 409 });
  await (manager as unknown as { flush(): Promise<void> }).flush();
  const saved = await readFile(join(directory, 'runs.json'), 'utf8');
  assert.doesNotMatch(saved, /private-token-not-saved|Enter secret|Credential/);
  assert.equal(manager.list()[0].output, '');
});
