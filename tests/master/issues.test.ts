import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveState } from '../../server/tower-tools/live-state.js';
import { IssueMasters } from '../../server/master/issues.js';
import { KEEP_CLOSED_MS } from '../../server/master/issue-files.js';
import { MasterClient } from '../../server/master/client.js';
import { MasterRoom } from '../../server/master/room.js';
import { MasterSession } from '../../server/master/session.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { MasterScreen, MasterTools } from '../../server/master/tools.js';
import { masterPaths } from '../../server/master/paths.js';
import type { ReadDatabase } from '../../server/tower-tools/read-db.js';
import { startMasterHost } from '../../server/master/host.js';
import { startMasterMcp, type MasterMcpInstance } from '../../server/master/mcp.js';
import { PassThrough } from 'node:stream';
import { temporaryFixture, removeTemporaryFixture } from '../helpers/temporary.js';
import { until } from '../helpers/until.js';
import { TowerClient } from '../../server/tower-tools/tower-client.js';
import type { ChatMessage, Run, Session, Snapshot } from '../../shared/types.js';
import '../helpers/skip-fsync.js';

const MAIN = 'claude:main';
const SECRET = 'b'.repeat(64);

/**
 * Tower as the masters see it: the main master and issue masters in `<state>/todo-masters/<taskId>`, with sessions and
 * runs the test changes as it goes. A message posted with a calling turn's credential is recorded as that turn's work.
 */
async function harness(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-issue-masters-'));
  const data = join(dir, 'master');
  const cleanup: Array<() => unknown> = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await rm(dir, { recursive: true, force: true }); });
  const sessions: Session[] = [];
  const runs: Run[] = [];
  const histories = new Map<string, { updatedAt: string; messages: ChatMessage[] }>();
  const headers: Array<{ path: string; capability?: string; master?: string; issue?: string }> = [];
  /** Messages to sessions are refused while set. */
  let refuse = false;
  /** Messages to sessions are answered only once this settles. */
  let paused: Promise<void> | undefined;
  let clock = Date.now();
  const tick = () => new Date(clock += 1000).toISOString();
  const history = (id: string) => { let known = histories.get(id); if (!known) histories.set(id, known = { updatedAt: tick(), messages: [] }); return known; };
  const finish = (run: Run, answer: string) => {
    const kept = history(run.sessionId);
    kept.messages.push({ id: randomUUID(), role: 'user', text: run.prompt, timestamp: tick() }, { id: randomUUID(), role: 'assistant', text: answer, timestamp: tick() });
    run.status = 'completed'; run.finishedAt = tick(); kept.updatedAt = tick();
  };
  const turn = (sessionId: string, prompt: string, delegation?: Run['delegation']): Run => {
    const run: Run = { id: randomUUID(), sessionId, prompt, status: 'running', createdAt: tick(), output: '', origin: { kind: 'owner' }, ...(delegation ? { delegation } : {}) };
    runs.push(run);
    return run;
  };
  /** The delegation the web records for work a calling turn started (`delegationOf`). */
  const from = (caller: Run): Run['delegation'] => ({ parentRunId: caller.id, rootRunId: caller.delegation?.rootRunId ?? caller.id });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url!, 'http://x');
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
    const sent = (name: string) => typeof req.headers[name] === 'string' ? req.headers[name] as string : undefined;
    if (req.method === 'POST') headers.push({ path: url.pathname, ...Object.fromEntries(([['capability', 'x-tower-run-capability'], ['master', 'x-tower-master'], ['issue', 'x-tower-issue']] as const).flatMap(([key, name]) => sent(name) ? [[key, sent(name)]] : [])) });
    const message = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (req.method === 'POST' && message) await paused;
    if (req.method === 'POST' && message && refuse) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'busy' })); return; }
    if (req.method === 'POST' && (message || url.pathname === '/api/sessions')) {
      const run = turn(message ? decodeURIComponent(message[1]) : `codex:${randomUUID().slice(0, 6)}`, String(body.prompt));
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify(message ? { run } : { session: { id: run.sessionId }, run }));
      return;
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]);
      const kept = history(id);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ session: { id, updatedAt: kept.updatedAt, status: 'completed', messageCount: kept.messages.length }, messages: kept.messages, hasMore: false }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const tower = new TowerClient(2_000);
  tower.setCredentials({ port: (server.address() as { port: number }).port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const snapshot = (): Snapshot => ({ sessions, runs, autoPrompts: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' });
  /** The next look at Tower waits for this, once. */
  let held: Promise<void> | undefined;
  const live = { fresh: async () => { const wait = held; held = undefined; await wait; return snapshot(); }, snapshot, node: () => undefined } as unknown as LiveState;
  const hold = () => { let release!: () => void; held = new Promise<void>(resolve => { release = resolve; }); return release; };
  const settings = new MasterSettingsStore(data);
  await mkdir(data, { recursive: true });
  await settings.start();
  await settings.bind({ sessionId: MAIN, provider: 'claude', startedAt: new Date().toISOString() });
  const room = new MasterRoom(join(data, 'voice'));
  await room.start();
  let main: MasterSession | undefined;
  const openIssues = () => {
    const opened = new IssueMasters({ stateDir: dir, dataDir: data, tower, live, screen: new MasterScreen({ broadcast: () => {} }), main: { binding: () => main?.binding() }, followMs: 60_000, reportRetryMs: 1 });
    cleanup.push(() => opened.close());
    return opened;
  };
  let issues = openIssues();
  // The main master tells the first registry of its turns; a registry opened later is told by its own masters only.
  const first = issues;
  main = new MasterSession({ stateDir: dir, dataDir: data, settings, tower, live, room, followMs: 60_000, reportRetryMs: 1,
    otherMaster: { session: id => issues.masterSession(id), run: id => issues.masterRun(id) }, turns: first.turnsOf() });
  await main.start();
  cleanup.push(async () => { await main.close(); await room.flush(); });
  const issueSession = (taskId: string, extra: Partial<Session> = {}): Session => {
    const session: Session = { id: `claude:${taskId}-${randomUUID().slice(0, 4)}`, nativeId: randomUUID(), provider: 'claude', title: '이슈', cwd: join(dir, 'todo-masters', taskId), project: 'x',
      status: 'idle', statusReason: '', createdAt: tick(), updatedAt: tick(), lastMessage: '', messageCount: 0, isSubagent: false, resumable: true, ...extra };
    sessions.push(session);
    return session;
  };
  const reports = (sessionId: string) => runs.filter(run => run.sessionId === sessionId && run.prompt.startsWith('[Tower report]')).map(run => run.prompt);
  const follow = async () => { await issues.refresh(); await main.follow(); for (const id of ['task-a', 'task-b']) await issues.get(id)?.follow(); };
  return { dir, data, tower, sessions, runs, headers, tick, turn, from, finish, main: main!, issues: () => issues, reopen: () => { issues = openIssues(); return issues; }, issueSession, reports, follow, hold, refuse: (value: boolean) => { refuse = value; },
    pause: () => { let release!: () => void; paused = new Promise<void>(resolve => { release = resolve; }); return () => { paused = undefined; release(); }; } };
}

test('each issue master follows its own work and reports to its own session, apart from the main master and each other', async t => {
  const h = await harness(t);
  const a = h.issueSession('task-a');
  const b = h.issueSession('task-b');
  await h.issues().refresh();
  assert.equal(h.issues().size(), 2);
  assert.match(await readFile(join(h.dir, 'todo-masters', 'task-a', 'AGENTS.md'), 'utf8'), /Issue master of Agent Session Tower[\s\S]*`task-a`/, 'its guide is written into its folder');
  const mainTurn = h.turn(MAIN, '메인 일');
  const aTurn = h.turn(a.id, 'A 일');
  const bTurn = h.turn(b.id, 'B 일');
  const forMain = h.turn('codex:main-work', 'main work', h.from(mainTurn));
  const forA = h.turn('codex:a-work', 'a work', h.from(aTurn));
  const forB = h.turn('codex:b-work', 'b work', h.from(bTurn));
  await h.follow();
  assert.deepEqual([h.main.activeTasks(), h.issues().get('task-a')!.activeTasks(), h.issues().get('task-b')!.activeTasks()], [1, 1, 1]);
  // Pages see each todo's running work (the cards show the todo at work).
  assert.deepEqual(h.issues().runningTasks(), { 'task-a': 1, 'task-b': 1 });
  h.finish(forMain, 'main done'); h.finish(forA, 'a done'); h.finish(forB, 'b done');
  await h.follow();
  assert.deepEqual(h.issues().runningTasks(), {}, 'ended work leaves the count, its report pending or not');
  assert.equal(h.reports(MAIN).length, 1);
  assert.match(h.reports(MAIN)[0], /main done/);
  assert.equal(h.reports(a.id).length, 1);
  assert.match(h.reports(a.id)[0], /a done/);
  assert.doesNotMatch(h.reports(a.id)[0], /b done|main done/);
  assert.match(h.reports(b.id)[0], /b done/);
  // Each keeps its own file.
  const saved = JSON.parse(await readFile(join(h.data, 'todo', 'task-a', 'follow.json'), 'utf8'));
  assert.deepEqual(saved.followed.filter((item: { kind: string }) => item.kind === 'delegated').map((item: { runId: string }) => item.runId), [forA.id]);
});

test('a message the main master sends to an issue master is reported to it as that turn; what the issue master then hands out is the issue master\'s', async t => {
  const h = await harness(t);
  const a = h.issueSession('task-a');
  await h.issues().refresh();
  const mainTurn = h.turn(MAIN, '이슈 마스터에게 물어봐');
  await h.main.follow();
  // The main master's turn writes to the issue master; even with the main turn as its caller, the issue master's turn is
  // where attribution starts again.
  const asked = h.turn(a.id, 'main asks', h.from(mainTurn));
  await h.main.started({ method: 'POST', path: `/api/sessions/${a.id}/messages`, route: '/api/sessions/:id/messages', local: `/api/sessions/${a.id}/messages`, write: true }, { prompt: asked.prompt }, { run: asked });
  const child = h.turn('codex:child', 'child work', h.from(asked));
  const grandchild = h.turn('codex:grandchild', 'grandchild work', h.from(child));
  await h.follow();
  await h.follow();
  assert.deepEqual(h.main.delegatedTable().rows.map(row => row[1]), ['main asks'], 'the main master follows only the turn it started');
  assert.deepEqual(h.issues().get('task-a')!.delegatedTable().rows.map(row => row[1]).sort(), ['child work', 'grandchild work']);
  h.finish(child, 'child done'); h.finish(grandchild, 'grandchild done');
  await h.follow();
  assert.equal(h.reports(MAIN).length, 0, 'the issue master\'s work is not reported to the main master');
  assert.match(h.reports(a.id)[0], /child done[\s\S]*grandchild done|grandchild done[\s\S]*child done/);
  h.finish(asked, 'answered the main master');
  await h.follow();
  assert.equal(h.reports(MAIN).length, 1);
  assert.match(h.reports(MAIN)[0], /answered the main master/);
});

test('an issue master\'s tool call goes as the main master\'s do, naming its todo, and the work it starts is followed by that issue master only', async t => {
  const h = await harness(t);
  const a = h.issueSession('task-a');
  h.turn(a.id, '배포해 줘');
  const answer = await h.issues().call('task-a', 'tower_api', { method: 'POST', path: '/api/sessions', body: { cwd: '/work', prompt: 'deploy it' } }) as { state: string; body: { run: Run } };
  assert.equal(answer.state, 'succeeded');
  assert.deepEqual(h.headers.at(-1), { path: '/api/sessions', master: SECRET, issue: 'task-a' }, 'the master\'s own secret and its todo, no calling-turn credential');
  const issue = h.issues().get('task-a')!;
  assert.deepEqual(issue.delegatedTable().rows.map(row => row[1]), ['deploy it'], 'the issue master was found for the call and follows its work');
  // A follow-up the delegated session hands on with its own credential stays with the issue master.
  const next = h.turn('codex:next', 'next step', h.from(answer.body.run));
  await h.follow();
  assert.equal(h.main.activeTasks(), 0);
  assert.deepEqual(issue.delegatedTable().rows.map(row => row[1]), ['deploy it', 'next step']);
  h.finish(answer.body.run, 'deployed'); h.finish(next, 'verified');
  await h.follow();
  assert.equal(h.reports(MAIN).length, 0);
  assert.equal(h.reports(a.id).length, 1);
  // A call for a todo with no open issue master still goes, naming its todo.
  await h.issues().call('task-z', 'tower_api', { method: 'POST', path: '/api/sessions/codex:x/messages', body: { prompt: 'still goes' } });
  assert.deepEqual(h.headers.at(-1), { path: '/api/sessions/codex:x/messages', master: SECRET, issue: 'task-z' });
});

test('the newest open session of a todo is its master; subfolders and subagents are not; a closed one stops and its file is cleared away after 30 days', async t => {
  const h = await harness(t);
  const older = h.issueSession('task-a');
  const newer = h.issueSession('task-a');
  h.issueSession('task-a', { isSubagent: true, parentId: newer.id });
  h.sessions.push({ ...older, id: 'claude:sub', cwd: join(h.dir, 'todo-masters', 'task-a', 'sub'), createdAt: h.tick() });
  await h.issues().refresh();
  assert.equal(h.issues().size(), 1);
  assert.equal(h.issues().get('task-a')!.binding()?.sessionId, newer.id);
  const path = join(h.data, 'todo', 'task-a', 'follow.json');
  // The newest is closed (hidden): the next newest open one is followed instead.
  newer.closed = true;
  await h.issues().refresh();
  assert.equal(h.issues().get('task-a')!.binding()?.sessionId, older.id);
  // All closed: the issue master stops and says since when.
  older.closed = true;
  const pending = h.turn('codex:late', 'late', h.from(h.turn(older.id, 'x')));
  await h.issues().refresh();
  assert.equal(h.issues().size(), 0);
  const closedAt = JSON.parse(await readFile(path, 'utf8')).closedAt;
  assert.equal(typeof closedAt, 'string');
  h.finish(pending, 'never reported');
  await h.follow();
  assert.equal(h.reports(older.id).length, 0, 'a closed issue master is not reported to');
  // Opened again (the todo reopened), it carries on with the same file.
  older.closed = false;
  await h.issues().refresh();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).closedAt, undefined);
  older.closed = true;
  await h.issues().refresh();
  // A host started later clears away what was closed long enough ago, and marks a file left open whose session is gone.
  const saved = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...saved, closedAt: new Date(Date.now() - KEEP_CLOSED_MS - 1000).toISOString() }), { mode: 0o600 });
  const stray = join(h.data, 'todo', 'task-gone', 'follow.json');
  await mkdir(join(h.data, 'todo', 'task-gone'), { recursive: true });
  await writeFile(stray, JSON.stringify({ version: 1, baselineAt: new Date().toISOString(), masterRuns: [], followed: [] }), { mode: 0o600 });
  await h.issues().close();
  await h.reopen().refresh();
  await assert.rejects(stat(join(h.data, 'todo', 'task-a')), { code: 'ENOENT' });
  assert.equal(typeof JSON.parse(await readFile(stray, 'utf8')).closedAt, 'string');
});

test('the web brings the host back for an issue master whose session was open when last seen, not for closed ones', async t => {
  const h = await harness(t);
  const client = new MasterClient({ stateDir: h.dir, credentials: () => undefined });
  t.after(() => client.dispose());
  const pendingWork = () => (client as unknown as { pendingWork(): Promise<boolean> }).pendingWork();
  // The main master is bound in this fixture: it is let go of, to look at issue masters alone.
  const settingsPath = join(h.data, 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  await writeFile(settingsPath, JSON.stringify({ ...settings, session: undefined }), { mode: 0o600 });
  assert.equal(await pendingWork(), false);
  const a = h.issueSession('task-a');
  await h.issues().refresh();
  assert.equal(await pendingWork(), true);
  a.closed = true;
  await h.issues().refresh();
  assert.equal(await pendingWork(), false);
});

test('through the host, an issue master\'s tool server names its todo and calls as the master, without a calling-turn credential; the main master\'s calls stay as they were', async t => {
  const stateDir = await temporaryFixture('tower-issue-host-');
  const cleanup: Array<() => unknown> = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await removeTemporaryFixture(stateDir); });
  const issue: Session = { id: 'claude:issue', nativeId: 'n', provider: 'claude', title: '이슈', cwd: join(stateDir, 'todo-masters', 'task-h'), project: 'x', status: 'working', statusReason: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
  const seen: Array<{ path: string; capability?: string; master?: string; issue?: string }> = [];
  const web = createServer(async (req, res) => {
    for await (const _ of req) { /* drained */ }
    if (req.url?.startsWith('/api/events')) {
      const snapshot: Snapshot = { sessions: [issue], runs: [], autoPrompts: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`id: 1\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      return;
    }
    seen.push({ path: req.url!, ...(req.headers['x-tower-run-capability'] ? { capability: String(req.headers['x-tower-run-capability']) } : {}), ...(req.headers['x-tower-master'] ? { master: String(req.headers['x-tower-master']) } : {}), ...(req.headers['x-tower-issue'] ? { issue: String(req.headers['x-tower-issue']) } : {}) });
    res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ session: { id: 'codex:new' }, run: { id: 'run-new', sessionId: 'codex:new', createdAt: new Date().toISOString() } }));
  });
  await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { web.closeAllConnections(); web.close(() => resolve()); }));
  const host = await startMasterHost({ stateDir, idleMs: 60_000, followMs: 60_000 });
  cleanup.push(() => host.close());
  const page = new MasterClient({ stateDir, credentials: () => ({ port: (web.address() as { port: number }).port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) }) });
  cleanup.push(() => page.dispose());
  await page.call('hello');
  const mcp = async (instance?: MasterMcpInstance) => {
    const input = new PassThrough(), output = new PassThrough();
    const lines: Array<Record<string, any>> = [];
    let buffer = '';
    output.on('data', chunk => { buffer += String(chunk); for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) { lines.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
    const serving = startMasterMcp(stateDir, input, output, undefined, instance);
    cleanup.push(async () => { input.end(); await serving; });
    let id = 0;
    return async (name: string, args: Record<string, unknown>) => {
      const ask = ++id;
      input.write(JSON.stringify({ jsonrpc: '2.0', id: ask, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      return until(() => lines.find(line => line.id === ask));
    };
  };
  const issueTools = await mcp({ id: 'todo:task-h' });
  const reply = await issueTools('tower_api', { method: 'POST', path: '/api/sessions', body: { cwd: '/work', prompt: 'fix it' } });
  assert.equal(reply.result.isError, undefined);
  assert.deepEqual(seen.at(-1), { path: '/api/sessions', master: 'b'.repeat(64), issue: 'task-h' });
  assert.deepEqual(host.issues!.get('task-h')!.delegatedTable().rows.map(row => row[3]), ['codex:new'], 'the issue master follows what it started');
  assert.match(await readFile(join(stateDir, 'todo-masters', 'task-h', 'CLAUDE.md'), 'utf8'), /`task-h`/);
  const mainTools = await mcp();
  await mainTools('tower_api', { method: 'POST', path: '/api/sessions/codex:new/messages', body: { prompt: 'more' } });
  assert.deepEqual(seen.at(-1), { path: '/api/sessions/codex:new/messages', master: 'b'.repeat(64) });
  assert.equal(host.session!.delegatedTable().rows.length, 1, 'the main master follows its own call');
  // A tool server that names no proper todo is refused.
  await assert.rejects(page.call('tool', { name: 'tower_api', arguments: { method: 'GET', path: '/api/link' }, instance: 'todo:../x' }), /올바르지 않습니다/);
});

test('a first caller that was another master\'s turn never makes that master\'s other work this one\'s, in or out of the snapshot', async t => {
  const h = await harness(t);
  const b = h.issueSession('task-b');
  await h.issues().refresh();
  const mainTurn = h.turn(MAIN, 'main turn');
  await h.main.follow();
  // The main master's turn writes to issue master B as its caller; B hands work on, whose first caller is the main turn.
  const bTurn = h.turn(b.id, 'from main', h.from(mainTurn));
  const forB = h.turn('codex:b-work', 'b work', h.from(bTurn));
  await h.follow();
  const issue = h.issues().get('task-b')!;
  assert.deepEqual(issue.delegatedTable().rows.map(row => row[1]), ['b work']);
  // The main master's own work afterwards stays its own, while the main turn is in the snapshot and after it left.
  const mainWork = h.turn('codex:main-work', 'main work', h.from(mainTurn));
  await h.follow();
  h.runs.splice(h.runs.indexOf(mainTurn), 1);
  const laterWork = h.turn('codex:later', 'later main work', { parentRunId: mainTurn.id, rootRunId: mainTurn.id });
  await h.follow();
  await h.follow();
  // Work handed on from the main master's work, once that work left the snapshot too.
  h.runs.splice(h.runs.indexOf(mainWork), 1);
  h.turn('codex:next', 'next main work', { parentRunId: mainWork.id, rootRunId: mainTurn.id });
  await h.follow();
  await h.follow();
  assert.deepEqual(issue.delegatedTable().rows.map(row => row[1]), ['b work'], 'nothing of the main master\'s comes to B');
  assert.deepEqual(h.main.delegatedTable().rows.map(row => row[1]).sort(), ['from main', 'later main work', 'main work', 'next main work'].sort());
  assert.ok(forB && laterWork);
});

test('an issue master closed while it looks at Tower sends no new report', async t => {
  const h = await harness(t);
  const a = h.issueSession('task-a');
  await h.issues().refresh();
  const aTurn = h.turn(a.id, 'A 일');
  const work = h.turn('codex:a-work', 'a work', h.from(aTurn));
  const issue = h.issues().get('task-a')!;
  await issue.follow();
  // Its report was refused once, and is due to go again at the next look.
  h.refuse(true);
  h.finish(work, 'done');
  await issue.follow();
  h.refuse(false);
  const posted = h.headers.length;
  const release = h.hold();
  const looking = issue.follow();
  a.closed = true;
  const refreshed = h.issues().refresh();
  await until(() => h.issues().size() === 0);
  release();
  await looking;
  await refreshed;
  assert.equal(h.reports(a.id).length, 0);
  assert.equal(h.headers.length, posted, 'nothing was posted to the closed issue master');
});

test('masters sharing one lookup database each query their own delegated work', async t => {
  const h = await harness(t);
  // Like the real one, it rebuilds its tables only when the version it is given changes.
  const asked: string[] = [];
  let built: { version: string; rows: unknown[][] } | undefined;
  const readDb = { query: async (_sql: string, version: string, tables: () => Array<{ name: string; rows: unknown[][] }>) => {
    asked.push(version);
    if (built?.version !== version) built = { version, rows: tables().find(table => table.name === 'delegated')!.rows };
    return { columns: ['title'], rows: built.rows.map(row => [row[1]]), truncated: false };
  } } as unknown as ReadDatabase;
  const live = { fresh: async () => ({ sessions: [], runs: [], autoPrompts: [], providers: [], scanning: false, hostname: 'h', version: 't', updatedAt: '' }), snapshot: () => ({ sessions: [], runs: [] }), version: () => 1, nodeSnapshots: () => new Map(), missing: () => [] } as unknown as LiveState;
  const table = (title: string) => () => ({ name: 'delegated', columns: ['id', 'title', 'state'], rows: [['x', title, 'running']] });
  const screen = new MasterScreen({ broadcast: () => {} });
  const one = new MasterTools({ tower: h.tower, live, readDb, scope: 'todo:a', screen, started: async () => {}, delegated: table('A의 일') });
  const two = new MasterTools({ tower: h.tower, live, readDb, scope: 'todo:b', screen, started: async () => {}, delegated: table('B의 일') });
  assert.deepEqual((await one.call('tower_query', { sql: 'SELECT title FROM delegated' }) as { rows: unknown[] }).rows, [['A의 일']]);
  assert.deepEqual((await two.call('tower_query', { sql: 'SELECT title FROM delegated' }) as { rows: unknown[] }).rows, [['B의 일']]);
  assert.notEqual(asked[0], asked[1], 'the same states of different work are not the same tables');
});

test('the web leaves closed issue masters\' data to the host: one due to be cleared away brings the host, which clears it', async t => {
  const h = await harness(t);
  const settingsPath = join(h.data, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await readFile(settingsPath, 'utf8')), session: undefined }), { mode: 0o600 });
  const write = async (taskId: string, closedAt: string, followed: unknown[] = []) => {
    await mkdir(join(h.data, 'todo', taskId), { recursive: true });
    await writeFile(join(h.data, 'todo', taskId, 'follow.json'), JSON.stringify({ version: 1, baselineAt: new Date().toISOString(), masterRuns: [], followed, closedAt }), { mode: 0o600 });
  };
  await write('task-recent', new Date().toISOString(), [{ id: 'x', kind: 'delegated', report: 'pending' }]);
  let open = false;
  const client = new MasterClient({ stateDir: h.dir, credentials: () => undefined, issueMastersOpen: () => open });
  t.after(() => client.dispose());
  const pendingWork = () => (client as unknown as { pendingWork(): Promise<boolean> }).pendingWork();
  assert.equal(await pendingWork(), false, 'a closed issue master needs no host, undelivered reports or not');
  open = true;
  assert.equal(await pendingWork(), true, 'an open issue master the web knows of does');
  open = false;
  await write('task-old', new Date(Date.now() - KEEP_CLOSED_MS - 1000).toISOString());
  assert.equal(await pendingWork(), true, 'data due to be cleared away brings the host');
  // The host clears it at its next look, and leaves the recent one.
  await h.reopen().refresh();
  await assert.rejects(stat(join(h.data, 'todo', 'task-old')), { code: 'ENOENT' });
  assert.ok((await stat(join(h.data, 'todo', 'task-recent'))).isDirectory());
  assert.equal(await pendingWork(), false);
});

test('work sent to an issue master stays that master\'s boundary after its session is gone and the host started again', async t => {
  const h = await harness(t);
  const b = h.issueSession('task-b');
  await h.issues().refresh();
  const mainTurn = h.turn(MAIN, '이슈 마스터에게');
  await h.main.follow();
  const asked = h.turn(b.id, 'main asks B');
  await h.main.started({ method: 'POST', path: `/api/sessions/${b.id}/messages`, route: '/api/sessions/:id/messages', local: `/api/sessions/${b.id}/messages`, write: true }, { prompt: asked.prompt }, { run: asked });
  await h.follow();
  // B's session goes cold (out of the snapshot) and a new host knows nothing of B's turns.
  h.sessions.splice(h.sessions.indexOf(b), 1);
  h.runs.splice(h.runs.indexOf(asked), 1);
  // Let go of, B's turns are forgotten by the host (it keeps only masters it follows); the boundary is in the main master's file.
  await h.issues().refresh();
  assert.equal(h.issues().size(), 0);
  assert.equal(h.issues().masterRun(asked.id), false);
  await h.issues().close();
  await h.reopen().refresh();
  h.turn('codex:b-child', 'B handed this on', { parentRunId: asked.id, rootRunId: asked.id });
  await h.main.follow();
  await h.main.follow();
  assert.deepEqual(h.main.delegatedTable().rows.map(row => row[1]), ['main asks B'], 'the main master does not take B\'s work');
  assert.ok(mainTurn);
});

test('the host chooses a todo\'s master by the web\'s rule: a helper an agent started there is never it', async t => {
  const h = await harness(t);
  const master = h.issueSession('task-a');
  h.issueSession('task-a', { launchedByAgent: true });
  await h.issues().refresh();
  assert.equal(h.issues().get('task-a')!.binding()?.sessionId, master.id);
});

test('clearing away an expired issue master takes its guides and empty folder, never other files', async t => {
  const h = await harness(t);
  const expired = new Date(Date.now() - KEEP_CLOSED_MS - 1000).toISOString();
  for (const [taskId, extra] of [['task-x', false], ['task-y', true]] as const) {
    await mkdir(join(h.data, 'todo', taskId), { recursive: true });
    await writeFile(join(h.data, 'todo', taskId, 'follow.json'), JSON.stringify({ version: 1, baselineAt: expired, masterRuns: [], followed: [], closedAt: expired }), { mode: 0o600 });
    const folder = join(h.dir, 'todo-masters', taskId);
    await mkdir(folder, { recursive: true });
    for (const name of ['CLAUDE.md', 'AGENTS.md']) await writeFile(join(folder, name), 'guide');
    if (extra) await writeFile(join(folder, 'notes.txt'), 'the master\'s own');
  }
  await h.reopen().refresh();
  await assert.rejects(stat(join(h.dir, 'todo-masters', 'task-x')), { code: 'ENOENT' });
  const kept = join(h.dir, 'todo-masters', 'task-y');
  assert.equal(await readFile(join(kept, 'notes.txt'), 'utf8'), 'the master\'s own');
  await assert.rejects(stat(join(kept, 'CLAUDE.md')), { code: 'ENOENT' });
  await assert.rejects(stat(join(h.data, 'todo', 'task-y')), { code: 'ENOENT' });
});

test('an issue master let go of while its report is answered leaves none of its turns behind', async t => {
  const h = await harness(t);
  const a = h.issueSession('task-a');
  await h.issues().refresh();
  const work = h.turn('codex:a-work', 'a work');
  const issue = h.issues().get('task-a')!;
  await issue.started({ method: 'POST', path: '/api/sessions', route: '/api/sessions', local: '/api/sessions', write: true }, { prompt: work.prompt }, { session: { id: work.sessionId }, run: work });
  h.finish(work, 'done');
  const release = h.pause();
  const looking = issue.follow();
  // The report is on its way when the issue master is closed and let go of.
  await until(() => h.headers.some(item => item.path === `/api/sessions/${encodeURIComponent(a.id)}/messages`));
  a.closed = true;
  const refreshed = h.issues().refresh();
  await until(() => h.issues().size() === 0);
  release();
  await looking;
  await refreshed;
  const report = h.runs.find(run => run.sessionId === a.id && run.prompt.startsWith('[Tower report]'));
  assert.ok(report, 'the report already sent is not taken back');
  assert.equal(h.issues().masterRun(report.id), false, 'its turn is not kept for a master no longer followed');
});
