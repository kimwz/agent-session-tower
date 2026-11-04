import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveState } from '../../server/tower-tools/live-state.js';
import { approvalFlags, APPROVAL_OWNER_DEADLINE_MS, APPROVAL_REPORT_DELAY_MS, APPROVAL_TURN_END_GRACE_MS } from '../../server/master/approval-waits.js';
import { masterGuide, todoMasterGuide } from '../../server/master/guide.js';
import { MasterSession } from '../../server/master/session.js';
import { MasterScreen, MasterTools } from '../../server/master/tools.js';
import { TowerClient } from '../../server/tower-tools/tower-client.js';
import type { Run, RunApproval, Snapshot } from '../../shared/types.js';
import '../helpers/skip-fsync.js';

const MASTER = 'claude:master';
const WORKER = 'claude:worker';
const NODE = 'a'.repeat(32);
const ENV_READ: RunApproval = { id: 'ssh-1', toolName: 'Bash', input: { command: 'ssh dev "grep DB_PASSWORD /srv/app/.env && psql -c \'select 1\'"' }, description: 'Reads the database password from the dev server' };
const PLAIN: RunApproval = { id: 'test-1', toolName: 'Bash', input: { command: 'npm test' }, description: 'Run the tests' };

/** A Tower with the master session and one worker session, moved by hand; its answers to approvals act as the worker's do. */
async function harness(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-approval-waits-'));
  const runs: Run[] = [];
  const nodeRuns: Run[] = [];
  const nodes: Snapshot['nodes'] = [];
  const notices: Array<Record<string, unknown>> = [];
  const answers: Array<{ path: string; body: unknown }> = [];
  let clock = Date.parse('2026-11-04T06:21:00.000Z');
  let messageStatus = 202;
  let noticeStatus = 200;
  const stamp = () => new Date(clock).toISOString();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url!, 'http://x');
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
    const send = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    const message = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (req.method === 'POST' && message) {
      if (messageStatus !== 202) return send(messageStatus, { error: 'busy' });
      const run: Run = { id: `m${runs.length + 1}`, sessionId: decodeURIComponent(message[1]!), prompt: String(body.prompt), status: 'running', createdAt: stamp(), output: '' };
      runs.push(run);
      return send(202, { run });
    }
    if (req.method === 'POST' && url.pathname === '/api/master/approval-notice') {
      if (noticeStatus !== 200) return send(noticeStatus, { error: 'away' });
      notices.push(body);
      return send(200, { ok: true });
    }
    const approval = /^\/api\/(?:nodes\/[a-f0-9]{32}\/)?runs\/([^/]+)\/approvals\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && approval) {
      answers.push({ path: url.pathname, body });
      const run = [...runs, ...nodeRuns].find(item => item.id === decodeURIComponent(approval[1]!));
      const id = decodeURIComponent(approval[2]!);
      if (!run?.approvals?.some(item => item.id === id)) return send(409, { error: 'This permission request is no longer pending.' });
      run.approvals = run.approvals.filter(item => item.id !== id);
      if (!run.approvals.length) delete run.approvals;
      return send(200, { run });
    }
    if (req.method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(url.pathname)) return send(200, { session: { id: 'x', updatedAt: stamp() }, messages: [], hasMore: false });
    return send(404, {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const tower = new TowerClient(2_000);
  tower.setCredentials({ port: (server.address() as { port: number }).port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const snapshot = (): Snapshot => ({ sessions: [], runs, autoPrompts: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '', nodes });
  const live = { fresh: async () => snapshot(), snapshot, node: (id: string) => id === NODE ? { ...snapshot(), runs: nodeRuns, nodes: [] } : undefined } as unknown as LiveState;
  const sessions: MasterSession[] = [];
  const open = async () => {
    const session: MasterSession = new MasterSession({ stateDir: dir, dataDir: dir, binding: () => ({ sessionId: MASTER, provider: 'claude', startedAt: stamp() }), writeGuide: async () => {}, baselineAt: new Date(clock - 60_000).toISOString(), tower, live, followMs: 60_000, reportRetryMs: 1, now: () => clock });
    await session.start();
    sessions.push(session);
    return session;
  };
  t.after(async () => {
    for (const session of sessions) await session.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const session = await open();
  const tools = new MasterTools({ tower, live, screen: new MasterScreen({ broadcast: () => {} }), started: (target, body, answer) => session.started(target, body, answer), delegated: () => session.delegatedTable(), approvalGate: input => session.approvalGate(input) });
  /** Work the master handed out: a turn of the worker's session, followed from now on. */
  const handOut = async (id = 'w1', extra: Partial<Run> = {}, node?: string) => {
    const run: Run = { id, sessionId: WORKER, prompt: `work ${id}`, status: 'running', createdAt: stamp(), output: '', ...extra };
    (node ? nodeRuns : runs).push(run);
    await session.started({ method: 'POST', path: `/api/sessions/${encodeURIComponent(WORKER)}/messages`, route: `/api/sessions/${WORKER}/messages`, local: `/api/sessions/${encodeURIComponent(WORKER)}/messages`, write: true, ...(node ? { node } : {}) }, { prompt: run.prompt, title: `work ${id}` }, { run });
    return run;
  };
  const reports = () => runs.filter(run => run.sessionId === MASTER && run.prompt.startsWith('[Tower report]') && run.prompt.includes('waiting for an approval'));
  const owner = (text: string) => { const run: Run = { id: `o${runs.length + 1}`, sessionId: MASTER, prompt: text, status: 'running', createdAt: stamp(), output: '', origin: { kind: 'owner' } }; runs.push(run); return run; };
  const answer = (run: Run, approvalId: string, body: Record<string, unknown>, node?: string) => tools.call('tower_api', { method: 'POST', path: `/api/runs/${encodeURIComponent(run.id)}/approvals/${encodeURIComponent(approvalId)}`, body, ...(node ? { node } : {}) }) as Promise<{ error?: string; status?: number }>;
  return { dir, session, open, runs, nodeRuns, nodes, notices, answers, handOut, reports, owner, answer, tools, tower, live,
    advance: (ms: number) => { clock += ms; }, stamp,
    setMessageStatus: (status: number) => { messageStatus = status; }, setNoticeStatus: (status: number) => { noticeStatus = status; } };
}

test('the reported case: four messages joined in one turn, one approval, one report that says what it waits on; then the master\'s turn ends and the owner is told once', async t => {
  const h = await harness(t);
  const turn = await h.handOut('0a94e4c6');
  for (const id of ['d4fde3e4', 'e04ed8e7', '23e02e14']) await h.handOut(id, { steering: { state: 'delivered', targetRunId: turn.id } as Run['steering'] });
  await h.session.follow();
  assert.equal(h.reports().length, 0, 'nothing waits yet');

  turn.approvals = [ENV_READ];
  await h.session.follow();
  h.advance(APPROVAL_REPORT_DELAY_MS - 1);
  await h.session.follow();
  assert.equal(h.reports().length, 0, 'within the short delay');

  h.advance(1);
  await h.session.follow();
  await h.session.follow();
  assert.equal(h.reports().length, 1, 'once, though four followed runs wait on it and it was looked at twice');
  const prompt = h.reports()[0]!.prompt;
  assert.match(prompt, /^\[Tower report\] Work you handed out is waiting for an approval \(report [a-f0-9]{8}\)/);
  assert.match(prompt, /session claude:worker/);
  assert.match(prompt, /waiting 30 s/);
  assert.match(prompt, /grep DB_PASSWORD/);
  assert.match(prompt, /Reads the database password/);
  assert.match(prompt, /"tool":"Bash"/);
  assert.match(prompt, /owner-only \(reads or handles a secret\)/);
  assert.match(prompt, new RegExp(`Answer through POST /api/runs/${turn.id}/approvals/${ENV_READ.id}\\.`), 'the owner may say yes later: the master can still find it');
  assert.match(prompt, /untrusted/);
  assert.equal(h.notices.length, 0, 'the master has not answered yet');

  // The master may not allow it; what it tells the owner is its own, and its turn ends.
  const refused = await h.answer(turn, ENV_READ.id, { decision: 'allow' });
  assert.match(refused.error ?? '', /소유자가 판단합니다/);
  assert.equal(h.answers.length, 0, 'the refusal never reached Tower');
  const report = h.reports()[0]!;
  report.status = 'completed'; report.finishedAt = h.stamp();
  await h.session.follow();
  assert.equal(h.notices.length, 0, 'its answer gets a moment to arrive');
  h.advance(APPROVAL_TURN_END_GRACE_MS);
  await h.session.follow();
  await h.session.follow();
  assert.deepEqual(h.notices, [{ key: `:${turn.id}:${ENV_READ.id}`, sessionId: WORKER, title: `work ${turn.id}`, detail: ENV_READ.description }]);
  assert.equal(h.reports().length, 1);

  // The owner answers the master, and only then its answer goes.
  h.advance(1000);
  h.owner('승인해 주세요');
  assert.equal((await h.answer(turn, ENV_READ.id, { decision: 'allow' })).error, undefined);
  assert.equal(h.answers.length, 1);
  await h.session.follow();
  assert.equal(JSON.parse(await readFile(join(h.dir, 'follow.json'), 'utf8')).approvalWaits[0].settledAt, h.stamp());
});

test('an ordinary request within the master\'s reach: reported, allowed, and the owner is not told again', async t => {
  const h = await harness(t);
  const run = await h.handOut();
  run.approvals = [PLAIN];
  await h.session.follow();
  h.advance(APPROVAL_REPORT_DELAY_MS);
  await h.session.follow();
  assert.match(h.reports()[0]!.prompt, /Answer through POST \/api\/runs\/w1\/approvals\/test-1\./);
  assert.match(h.reports()[0]!.prompt, /You may allow it with \{"decision":"allow"\}/);
  assert.equal((await h.answer(run, PLAIN.id, { decision: 'allow' })).error, undefined);
  assert.deepEqual(h.answers.map(item => item.body), [{ decision: 'allow' }]);
  await h.session.follow();
  h.advance(APPROVAL_OWNER_DEADLINE_MS);
  const report = h.reports()[0]!;
  report.status = 'completed'; report.finishedAt = h.stamp();
  await h.session.follow();
  assert.equal(h.notices.length, 0);
});

test('a wait that ends within the short delay reaches no one', async t => {
  const h = await harness(t);
  const run = await h.handOut();
  run.approvals = [PLAIN];
  await h.session.follow();
  delete run.approvals;
  await h.session.follow();
  h.advance(APPROVAL_OWNER_DEADLINE_MS);
  await h.session.follow();
  assert.equal(h.reports().length, 0);
  assert.equal(h.notices.length, 0);
});

test('a late answer does nothing: the master\'s call does not go out once the request is answered, and Tower refuses one already on its way', async t => {
  const h = await harness(t);
  const run = await h.handOut();
  run.approvals = [PLAIN];
  await h.session.follow();
  h.advance(APPROVAL_REPORT_DELAY_MS);
  await h.session.follow();
  delete run.approvals;
  const late = await h.answer(run, PLAIN.id, { decision: 'allow' });
  assert.match(late.error ?? '', /이미 처리됐거나/);
  assert.equal(h.answers.length, 0);
  // Answered between the look and the send: the worker's own refusal stands, once.
  run.approvals = [PLAIN];
  const first = await h.answer(run, PLAIN.id, { decision: 'allow' });
  assert.equal(first.error, undefined);
  run.approvals = undefined;
  assert.match((await h.answer(run, PLAIN.id, { decision: 'allow' })).error ?? '', /이미 처리됐거나/);
  assert.equal(h.answers.length, 1);
});

test('a stopped master gets no report: the owner is told instead, and a run the owner stopped is nobody\'s to answer', async t => {
  const h = await harness(t);
  const run = await h.handOut();
  const stopped: Run = { id: 'm-stopped', sessionId: MASTER, prompt: 'owner asks', status: 'running', ownerStopped: true, createdAt: h.stamp(), output: '', origin: { kind: 'owner' } };
  h.runs.push(stopped);
  await h.session.follow();
  assert.ok(h.session.heartbeatStopped(), 'a stop counts while the turn is still ending');
  run.approvals = [PLAIN];
  await h.session.follow();
  h.advance(APPROVAL_REPORT_DELAY_MS);
  await h.session.follow();
  assert.equal(h.reports().length, 0);
  assert.equal(h.notices.length, 1);

  // A stop Codex never confirmed ends as an error: still a stop, also after a restart.
  stopped.status = 'error'; stopped.finishedAt = h.stamp();
  await h.session.follow();
  await h.session.close();
  const again = await h.open();
  await again.follow();
  assert.ok(again.heartbeatStopped());
  assert.equal(h.reports().length, 0);

  const other = await harness(t);
  const work = await other.handOut();
  work.approvals = [PLAIN];
  await other.session.follow();
  work.ownerStopped = true;
  await other.session.follow();
  other.advance(APPROVAL_OWNER_DEADLINE_MS);
  await other.session.follow();
  assert.equal(other.reports().length, 0);
  assert.equal(other.notices.length, 0);
  assert.match((await other.answer(work, PLAIN.id, { decision: 'allow' })).error ?? '', /이미 처리됐거나/);
});

test('Tower\'s own permission records, reports and notices are not the owner speaking: they neither release a stop nor open the gate', async t => {
  const h = await harness(t);
  const run = await h.handOut();
  h.runs.push({ id: 'm-stopped', sessionId: MASTER, prompt: 'owner asks', status: 'cancelled', ownerStopped: true, finishedAt: h.stamp(), createdAt: h.stamp(), output: '', origin: { kind: 'owner' } });
  await h.session.follow();
  h.advance(1000);
  h.runs.push({ id: 'm-receipt', sessionId: MASTER, prompt: '[Agent Session Tower] Permission refused', status: 'cancelled', finishedAt: h.stamp(), createdAt: h.stamp(), output: '', origin: { kind: 'owner' }, permissionRequestIds: ['p1'] });
  await h.session.follow();
  assert.ok(h.session.heartbeatStopped(), 'a decision record files as the owner\'s but releases nothing');

  run.approvals = [ENV_READ];
  await h.session.follow();
  h.advance(1000);
  h.runs.push({ id: 'm-receipt-2', sessionId: MASTER, prompt: 'x', status: 'cancelled', finishedAt: h.stamp(), createdAt: h.stamp(), output: '', origin: { kind: 'owner' }, permissionRequestIds: ['p2'] });
  h.runs.push({ id: 'm-notice', sessionId: MASTER, prompt: '[Agent Session Tower] Background work finished', status: 'running', createdAt: h.stamp(), output: '', origin: { kind: 'owner' } });
  h.runs.push({ id: 'm-report', sessionId: MASTER, prompt: '[Tower report] Work you handed out ended (report x)', status: 'running', createdAt: h.stamp(), output: '', origin: { kind: 'owner' } });
  h.runs.push({ id: 'm-beat', sessionId: MASTER, prompt: 'check', status: 'running', createdAt: h.stamp(), output: '', origin: { kind: 'agent' } });
  assert.match((await h.answer(run, ENV_READ.id, { decision: 'allow' })).error ?? '', /소유자가 판단합니다/);

  // A request said aloud is the owner speaking.
  h.advance(1000);
  h.runs.push({ id: 'm-voice', sessionId: MASTER, prompt: '[voice] 승인해', status: 'running', createdAt: h.stamp(), output: '', origin: { kind: 'owner' }, sender: 'master' });
  assert.equal((await h.answer(run, ENV_READ.id, { decision: 'allow' })).error, undefined);
});

test('a stop counts once, from when it was seen: earlier messages do not release it, and its turn ending later does not bring it back', async t => {
  const h = await harness(t);
  const stopped: Run = { id: 'm-turn', sessionId: MASTER, prompt: 'owner asks', status: 'running', createdAt: h.stamp(), output: '', origin: { kind: 'owner' } };
  h.runs.push(stopped);
  h.advance(1000);
  h.owner('one more thing, sent before the stop');
  h.advance(1000);
  stopped.ownerStopped = true;
  await h.session.follow();
  assert.ok(h.session.heartbeatStopped(), 'a message from before the stop releases nothing');
  h.advance(1000);
  h.owner('carry on');
  await h.session.follow();
  assert.equal(h.session.heartbeatStopped(), false, 'a newer request does');
  h.advance(10_000);
  stopped.status = 'error'; stopped.finishedAt = h.stamp();
  await h.session.follow();
  assert.equal(h.session.heartbeatStopped(), false, 'the stopped turn ending at last is not a new stop');
  await h.session.close();
  const again = await h.open();
  await again.follow();
  assert.equal(again.heartbeatStopped(), false, 'nor after a restart');
});

test('the owner hears of it whatever goes wrong with the master: reports refused, or nothing from it by the deadline', async t => {
  const h = await harness(t);
  const run = await h.handOut();
  h.setMessageStatus(409);
  run.approvals = [PLAIN];
  await h.session.follow();
  h.advance(APPROVAL_REPORT_DELAY_MS);
  for (let tries = 0; tries < 8; tries++) { await h.session.follow(); h.advance(300_000 / 60); await new Promise(resolve => setTimeout(resolve, 2)); }
  await h.session.follow();
  assert.equal(h.notices.length, 1, 'given up on');
  assert.equal(h.reports().length, 0);

  const busy = await harness(t);
  const work = await busy.handOut();
  work.approvals = [PLAIN];
  await busy.session.follow();
  busy.advance(APPROVAL_REPORT_DELAY_MS);
  await busy.session.follow();
  assert.equal(busy.reports().length, 1, 'taken, and the master is still in that turn');
  busy.advance(APPROVAL_OWNER_DEADLINE_MS - APPROVAL_REPORT_DELAY_MS - 1);
  await busy.session.follow();
  assert.equal(busy.notices.length, 0);
  busy.advance(1);
  await busy.session.follow();
  assert.equal(busy.notices.length, 1, 'the deadline does not wait for the master');

  // A web away at that moment: it goes again.
  const away = await harness(t);
  const third = await away.handOut();
  third.approvals = [PLAIN];
  await away.session.follow();
  away.setNoticeStatus(503);
  away.advance(APPROVAL_OWNER_DEADLINE_MS);
  await away.session.follow();
  assert.equal(away.notices.length, 0);
  away.setNoticeStatus(200);
  away.advance(30_000);
  await away.session.follow();
  assert.equal(away.notices.length, 1);
});

test('a restart neither reports again nor loses the wait', async t => {
  const h = await harness(t);
  const run = await h.handOut();
  run.approvals = [PLAIN];
  await h.session.follow();
  h.advance(APPROVAL_REPORT_DELAY_MS);
  await h.session.follow();
  assert.equal(h.reports().length, 1);
  await h.session.close();
  const again = await h.open();
  await again.follow();
  assert.equal(h.reports().length, 1);
  assert.equal(again.busy(), false);
  h.advance(APPROVAL_OWNER_DEADLINE_MS);
  await again.follow();
  assert.equal(h.notices.length, 1, 'the deadline counts from when it was first seen');
});

test('a report cut off while it went is looked for by its ID and not sent again', async t => {
  const h = await harness(t);
  const run = await h.handOut();
  run.approvals = [PLAIN];
  await h.session.follow();
  h.advance(APPROVAL_REPORT_DELAY_MS);
  await h.session.follow();
  assert.equal(h.reports().length, 1);
  await h.session.close();
  const path = join(h.dir, 'follow.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.approvalWaits[0].report = 'sending';
  await writeFile(path, JSON.stringify(saved));
  const again = await h.open();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).approvalWaits[0].report, 'uncertain');
  await again.follow();
  assert.equal(h.reports().length, 1, 'found in the master\'s runs');
  const after = JSON.parse(await readFile(path, 'utf8')).approvalWaits[0];
  assert.equal(after.report, 'sent');
  assert.equal(after.reportRunId, h.reports()[0]!.id);
});

test('only a plain yes is the master\'s alone: a no, a question\'s answer and a form wait for the owner', async t => {
  const h = await harness(t);
  const run = await h.handOut();
  const question: RunApproval = { id: 'q1', toolName: 'AskUserQuestion', input: {}, interaction: { type: 'questions', questions: [{ id: '0', header: 'Pick', question: 'Which?', isOther: true, isSecret: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] } };
  const form: RunApproval = { id: 'f1', toolName: 'mcp', input: {}, interaction: { type: 'mcp-form', schema: {}, serverName: 'x' } };
  run.approvals = [PLAIN, question, form];
  await h.session.follow();
  h.advance(APPROVAL_REPORT_DELAY_MS);
  await h.session.follow();
  const asked = h.reports()[0]!.prompt;
  assert.match(asked, /It asks a question or a form: the owner answers it/);
  assert.match(asked, /Which\?/, 'a question\'s words are in its interaction, not its input');
  assert.match(asked, /approvals\/q1\./);
  h.advance(APPROVAL_OWNER_DEADLINE_MS);
  await h.session.follow();
  assert.deepEqual(h.notices.find(notice => String(notice.key).endsWith(':q1')), { key: ':w1:q1', sessionId: WORKER, title: 'work w1', detail: 'Which?', question: true }, 'the owner reads what it asks');
  h.advance(-APPROVAL_OWNER_DEADLINE_MS);
  for (const [id, body] of [[PLAIN.id, { decision: 'deny' }], [question.id, { decision: 'allow' }], [question.id, { answers: { 0: { answers: ['A'] } } }], [form.id, { action: 'accept', content: {} }], [PLAIN.id, { decision: 'allow', extra: 1 }]] as const) {
    assert.match((await h.answer(run, id, body)).error ?? '', /소유자가 판단합니다/, JSON.stringify(body));
  }
  assert.equal(h.answers.length, 0);
  h.advance(1000);
  h.owner('A로 하고 나머지는 거절하세요');
  assert.equal((await h.answer(run, question.id, { answers: { 0: { answers: ['A'] } } })).error, undefined);
  assert.equal((await h.answer(run, PLAIN.id, { decision: 'deny' })).error, undefined);
});

test('a master without its follow state answers nothing, and an unknown wait counts only recent words from the owner', async t => {
  const h = await harness(t);
  const untracked = new MasterTools({ tower: h.tower, live: h.live, screen: new MasterScreen({ broadcast: () => {} }), started: async () => {}, delegated: () => ({ name: 'delegated', columns: [], rows: [] }) });
  const run: Run = { id: 'outside', sessionId: 'claude:other', prompt: 'x', status: 'running', createdAt: h.stamp(), output: '', approvals: [PLAIN, ENV_READ] };
  h.runs.push(run);
  assert.match(String((await untracked.call('tower_api', { method: 'POST', path: '/api/runs/outside/approvals/test-1', body: { decision: 'allow' } }) as { error?: string }).error), /찾지 못해/);
  h.owner('옛날 말');
  h.advance(31 * 60_000);
  assert.match((await h.answer(run, ENV_READ.id, { decision: 'allow' })).error ?? '', /소유자가 판단합니다/);
  h.owner('그 세션 승인해');
  h.advance(1000);
  assert.equal((await h.answer(run, ENV_READ.id, { decision: 'allow' })).error, undefined);
});

test('Codex requests travel the same way: their command is read, flagged and answered like Claude\'s', async t => {
  const h = await harness(t);
  const run = await h.handOut('codex-run');
  const encoded: RunApproval = { id: 'rpc/7', toolName: 'Codex command', input: { command: 'rm -rf build', cwd: '/x', commandActions: [] } };
  const plain: RunApproval = { id: 'rpc/8', toolName: 'Codex command', input: { command: 'ls', cwd: '/x' } };
  run.approvals = [encoded, plain];
  await h.session.follow();
  h.advance(APPROVAL_REPORT_DELAY_MS);
  await h.session.follow();
  const prompt = h.reports()[0]!.prompt;
  assert.match(prompt, /owner-only \(deletes\)/);
  assert.match(prompt, /approvals\/rpc%2F8/);
  assert.match((await h.answer(run, encoded.id, { decision: 'allow' })).error ?? '', /소유자가 판단합니다/);
  assert.equal((await h.answer(run, plain.id, { decision: 'allow' })).error, undefined);
  assert.equal(h.answers[0]!.path, '/api/runs/codex-run/approvals/rpc%2F8');
});

test('a joined computer\'s approval is reported and answered through its node while its state arrives; out of reach, nothing is judged', async t => {
  const h = await harness(t);
  const run = await h.handOut('n1', {}, NODE);
  run.approvals = [PLAIN];
  h.nodes!.push({ id: NODE, streaming: false } as NonNullable<Snapshot['nodes']>[number]);
  await h.session.follow();
  h.advance(APPROVAL_OWNER_DEADLINE_MS);
  await h.session.follow();
  assert.equal(h.reports().length, 0, 'what it last sent may be old');
  assert.equal(h.notices.length, 0);

  h.nodes![0]!.streaming = true;
  await h.session.follow();
  h.advance(APPROVAL_REPORT_DELAY_MS);
  await h.session.follow();
  assert.match(h.reports()[0]!.prompt, new RegExp(`session claude:worker on node ${NODE}`));
  assert.match(h.reports()[0]!.prompt, new RegExp(`with node ${NODE}`));

  // Going out of reach settles nothing; back in reach, an answered one does.
  h.nodes![0]!.streaming = false;
  delete run.approvals;
  await h.session.follow();
  h.advance(APPROVAL_OWNER_DEADLINE_MS);
  await h.session.follow();
  assert.equal(h.notices.length, 1, 'still waiting as far as this computer knows');
  assert.equal(h.notices[0]!.sessionId, `@${NODE}/${WORKER}`);

  run.approvals = [ENV_READ];
  h.nodes![0]!.streaming = true;
  await h.session.follow();
  assert.match((await h.answer(run, ENV_READ.id, { decision: 'allow' }, NODE)).error ?? '', /소유자가 판단합니다/);
  run.approvals = [{ ...PLAIN, id: 'p2' }];
  assert.equal((await h.answer(run, 'p2', { decision: 'allow' }, NODE)).error, undefined);
  assert.equal(h.answers[0]!.path, `/api/nodes/${NODE}/runs/n1/approvals/p2`);
});

test('a joined computer lost between first sight and the report gets no report; back in reach, it does', async t => {
  const h = await harness(t);
  const run = await h.handOut('n1', {}, NODE);
  run.approvals = [PLAIN];
  h.nodes!.push({ id: NODE, streaming: true } as NonNullable<Snapshot['nodes']>[number]);
  await h.session.follow();
  h.nodes![0]!.streaming = false;
  h.advance(APPROVAL_REPORT_DELAY_MS);
  await h.session.follow();
  assert.equal(h.reports().length, 0);
  h.nodes![0]!.streaming = true;
  await h.session.follow();
  assert.equal(h.reports().length, 1);
});

test('what the floor marks for the owner, and what it leaves to the master, as requests really arrive', () => {
  const flags = (command: string, toolName = 'Bash') => approvalFlags({ id: 'x', toolName, input: { command } });
  const marked: Array<[string, string, string?]> = [
    [ENV_READ.input.command as string, 'secret'], ['cat ~/.ssh/id_rsa', 'secret'], ['cat ~/.ssh/id_ed25519', 'secret'],
    ['rm -rf /tmp/x', 'delete'], ['git reset --hard HEAD~1', 'delete'], ['psql prod -c "select 1"', 'production'], ['psql prod_db -c "select 1"', 'production'],
    ['git push origin main', 'publish'], ['git -C /repo push origin main', 'publish'], ['git --no-pager push', 'publish'], ['gh pr merge 12', 'publish'], ['npm publish', 'publish'],
    ['curl -X POST https://x.example', 'publish'], ['curl --request PATCH https://x.example', 'publish'], ['curl --json {} https://x.example', 'publish'], ['curl -F a=b https://x.example', 'publish'], ['curl -d\'{}\' https://x.example', 'publish'],
    ['stripe refunds create', 'money'],
    // A command of several lines, as agents usually write them: the line break must not hide the next line's first word.
    ['cd x\ngit push origin main', 'publish'], ['git add .\ngit commit -m x\ngit push', 'publish'], ['cd build\nrm -rf dist', 'delete'], ['npm run build\nnpm publish', 'publish'], ['if x; then\n\trm -rf y\nfi', 'delete'], ['cd x\ncurl -X POST https://x.example', 'publish'],
    // A backslash the agent wrote is not a line break; a separator inside quotes does not end the command.
    ['\\rm -rf dist', 'delete'], ['\\npm publish', 'publish'], ['curl "https://x.example/v1/a?b=1&c=2" -X POST', 'publish'], ['curl -H "Content-Type: application/json; charset=utf-8" -d a=1 https://x', 'publish'],
    // MCP tools are named with underscores.
    ['', 'publish', 'mcp__slack__post_message'], ['', 'publish', 'mcp__claude_ai_Slack__slack_send_message'], ['', 'publish', 'mcp__plugin_discord_discord__reply'], ['', 'money', 'mcp__stripe__create_charge'], ['', 'delete', 'mcp__github__delete_repository'], ['', 'delete', 'mcp__db__drop_table'], ['', 'publish', 'mcp__vercel__deploy_to_vercel'],
  ];
  for (const [command, flag, tool] of marked) assert.ok(flags(command, tool).includes(flag as never), `${tool ?? ''} ${command}`);
  for (const safe of ['npm test', 'ls -la', 'git status', 'git log --oneline', 'curl https://x.example/health', 'cat README.md', 'tsc --noEmit', 'cd x\nnpm test', 'echo process.env.HOME']) assert.deepEqual(flags(safe), [], safe);
  assert.deepEqual(approvalFlags({ id: 'x', toolName: 'mcp__tower_todos__todos_list', input: {} }), []);
  // A grant for the rest of the turn is the owner's, whatever it says.
  assert.deepEqual(approvalFlags({ id: 'x', toolName: 'Codex permissions', input: { network: { enabled: true } }, scope: 'turn' }), ['scope']);
});

test('both guides tell masters how to take a waiting request', () => {
  for (const guide of [masterGuide(), todoMasterGuide('t1')]) {
    assert.match(guide, /waiting for an approval/);
    assert.match(guide, /Never deny on your own/);
    assert.match(guide, /untrusted/);
  }
  assert.match(todoMasterGuide('t1'), /todos_comment/);
});
