import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveState } from '../../server/tower-tools/live-state.js';
import { MasterRoom } from '../../server/master/room.js';
import { MasterSession } from '../../server/master/session.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { TowerClient } from '../../server/tower-tools/tower-client.js';
import type { AutoPromptJob, ChatMessage, Run, SessionOutcome, Snapshot } from '../../shared/types.js';

const MASTER = 'claude:master';

/** Tower as the master session sees it, with sessions, runs and Auto Prompt jobs the test changes as it goes. */
async function harness(t: test.TestContext, options: { bound?: boolean; createStatus?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-session-'));
  const cleanup: Array<() => unknown> = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await rm(dir, { recursive: true, force: true }); });
  const runs: Run[] = [];
  const jobs: AutoPromptJob[] = [];
  const outcomes = new Map<string, SessionOutcome>();
  const histories = new Map<string, { updatedAt: string; messages: ChatMessage[] }>();
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  let clock = Date.now();
  const tick = () => new Date(clock += 1000).toISOString();
  const history = (id: string) => { let known = histories.get(id); if (!known) histories.set(id, known = { updatedAt: tick(), messages: [] }); return known; };
  const finish = (run: Run, answer: string, status: Run['status'] = 'completed') => {
    const kept = history(run.sessionId);
    kept.messages.push({ id: randomUUID(), role: 'user', text: run.prompt, timestamp: tick() }, { id: randomUUID(), role: 'assistant', text: answer, timestamp: tick() });
    run.status = status; run.finishedAt = tick(); kept.updatedAt = tick();
  };
  let messageStatus = 202;
  let pageSize = 200;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url!, 'http://x');
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
    if (req.method === 'POST') posted.push({ path: url.pathname, body });
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      if (options.createStatus) { res.writeHead(options.createStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'no' })); return; }
      const run: Run = { id: `r${runs.length + 1}`, sessionId: MASTER, prompt: String(body.prompt), status: 'running', createdAt: tick(), output: '' };
      runs.push(run);
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ session: { id: MASTER }, run }));
      return;
    }
    const message = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (req.method === 'POST' && message) {
      if (messageStatus !== 202) { res.writeHead(messageStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'busy', ...(messageStatus === 503 ? { disposition: 'not-admitted' } : {}) })); return; }
      const run: Run = { id: `r${runs.length + 1}`, sessionId: decodeURIComponent(message[1]), prompt: String(body.prompt), status: 'running', createdAt: tick(), output: '' };
      runs.push(run);
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ run }));
      return;
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]);
      const kept = history(id);
      const before = url.searchParams.get('before');
      const end = before === null ? kept.messages.length : Number(before);
      const start = Math.max(0, end - pageSize);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ session: { id, updatedAt: kept.updatedAt, status: 'completed', lastRequestAt: kept.messages.findLast(item => item.role === 'user')?.timestamp, lastMessage: kept.messages.at(-1)?.text.replace(/\s+/g, ' ').trim().slice(0, 180), messageCount: kept.messages.length, outcome: outcomes.get(id) }, messages: kept.messages.slice(start, end), hasMore: start > 0, ...(start > 0 ? { nextBefore: start } : {}) }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  if (options.bound) await settings.bind({ sessionId: MASTER, provider: 'claude', startedAt: new Date().toISOString() });
  const room = new MasterRoom(join(dir, 'voice'));
  await room.start();
  const tower = new TowerClient(2_000);
  tower.setCredentials({ port: (server.address() as { port: number }).port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const snapshot = (): Snapshot => ({ sessions: [], runs, autoPrompts: jobs, providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' });
  const live = { fresh: async () => snapshot(), snapshot, node: () => undefined } as unknown as LiveState;
  const open = async () => {
    const session = new MasterSession({ stateDir: dir, dataDir: dir, settings, tower, live, room, followMs: 60_000, reportRetryMs: 1 });
    await session.start();
    cleanup.push(async () => { await session.close(); await room.flush(); });
    return session;
  };
  const session = await open();
  // Reports Tower took: each became a turn of the master session.
  const reports = () => runs.filter(run => run.sessionId === MASTER && run.prompt.startsWith('[Tower report]')).map(run => ({ body: { prompt: run.prompt } }));
  return { dir, session, settings, runs, jobs, posted, finish, reports, open, tick, history, outcomes, setMessageStatus: (status: number) => { messageStatus = status; }, setPageSize: (size: number) => { pageSize = size; } };
}

test('the first message starts the master session in its own folder, with its guide; a second start needs "replace"', async t => {
  const h = await harness(t);
  const binding = await h.session.begin({ provider: 'claude', text: '안녕', model: 'opus' });
  assert.equal(binding.sessionId, MASTER);
  assert.deepEqual(h.posted[0], { path: '/api/sessions', body: { provider: 'claude', cwd: join(h.dir, 'master-session'), prompt: '안녕', title: '마스터', model: 'opus' } });
  assert.match(await readFile(join(h.dir, 'master-session', 'AGENTS.md'), 'utf8'), /master agent of Agent Session Tower/);
  assert.equal(h.settings.current().session?.sessionId, MASTER);
  await assert.rejects(h.session.begin({ provider: 'codex', text: '또' }), { statusCode: 409 });
  await h.session.begin({ provider: 'codex', text: '새로', replace: true });
  assert.equal(h.settings.current().session?.provider, 'codex');
  await h.session.release();
  assert.equal(h.settings.current().session, undefined);
});

test('a start Tower refused is not bound, so the owner can try again', async t => {
  const h = await harness(t, { createStatus: 400 });
  await assert.rejects(h.session.begin({ provider: 'claude', text: '안녕' }), /시작하지 못했습니다: no/);
  assert.equal(h.settings.current().session, undefined);
});

test('work the master handed out through Tower\'s tools is followed and reported once, with its answer; earlier work is not', async t => {
  const h = await harness(t, { bound: true });
  // Work from before the master existed is not its to report.
  const before: Run = { id: 'old', sessionId: 'codex:old', prompt: 'old work', status: 'completed', createdAt: new Date(Date.now() - 60_000).toISOString(), output: '', origin: { kind: 'agent', runId: 'r1' } };
  h.runs.push(before);
  const turn: Run = { id: 'r1', sessionId: MASTER, prompt: 'monitor 버그 고쳐줘', status: 'running', createdAt: h.tick(), output: '' };
  h.runs.push(turn);
  await h.session.follow();
  // The master's turn hands work out (autoPrompt_submit): a job, then its run.
  const job: AutoPromptJob = { id: 'job-1', provider: 'codex', prompt: 'fix the login bug', routerModel: 'r', status: 'routing', createdAt: h.tick(), updatedAt: h.tick(), origin: { kind: 'agent', runId: 'r1' } };
  h.jobs.push(job);
  await h.session.follow();
  assert.equal(h.session.activeTasks(), 1);
  const work: Run = { id: 'w1', sessionId: 'codex:work', prompt: 'fix the login bug', status: 'running', createdAt: h.tick(), output: '', origin: { kind: 'agent', runId: 'r1' } };
  h.runs.push(work);
  Object.assign(job, { status: 'completed', runId: 'w1', sessionId: 'codex:work' });
  await h.session.follow();
  assert.equal(h.session.activeTasks(), 1, 'the job and its run are one piece of work');
  h.finish(work, 'Fixed the login bug.');
  await h.session.follow();
  const [report] = h.reports();
  assert.match(String(report.body.prompt), /^\[Tower report\] Work you handed out ended \(report [0-9a-f]{8}\):\n- "fix the login bug" — completed \(session codex:work\)\n  Its answer:\n    Fixed the login bug\./);
  await h.session.follow();
  await h.session.follow();
  assert.equal(h.reports().length, 1, 'reported once');
  assert.equal(h.session.activeTasks(), 0);
  assert.deepEqual(h.session.delegatedTable().rows.map(row => [row[1], row[2]]), [['fix the login bug', 'completed']]);
});

test('an Auto Prompt that fails before any run is reported as such, and a report Tower refused is sent again later', async t => {
  const h = await harness(t, { bound: true });
  h.runs.push({ id: 'r1', sessionId: MASTER, prompt: 'x', status: 'running', createdAt: h.tick(), output: '' });
  await h.session.follow();
  h.jobs.push({ id: 'job-2', provider: 'codex', prompt: 'deploy it', routerModel: 'r', status: 'error', createdAt: h.tick(), updatedAt: h.tick(), origin: { kind: 'agent', runId: 'r1' } });
  h.setMessageStatus(400);
  await h.session.follow();
  await h.session.follow();
  assert.equal(h.reports().length, 0);
  h.setMessageStatus(202);
  await h.session.follow();
  assert.equal(h.reports().length, 1);
  assert.match(String(h.reports()[0].body.prompt), /"deploy it" — error/);
});

test('work a tower_api call started is followed too; a report cut off by a restart is found in the master session, or sent again only when surely missing', async t => {
  const h = await harness(t, { bound: true });
  await h.session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: 'write docs', title: 'Docs' }, { session: { id: 'claude:docs' }, run: { id: 'd1' } });
  await h.session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: 'write tests', title: 'Tests' }, { session: { id: 'claude:tests' }, run: { id: 'd2' } });
  // A message to the master session itself is its own conversation.
  await h.session.started({ method: 'POST', path: '/api/sessions/claude%3Amaster/messages', route: '', local: `/api/sessions/${encodeURIComponent(MASTER)}/messages`, write: true }, { prompt: 'x' }, { run: { id: 'm9', sessionId: MASTER } });
  assert.equal(h.session.activeTasks(), 2);
  for (const [id, session, prompt] of [['d1', 'claude:docs', 'write docs'], ['d2', 'claude:tests', 'write tests']]) {
    const run: Run = { id, sessionId: session, prompt, status: 'running', createdAt: h.tick(), output: '' };
    h.runs.push(run);
    h.finish(run, 'Done.');
  }
  // Both reports were being sent when the host stopped: one reached the master session, the other did not.
  const saved = join(h.dir, 'follow.json');
  const file = JSON.parse(await readFile(saved, 'utf8')) as { followed: Array<{ state: string; report?: string; reportId?: string; reportAt?: string }> };
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  Object.assign(file.followed[0], { state: 'completed', report: 'sending', reportId: 'aaaa1111', reportAt: old });
  Object.assign(file.followed[1], { state: 'completed', report: 'sending', reportId: 'bbbb2222', reportAt: old });
  h.runs.push({ id: 'arrived', sessionId: MASTER, prompt: '[Tower report] Work you handed out ended (report aaaa1111):\n- "Docs" — completed', status: 'queued', createdAt: h.tick(), output: '' });
  await h.session.close();
  const { writePrivateJson } = await import('../../server/stores/private-json.js');
  await writePrivateJson(saved, JSON.stringify(file));
  const again = await h.open();
  assert.equal(again.activeTasks(), 2, 'a report in doubt still counts');
  await again.follow();
  await again.follow();
  const resent = h.reports().filter(report => report.body.prompt !== h.runs.find(run => run.id === 'arrived')!.prompt);
  assert.equal(resent.length, 1, 'only the report that never arrived goes again');
  assert.match(String(resent[0].body.prompt), /"Tests" — completed/);
  assert.equal(again.activeTasks(), 0);
});

test('many reports at once go in messages a session takes, never one too large', async t => {
  const h = await harness(t, { bound: true });
  for (let index = 0; index < 12; index++) {
    const id = `big${index}`;
    await h.session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: `task ${index}` }, { session: { id: `claude:${id}` }, run: { id } });
    const run: Run = { id, sessionId: `claude:${id}`, prompt: `task ${index}`, status: 'running', createdAt: h.tick(), output: '' };
    h.runs.push(run);
    h.finish(run, 'x'.repeat(2900));
  }
  await h.session.follow();
  const reports = h.reports();
  assert.ok(reports.length >= 2);
  assert.ok(reports.every(report => String(report.body.prompt).length < 32_000));
  assert.equal(reports.map(report => (String(report.body.prompt).match(/^- "/gm) ?? []).length).reduce((sum, count) => sum + count, 0), 12);
});

test('a report Tower keeps refusing is tried less and less often, then shown as failed instead of forever', async t => {
  const h = await harness(t, { bound: true });
  await h.session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: 'lost' }, { session: { id: 'claude:lost' }, run: { id: 'l1' } });
  const run: Run = { id: 'l1', sessionId: 'claude:lost', prompt: 'lost', status: 'running', createdAt: h.tick(), output: '' };
  h.runs.push(run);
  h.finish(run, 'Done.');
  h.setMessageStatus(404);
  for (let round = 0; round < 60 && h.session.failedReports() === 0; round++) { await h.session.follow(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(h.session.failedReports(), 1);
  assert.equal(h.session.activeTasks(), 0);
  const tries = h.posted.filter(item => String(item.body.prompt).startsWith('[Tower report]')).length;
  assert.equal(tries, 8, 'given up after eight refusals');
});

test('a report Tower could not take just then (a web or worker changing over) waits without counting a try', async t => {
  const h = await harness(t, { bound: true });
  await h.session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: 'held' }, { session: { id: 'claude:held' }, run: { id: 'h1' } });
  const run: Run = { id: 'h1', sessionId: 'claude:held', prompt: 'held', status: 'running', createdAt: h.tick(), output: '' };
  h.runs.push(run);
  h.finish(run, 'Done.');
  h.setMessageStatus(503);
  for (let round = 0; round < 20; round++) { await h.session.follow(); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(h.session.failedReports(), 0);
  assert.equal(h.session.activeTasks(), 1);
  h.setMessageStatus(202);
  await new Promise(resolve => setTimeout(resolve, 5));
  await h.session.follow();
  assert.equal(h.reports().length, 1);
});

test('a spoken request whose sending is in doubt is not sent again by its key; a refused one can be said again', async t => {
  const h = await harness(t, { bound: true });
  h.setMessageStatus(500);
  await assert.rejects(h.session.spoken({ text: '배포해 줘', voiceSession: 'v', key: 'k1' }));
  await h.session.spoken({ text: '배포해 줘', voiceSession: 'v', key: 'k1' });
  assert.equal(h.posted.filter(item => String(item.body.prompt).includes('배포해 줘')).length, 1, 'not sent twice');
  h.setMessageStatus(400);
  await assert.rejects(h.session.spoken({ text: '다른 요청', voiceSession: 'v', key: 'k2' }));
  h.setMessageStatus(202);
  await h.session.spoken({ text: '다른 요청', voiceSession: 'v', key: 'k2' });
  assert.equal(h.runs.filter(run => run.prompt === '[voice] 다른 요청').length, 1);
});

test('a report in doubt is looked for back through the history to when it was sent, pages included', async t => {
  const h = await harness(t, { bound: true });
  await h.session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: 'paged' }, { session: { id: 'claude:paged' }, run: { id: 'p1' } });
  const run: Run = { id: 'p1', sessionId: 'claude:paged', prompt: 'paged', status: 'running', createdAt: h.tick(), output: '' };
  h.runs.push(run);
  h.finish(run, 'Done.');
  const saved = join(h.dir, 'follow.json');
  const file = JSON.parse(await readFile(saved, 'utf8')) as { followed: Array<Record<string, unknown>> };
  const sentAt = Date.now() - 5 * 60_000;
  Object.assign(file.followed[0], { state: 'completed', report: 'uncertain', reportId: 'cccc3333', reportAt: new Date(sentAt).toISOString() });
  // It arrived (its run is gone from the list), and many messages came after it.
  const kept = h.history(MASTER);
  kept.messages.push({ id: randomUUID(), role: 'user', text: '[Tower report] Work you handed out ended (report cccc3333):\n- "paged" — completed', timestamp: new Date(sentAt + 1000).toISOString() });
  for (let index = 0; index < 30; index++) kept.messages.push({ id: randomUUID(), role: index % 2 ? 'assistant' : 'user', text: `later ${index}`, timestamp: new Date(sentAt + 2000 + index * 1000).toISOString() });
  h.setPageSize(10);
  await h.session.close();
  const { writePrivateJson } = await import('../../server/stores/private-json.js');
  await writePrivateJson(saved, JSON.stringify(file));
  const again = await h.open();
  await again.follow();
  assert.equal(h.reports().length, 0, 'found on an older page, so not sent again');
  assert.equal(again.activeTasks(), 0);
});

test('a request steered into a turn takes that turn\'s answer, even when a later turn repeats an earlier request', async t => {
  const h = await harness(t, { bound: true });
  await h.session.spoken({ text: 'A', voiceSession: 'v', key: 'ka' });
  await h.session.spoken({ text: 'B', voiceSession: 'v', key: 'kb' });
  await h.session.spoken({ text: 'A', voiceSession: 'v', key: 'ka2' });
  const [first, second, third] = h.runs;
  // Minutes apart, as they would be: the first turn answers A and B, a later turn answers A again.
  const at = (minutes: number) => new Date(Date.now() - (30 - minutes) * 60_000).toISOString();
  Object.assign(first, { createdAt: at(0), startedAt: at(0) });
  Object.assign(second, { createdAt: at(1), steering: { targetRunId: first.id, state: 'delivered', requestedAt: at(1), deliveredAt: at(1) } });
  Object.assign(third, { createdAt: at(10), startedAt: at(10) });
  const kept = h.history(MASTER);
  kept.messages.push({ id: randomUUID(), role: 'user', text: first.prompt, timestamp: at(0) }, { id: randomUUID(), role: 'user', text: second.prompt, timestamp: at(1) },
    { id: randomUUID(), role: 'assistant', text: 'A와 B를 했습니다.', timestamp: at(2) },
    { id: randomUUID(), role: 'user', text: third.prompt, timestamp: at(10) }, { id: randomUUID(), role: 'assistant', text: 'A를 다시 했습니다.', timestamp: at(11) });
  for (const [run, done] of [[first, 2], [second, 2], [third, 11]] as const) { run.status = 'completed'; run.finishedAt = at(done); }
  kept.updatedAt = at(12);
  await h.session.follow();
  const saved = JSON.parse(await readFile(join(h.dir, 'follow.json'), 'utf8')) as { followed: Array<{ runId?: string; answer?: string }> };
  const answer = (run: Run) => saved.followed.find(item => item.runId === run.id)?.answer;
  assert.equal(answer(second), 'A와 B를 했습니다.');
  assert.equal(answer(third), 'A를 다시 했습니다.');
});

test('a spoken request in doubt keeps its key however much else is followed since', async t => {
  const h = await harness(t, { bound: true });
  h.setMessageStatus(500);
  await assert.rejects(h.session.spoken({ text: '한 번만', voiceSession: 'v', key: 'once' }));
  h.setMessageStatus(202);
  for (let index = 0; index < 320; index++) {
    const id = `many${index}`;
    await h.session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: id }, { session: { id: `claude:${id}` }, run: { id } });
    const run: Run = { id, sessionId: `claude:${id}`, prompt: id, status: 'completed', createdAt: h.tick(), finishedAt: h.tick(), output: '' };
    h.runs.push(run);
  }
  await h.session.follow();
  await h.session.spoken({ text: '한 번만', voiceSession: 'v', key: 'once' });
  assert.equal(h.posted.filter(item => String(item.body.prompt).includes('한 번만')).length, 1);
});

test('a project hands the next step to another project: the root master follows and reports that step after restart', async t => {
  const h = await harness(t, { bound: true });
  const summary: Run = { id: 'summary-run', sessionId: 'codex:summary', prompt: 'deploy summary then start secrets', status: 'running', createdAt: h.tick(), output: '' };
  h.runs.push(summary);
  await h.session.started({ method: 'POST', path: '/api/sessions/codex:summary/messages', route: '/api/sessions/:id/messages', local: '/api/sessions/codex:summary/messages', write: true }, { prompt: summary.prompt }, { run: summary });
  h.finish(summary, 'Summary deployed; secrets started.');
  await h.session.follow();
  assert.equal(h.reports().length, 1);
  await h.session.close();
  const restarted = await h.open();
  const secrets: Run = { id: 'secrets-run', sessionId: 'codex:secrets', prompt: 'implement, verify and deploy secrets', status: 'running', createdAt: h.tick(), output: '', origin: { kind: 'agent', runId: summary.id } };
  h.runs.unshift(secrets);
  await restarted.follow();
  assert.equal(restarted.activeTasks(), 1, 'the summary report is not the end of the owner’s multistep goal');
  h.finish(secrets, 'Implementation and CI passed. Waiting for a browser; not deployed.');
  await restarted.follow();
  await restarted.follow();
  assert.equal(h.reports().length, 2, 'one report for each step, including the unfinished goal');
  assert.match(h.reports()[1].body.prompt, /Waiting for a browser; not deployed/);
});

test('authenticated lineage is independent of authority, snapshot order and pruned intermediate runs', async t => {
  const h = await harness(t, { bound: true });
  const root = randomUUID();
  await h.session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: 'summary' }, { session: { id: 'codex:summary' }, run: { id: root } });
  const middle: Run = { id: randomUUID(), sessionId: 'codex:middle', prompt: 'middle', status: 'running', createdAt: h.tick(), output: '', origin: { kind: 'owner' }, delegation: { parentRunId: root, rootRunId: root } };
  const end: Run = { id: randomUUID(), sessionId: 'codex:end', prompt: 'end', status: 'running', createdAt: h.tick(), output: '', origin: { kind: 'owner' }, delegation: { parentRunId: middle.id, rootRunId: root } };
  h.runs.push(end, middle);
  await h.session.follow();
  assert.equal(h.session.delegatedTable().rows.length, 3);
  await h.session.close();
  h.runs.splice(h.runs.indexOf(middle), 1);
  const restarted = await h.open();
  h.finish(end, 'Access denied; deployment is blocked.');
  h.outcomes.set(end.sessionId, 'blocked');
  await restarted.follow();
  await restarted.follow();
  assert.equal(h.reports().length, 1);
  assert.match(h.reports()[0].body.prompt, /Goal outcome: blocked/);
  assert.match(h.reports()[0].body.prompt, /Execution completed is not proof/);
});

test('legacy nested delegation closure handles reversed runs and jobs without duplicate reports', async t => {
  const h = await harness(t, { bound: true });
  const master: Run = { id: 'master-turn', sessionId: MASTER, prompt: 'three steps', status: 'completed', createdAt: h.tick(), output: '' };
  const one: Run = { id: 'one', sessionId: 'codex:one', prompt: 'one', status: 'running', createdAt: h.tick(), output: '', origin: { kind: 'agent', runId: master.id } };
  const two: Run = { id: 'two', sessionId: 'codex:two', prompt: 'two', status: 'running', createdAt: h.tick(), output: '', origin: { kind: 'agent', runId: one.id } };
  const three: Run = { id: 'three', sessionId: 'codex:three', prompt: 'three', status: 'running', createdAt: h.tick(), output: '', origin: { kind: 'agent', runId: two.id } };
  h.jobs.push({ id: 'job-two', provider: 'codex', prompt: two.prompt, routerModel: '', status: 'completed', createdAt: two.createdAt, updatedAt: two.createdAt, origin: two.origin, runId: two.id, sessionId: two.sessionId });
  h.runs.push(three, two, one, master);
  await h.session.follow();
  await h.session.follow();
  assert.equal(h.session.activeTasks(), 3, 'job two and run two are the same delegation');
  for (const run of [one, two, three]) h.finish(run, 'Done');
  await h.session.follow();
  assert.equal(h.session.delegatedTable().rows.length, 3);
  assert.equal(h.reports().length, 1, 'one batch with three distinct results');
});

test('goal outcomes are separate from a completed run; a later turn cannot lend its done outcome', async t => {
  const h = await harness(t, { bound: true });
  for (const outcome of ['done', 'needsOwner', 'blocked', 'progress', undefined] as const) {
    const run: Run = { id: randomUUID(), sessionId: `codex:${outcome}`, prompt: `work ${outcome}`, status: 'running', createdAt: h.tick(), output: '' };
    h.runs.push(run);
    await h.session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: run.prompt }, { session: { id: run.sessionId }, run });
    h.finish(run, outcome === 'needsOwner' ? 'Real approval required.' : String(outcome));
    if (outcome) h.outcomes.set(run.sessionId, outcome);
  }
  const old = h.runs[0];
  const later: Run = { id: randomUUID(), sessionId: old.sessionId, prompt: 'another goal', status: 'running', createdAt: h.tick(), output: '' };
  h.finish(later, 'The other goal is done.');
  await h.session.follow();
  const table = h.session.delegatedTable();
  const outcomeColumn = table.columns.indexOf('outcome');
  assert.deepEqual(table.rows.map(row => row[outcomeColumn]), [null, 'needsOwner', 'blocked', 'progress', null]);
  assert.match(h.reports()[0].body.prompt, /unknown \(not yet verified\)/);
  assert.match(h.reports()[0].body.prompt, /respect real approval waits and owner stops/);
});

test('an owner-stopped master holds reports across restart until a new owner instruction; cancelled children stay cancelled', async t => {
  const h = await harness(t, { bound: true });
  const master: Run = { id: 'stopped-master', sessionId: MASTER, prompt: 'stop here', ownerStopped: true, status: 'running', createdAt: h.tick(), output: '' };
  const child: Run = { id: 'cancelled-child', sessionId: 'codex:child', prompt: 'work', status: 'running', createdAt: h.tick(), output: '', origin: { kind: 'agent', runId: master.id } };
  h.runs.push(master, child);
  h.finish(child, 'Owner stopped this task.', 'cancelled');
  h.finish(master, 'Stopped.', 'cancelled');
  h.runs.push({ id: randomUUID(), sessionId: MASTER, prompt: 'Permission continuation', status: 'cancelled', createdAt: h.tick(), output: '', origin: { kind: 'owner' },
    scheduled: { at: h.tick(), afterRunId: master.id, resume: 'permission' } });
  await h.session.follow();
  assert.equal(h.reports().length, 0);
  await h.session.close();
  h.runs.splice(h.runs.indexOf(master), 1);
  const restarted = await h.open();
  await restarted.follow();
  assert.equal(h.reports().length, 0, 'persisted hold does not disappear when the cancelled run is pruned');
  h.runs.push({ id: 'owner-resumed', sessionId: MASTER, prompt: 'show the results', status: 'running', createdAt: h.tick(), output: '', origin: { kind: 'owner' } });
  await restarted.follow();
  assert.equal(h.reports().length, 1);
  assert.equal(child.status, 'cancelled');
  assert.equal(h.runs.filter(run => run.sessionId === child.sessionId).length, 1);
});

test('a delegated message inserted into an existing turn keeps that turn’s later delegations linked', async t => {
  const h = await harness(t, { bound: true });
  const inserted: Run = { id: 'inserted-work', sessionId: 'codex:project', prompt: 'continue and hand off', status: 'running', createdAt: h.tick(), output: '',
    steering: { targetRunId: 'actual-provider-turn', state: 'delivered', requestedAt: h.tick(), deliveredAt: h.tick() } };
  h.runs.push(inserted);
  await h.session.started({ method: 'POST', path: '/api/sessions/codex:project/messages', route: '/api/sessions/codex:project/messages', local: '/api/sessions/codex:project/messages', write: true }, { prompt: inserted.prompt }, { run: inserted });
  await h.session.follow();
  await h.session.close();
  h.runs.length = 0;
  const next: Run = { id: 'next-after-insert', sessionId: 'codex:next', prompt: 'finish deployment', status: 'running', createdAt: h.tick(), output: '',
    origin: { kind: 'agent', runId: 'actual-provider-turn' } };
  h.runs.push(next);
  const restarted = await h.open();
  await restarted.follow();
  assert.equal(restarted.delegatedTable().rows.length, 2);
  h.finish(next, 'Needs a real approval.');
  await restarted.follow();
  assert.equal(h.reports().length, 1);
});

test('a permission continuation arriving after a completion report is still followed once', async t => {
  const h = await harness(t, { bound: true });
  const parent: Run = { id: randomUUID(), sessionId: 'codex:approval', prompt: 'Deploy the verified change', status: 'running', createdAt: h.tick(), output: '' };
  h.runs.push(parent);
  await h.session.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: parent.prompt }, { session: { id: parent.sessionId }, run: parent });
  h.finish(parent, 'Waiting for the required rule.');
  await h.session.follow();
  assert.equal(h.reports().length, 1);
  const continuation: Run = { ...parent, id: randomUUID(), prompt: 'Approval applies from this turn', status: 'queued', createdAt: h.tick(), finishedAt: undefined,
    scheduled: { at: h.tick(), afterRunId: parent.id, resume: 'permission' } };
  h.runs.push(continuation);
  await h.session.follow();
  assert.equal(h.session.activeTasks(), 1);
  assert.equal(h.reports().length, 1);
  continuation.status = 'running';
  await h.session.follow();
  h.finish(continuation, 'Deployment verified.');
  await h.session.follow();
  await h.session.follow();
  assert.equal(h.reports().length, 2);
  assert.equal(h.session.delegatedTable().rows.length, 1, 'the continuation is the same delegated goal');
  assert.match(h.reports()[1].body.prompt, /Deployment verified/);
});

test('a master report cancelled by worker recovery does not stop later goal reports', async t => {
  const h = await harness(t, { bound: true });
  const root: Run = { id: randomUUID(), sessionId: MASTER, prompt: 'Implement the goal', status: 'completed', createdAt: h.tick(), output: '' };
  const recovered: Run = { id: randomUUID(), sessionId: MASTER, prompt: '[Tower report] earlier result', status: 'cancelled', createdAt: h.tick(), finishedAt: h.tick(), output: '', error: 'Tower restarted before this run started.' };
  const child: Run = { id: randomUUID(), sessionId: 'codex:child', prompt: 'Finish deployment', status: 'running', createdAt: h.tick(), output: '', origin: { kind: 'agent', runId: root.id } };
  h.runs.push(root, recovered, child);
  h.finish(child, 'Deployment verified');
  await h.session.follow();
  assert.equal(h.reports().length, 2, 'one recovered record and one newly delivered report');
  assert.match(h.reports()[1].body.prompt, /Deployment verified/);
});
