import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { APPROVAL_REPORT_DELAY_MS, APPROVAL_TURN_END_GRACE_MS } from '../../server/master/approval-waits.js';
import { MasterSession } from '../../server/master/session.js';
import { MasterScreen, MasterTools } from '../../server/master/tools.js';
import { NotificationService } from '../../server/notifications/service.js';
import { TowerClient } from '../../server/tower-tools/tower-client.js';
import type { LiveState } from '../../server/tower-tools/live-state.js';
import type { Run, RunApprovalResponse, Session, Snapshot } from '../../shared/types.js';
import { RunManager } from '../server/runs/sql-fixture.js';
import '../helpers/skip-fsync.js';
import { until } from '../helpers/until.js';

const ID = '40000000-0000-4000-8000-0000000000e2';
const MASTER = 'claude:master';

/**
 * From a real turn to the owner's device: a real RunManager runs a fake Claude that stops at a permission request, the
 * master session follows it, and the master's tool calls and notices reach the manager and a real NotificationService
 * through a small web. Only the master's own decisions are played by the test.
 */
async function system(t: test.TestContext, command: string, description: string) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-approval-e2e-'));
  const replies = join(directory, 'replies.jsonl');
  const script = join(directory, 'claude.mjs');
  await writeFile(script, `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const value=JSON.parse(line);
 if(value.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{}}});
 if(value.type==='user'){
  send({type:'system',subtype:'init',session_id:'${ID}'});
  send({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'tool-1',input:{command:process.env.FIXTURE_COMMAND},description:process.env.FIXTURE_DESCRIPTION}});
 }
 if(value.type==='control_response'){
  appendFileSync(process.env.REPLIES,JSON.stringify(value)+'\\n');
  send({type:'result',is_error:false,result:'Tool permitted'});
 }
});
`);
  const now = new Date().toISOString();
  const session: Session = { id: `claude:${ID}`, nativeId: ID, provider: 'claude', title: '9C 게임잼', cwd: directory, project: 'fixture', status: 'idle', statusReason: '', createdAt: now, updatedAt: now, lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
  const manager = new RunManager({ stateDir: join(directory, 'state'), getSession: id => id === session.id ? session : undefined, refreshSessions: async () => {}, pollMs: 20,
    findExecutable: async () => '/fixture/claude', env: { REPLIES: replies, FIXTURE_COMMAND: command, FIXTURE_DESCRIPTION: description }, spawnProcess: (_file, args, options) => spawn(process.execPath, [script, ...args], options) });
  await manager.start();

  const pushed: string[] = [];
  const notifications = new NotificationService(join(directory, 'notifications'), { runs: () => manager.list(), session: id => id === session.id ? session : undefined, project: () => 'verse8', trigger: () => undefined },
    (async (input: string | URL | Request) => { pushed.push(String(input)); return new Response(null, { status: 201 }); }) as typeof fetch);
  await notifications.start();
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  await notifications.subscribe({ subscription: { endpoint: 'https://push.example/phone', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }, language: 'ko' });

  const masterRuns: Run[] = [];
  const web = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url!, 'http://x');
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
    const send = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.method === 'POST' && url.pathname === `/api/sessions/${encodeURIComponent(MASTER)}/messages`) {
      const run: Run = { id: `m${masterRuns.length + 1}`, sessionId: MASTER, prompt: String(body.prompt), status: 'running', createdAt: new Date().toISOString(), output: '' };
      masterRuns.push(run);
      return send(202, { run });
    }
    if (req.method === 'POST' && url.pathname === '/api/master/approval-notice') return send(200, notifications.approvalNotice(body));
    const approval = /^\/api\/runs\/([^/]+)\/approvals\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && approval) {
      try { return send(200, { run: await manager.respondToApproval(decodeURIComponent(approval[1]!), decodeURIComponent(approval[2]!), body.decision as RunApprovalResponse) }); }
      catch (error) { return send(409, { error: (error as Error).message }); }
    }
    if (req.method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(url.pathname)) return send(200, { session: { id: session.id, updatedAt: new Date().toISOString() }, messages: [], hasMore: false });
    return send(404, {});
  });
  await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
  const tower = new TowerClient(2_000);
  tower.setCredentials({ port: (web.address() as { port: number }).port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const snapshot = (): Snapshot => ({ sessions: [], runs: [...manager.list(), ...masterRuns], autoPrompts: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' });
  const live = { fresh: async () => snapshot(), snapshot, node: () => undefined } as unknown as LiveState;
  let offset = 0;
  const master: MasterSession = new MasterSession({ stateDir: directory, dataDir: directory, binding: () => ({ sessionId: MASTER, provider: 'claude', startedAt: now }), writeGuide: async () => {}, baselineAt: new Date(Date.now() - 60_000).toISOString(), tower, live, followMs: 60_000, now: () => Date.now() + offset });
  await master.start();
  const tools = new MasterTools({ tower, live, screen: new MasterScreen({ broadcast: () => {} }), started: (target, input, answer) => master.started(target, input, answer), delegated: () => master.delegatedTable(), approvalGate: input => master.approvalGate(input) });
  t.after(async () => {
    await master.close(); await manager.close(); await notifications.close();
    web.closeAllConnections(); await new Promise<void>(resolve => web.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  // The master hands the work out, as session_message does, and it stops at the permission request.
  const run = await manager.enqueue(session.id, '개발 서버 DB를 확인해 주세요');
  await master.started({ method: 'POST', path: `/api/sessions/${encodeURIComponent(session.id)}/messages`, route: `/api/sessions/${session.id}/messages`, local: `/api/sessions/${encodeURIComponent(session.id)}/messages`, write: true }, { prompt: run.prompt, title: '개발 서버 DB 확인' }, { run });
  await until(() => manager.list().find(item => item.id === run.id && item.approvals?.length));
  const current = () => manager.list().find(item => item.id === run.id)!;
  const answer = (decision: 'allow' | 'deny') => tools.call('tower_api', { method: 'POST', path: `/api/runs/${encodeURIComponent(run.id)}/approvals/permission-1`, body: { decision } }) as Promise<{ error?: string; status?: number }>;
  return { master, masterRuns, current, answer, replies, pushed, notifications, advance: (ms: number) => { offset += ms; }, stamp: () => new Date(Date.now() + offset).toISOString() };
}

test('a clear request: the wait reaches the master, it allows it, the turn goes on, and nothing more reaches the owner', async t => {
  const s = await system(t, 'npm test', 'Run the tests');
  await s.master.follow();
  assert.equal(s.masterRuns.length, 0, 'the short delay comes first');
  s.notifications.check();
  await until(() => s.pushed.length === 1);
  s.advance(APPROVAL_REPORT_DELAY_MS);
  await s.master.follow();
  assert.equal(s.masterRuns.length, 1);
  assert.match(s.masterRuns[0]!.prompt, /waiting for an approval/);
  assert.match(s.masterRuns[0]!.prompt, /npm test/);
  assert.equal((await s.answer('allow')).error, undefined);
  await until(() => s.current().status === 'completed');
  assert.equal(JSON.parse((await readFile(s.replies, 'utf8')).trim()).response.response.behavior, 'allow');
  // The answer given twice goes once.
  assert.match((await s.answer('allow')).error ?? '', /이미 처리됐거나/);
  s.masterRuns[0]!.status = 'completed'; s.masterRuns[0]!.finishedAt = s.stamp();
  s.advance(APPROVAL_TURN_END_GRACE_MS);
  await s.master.follow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.pushed.length, 1, 'only the first push');
});

test('a secret: the master cannot allow it, its turn ends, the owner is pushed, and their word lets the master answer', async t => {
  const s = await system(t, 'ssh dev "grep DB_PASSWORD /srv/app/.env"', 'Reads the database password');
  s.notifications.check();
  await until(() => s.pushed.length === 1);
  await s.master.follow();
  s.advance(APPROVAL_REPORT_DELAY_MS);
  await s.master.follow();
  assert.match(s.masterRuns[0]!.prompt, /owner-only/);
  assert.match((await s.answer('allow')).error ?? '', /소유자가 판단합니다/);
  assert.match((await s.answer('deny')).error ?? '', /소유자가 판단합니다/);
  await assert.rejects(readFile(s.replies), { code: 'ENOENT' });

  s.masterRuns[0]!.status = 'completed'; s.masterRuns[0]!.finishedAt = s.stamp();
  s.advance(APPROVAL_TURN_END_GRACE_MS);
  await s.master.follow();
  await until(() => s.pushed.length === 2);
  await s.master.follow();
  assert.equal(s.current().status, 'running', 'the wait itself is never ended by Tower');
  assert.equal(s.pushed.length, 2);

  s.advance(1000);
  s.masterRuns.push({ id: 'm-owner', sessionId: MASTER, prompt: '승인합니다', status: 'running', createdAt: s.stamp(), output: '', origin: { kind: 'owner' } });
  assert.equal((await s.answer('allow')).error, undefined);
  await until(() => s.current().status === 'completed');
  assert.equal(JSON.parse((await readFile(s.replies, 'utf8')).trim()).response.response.updatedInput.command, 'ssh dev "grep DB_PASSWORD /srv/app/.env"');
});
