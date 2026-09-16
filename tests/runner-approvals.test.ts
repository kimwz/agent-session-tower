import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunManager } from '../server/runner.js';
import type { Session } from '../shared/types.js';

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
  await f.manager.respondToApproval(f.accepted.id, 'permission-1', 'allow');
  await assert.rejects(f.manager.respondToApproval(f.accepted.id, 'permission-1', 'allow'), { statusCode: 409 });
  const finished = await until(() => f.manager.list().find(run => run.id === f.accepted.id && run.status === 'completed'));
  assert.equal(finished.approvals, undefined);
  const frames = (await readFile(f.replies, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.length, 1); assert.equal(frames[0].response.response.updatedInput.command, 'gh --version');
});

test('runner surfaces an explicit denial and retires its permission request', async t => {
  const f = await fixture(t);
  await until(() => f.manager.list().find(run => run.approvals?.length));
  await f.manager.respondToApproval(f.accepted.id, 'permission-1', 'deny');
  const finished = await until(() => f.manager.list().find(run => run.id === f.accepted.id && run.status === 'error'));
  assert.match(finished.error || '', /Permission was denied for: Bash/); assert.equal(finished.approvals, undefined);
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
