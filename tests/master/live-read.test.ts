import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { LiveState } from '../../server/master/live-state.js';
import { lookupsSupported, ReadDatabase, tablesFrom } from '../../server/master/read-db.js';
import { statusDigest } from '../../server/master/digest.js';
import { TowerClient } from '../../server/master/tower-client.js';
import { diffSnapshots, indexSnapshot } from '../../shared/snapshot-patch.js';
import type { Session, Snapshot } from '../../shared/types.js';
import { until } from '../helpers/until.js';

/** Lookups need SQLite's authorizer, which Node.js 22 lacks; there the master simply does not offer them. */
const noLookups = !lookupsSupported() && 'this Node.js has no SQLite authorizer';

const session = (id: string, status: Session['status'], extra: Partial<Session> = {}): Session => ({ id, nativeId: id, provider: 'claude', title: `title ${id}`, cwd: `/work/${id}`, project: `project-${id}`,
  status, statusReason: '', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z', lastMessage: `last ${id}`, messageCount: 3, isSubagent: false, resumable: true, ...extra });
const snapshot = (sessions: Session[], extra: Partial<Snapshot> = {}): Snapshot => ({ sessions, runs: [], providers: [], scanning: false, hostname: 'here', version: '1.46.0', updatedAt: '', ...extra });
const NODE = 'b'.repeat(32);

/** A page's event stream: frames written by the test. */
async function eventServer(t: test.TestContext) {
  const clients: ServerResponse[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    connections++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    clients.push(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const client = new TowerClient();
  client.setCredentials({ port: (server.address() as { port: number }).port, token: 'a'.repeat(64), callerSecret: 'c'.repeat(64) });
  const send = (frame: string) => clients.at(-1)!.write(frame);
  return { client, send, connections: () => connections, clients };
}

test('the master follows the page\'s event stream: snapshots, patches and joined computers, the same way the page applies them', async t => {
  const events = await eventServer(t);
  const live = new LiveState((path, signal) => events.client.stream(path, signal));
  t.after(() => live.close());
  const first = snapshot([session('a', 'working')]);
  const pending = live.fresh(2000);
  await until(() => events.clients.length === 1);
  events.send(`id: 1\nevent: snapshot\ndata: ${JSON.stringify(first)}\n\n`);
  assert.equal((await pending)?.sessions[0].status, 'working');
  const second = snapshot([session('a', 'idle'), session('b', 'working')]);
  events.send(`id: 2\nevent: patch\ndata: ${JSON.stringify({ base: 1, ...diffSnapshots(indexSnapshot(first), second) })}\n\n`);
  await until(() => live.snapshot()?.sessions.length === 2);
  assert.deepEqual(live.snapshot()!.sessions.map(item => item.status), ['idle', 'working']);
  events.send(`event: node\ndata: ${JSON.stringify({ node: NODE, sequence: 1, snapshot: snapshot([session('n', 'working')]) })}\n\n`);
  await until(() => live.node(NODE));
  events.send(`event: node\ndata: ${JSON.stringify({ node: NODE, removed: true })}\n\n`);
  await until(() => !live.node(NODE));
  // A patch that does not follow what was received cannot be applied: the stream starts over, nothing stale is served.
  events.send(`id: 9\nevent: patch\ndata: ${JSON.stringify({ base: 7, sessions: { upsert: [] } })}\n\n`);
  await until(() => events.connections() === 2);
  assert.equal(live.snapshot(), undefined);
  events.send(`id: 1\nevent: snapshot\ndata: ${JSON.stringify(first)}\n\n`);
  await until(() => live.snapshot()?.sessions.length === 1);
});

test('the quick-lookup database answers reads only: no writes, PRAGMA, ATTACH, recursion or second statements', { skip: noLookups }, async t => {
  const db = new ReadDatabase();
  t.after(() => db.close());
  const tables = () => tablesFrom(snapshot([session('a', 'working'), session('b', 'idle', { customTitle: 'key sk-proj-ABCDEFGHIJKLMNOPQRSTUV' })]), new Map([[NODE, snapshot([session('n', 'working')])]]),
    text => text.replace(/sk-[A-Za-z0-9-]+/g, '{{secret}}'));
  const working = await db.query(`SELECT computer, id, status FROM sessions WHERE status = 'working' ORDER BY id`, 'v1', tables);
  assert.deepEqual(working.rows.map(row => row.id), ['a', 'n']);
  assert.deepEqual(working.columns, ['computer', 'id', 'status']);
  const hidden = await db.query(`SELECT title FROM sessions WHERE id = 'b'`, 'v1', tables);
  assert.equal(hidden.rows[0].title, 'key {{secret}}');
  assert.equal((await db.query('WITH w AS (SELECT id FROM sessions) SELECT count(*) AS n FROM w', 'v1', tables)).rows[0].n, 3);
  for (const sql of ["INSERT INTO sessions (id) VALUES ('x')", 'DELETE FROM sessions', 'PRAGMA table_info(sessions)', "SELECT * FROM pragma_table_info('sessions')",
    "ATTACH ':memory:' AS other", 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c', 'SELECT 1; SELECT 2', 'SELECT 1; DELETE FROM sessions']) {
    await assert.rejects(db.query(sql, 'v1', tables), { statusCode: 400 }, sql);
  }
  assert.equal((await db.query('SELECT count(*) AS n FROM sessions', 'v1', tables)).rows[0].n, 3, 'nothing was changed');
});

test('a query is cut at 500 rows, and one that runs too long is stopped without breaking the next', { skip: noLookups }, async t => {
  const db = new ReadDatabase();
  t.after(() => db.close());
  const many = () => tablesFrom(snapshot(Array.from({ length: 600 }, (_, index) => session(`s${index}`, 'idle'))), new Map(), text => text);
  const capped = await db.query('SELECT id FROM sessions', 'many', many);
  assert.equal(capped.rows.length, 500);
  assert.equal(capped.truncated, true);
  const started = Date.now();
  await assert.rejects(db.query('SELECT count(*) FROM sessions a, sessions b, sessions c, sessions d', 'many', many), /longer than 2 seconds/);
  assert.ok(Date.now() - started < 4000);
  assert.equal((await db.query('SELECT count(*) AS n FROM sessions', 'many', many)).rows[0].n, 600, 'a fresh thread rebuilds and answers');
});

test('the status digest names what is working, waiting and just finished, with its time', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const local = snapshot([session('a', 'working', { lastRequestAt: '2026-09-27T11:50:00Z' }), session('b', 'idle', { outcome: 'needsOwner' }), session('c', 'idle', { isSubagent: true, status: 'working' })],
    { runs: [{ id: 'r', sessionId: 'b', prompt: 'p', status: 'completed', createdAt: '2026-09-27T11:40:00Z', finishedAt: '2026-09-27T11:55:00Z', output: '' }], nodes: [{ id: NODE, name: 'Server', status: 'connected', features: [], streaming: true }] });
  const digest = statusDigest(local, new Map([[NODE, snapshot([session('n', 'working')])]]), now);
  assert.match(digest, /2026-09-27T12:00:00/);
  assert.match(digest, /Working now \(2\)/);
  assert.match(digest, /title a — project-a \[a\], for 10 min/);
  assert.match(digest, /@Server/);
  assert.match(digest, /Waiting for the owner or stopped \(1\)/);
  assert.match(digest, /completed 5 min ago/);
  assert.doesNotMatch(digest, /title c/, 'subagents are left out');
  assert.match(statusDigest(undefined, new Map()), /not available/);
});

test('a first look waits a moment for joined computers, and says which ones have not arrived', async t => {
  const events = await eventServer(t);
  const live = new LiveState((path, signal) => events.client.stream(path, signal));
  t.after(() => live.close());
  const other = 'c'.repeat(32);
  const local = snapshot([session('a', 'idle')], { nodes: [{ id: NODE, name: 'Server', status: 'connected', features: [], streaming: true }, { id: other, name: 'Laptop', status: 'offline', features: [], streaming: false }] });
  const pending = live.fresh(3000);
  await until(() => events.clients.length === 1);
  events.send(`id: 1\nevent: snapshot\ndata: ${JSON.stringify(local)}\n\n`);
  await new Promise(resolve => setTimeout(resolve, 200));
  events.send(`event: node\ndata: ${JSON.stringify({ node: NODE, sequence: 1, snapshot: snapshot([session('n', 'working')]) })}\n\n`);
  const started = Date.now();
  await pending;
  assert.ok(live.node(NODE), 'the computer that answered is included');
  assert.deepEqual(live.missing(), [other]);
  assert.ok(Date.now() - started < 2500);
  assert.match(statusDigest(live.snapshot(), live.nodeSnapshots(), Date.now(), live.missing()), /No current data yet from: Laptop/);
});

test('every text in the lookup database is hidden before it is stored, names and paths included, and sizes count bytes', { skip: noLookups }, async t => {
  const db = new ReadDatabase();
  t.after(() => db.close());
  const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV';
  const hide = (text: string) => text.replaceAll(key, '{{secret}}');
  const tables = () => tablesFrom(snapshot([session('a', 'idle', { cwd: `/work/${key}`, project: key })], { hostname: `host-${key}` }), new Map(), hide);
  const rows = await db.query(`SELECT substr(cwd, 7) AS tail, project, (SELECT name FROM computers WHERE node = '') AS host FROM sessions`, 'hidden', tables);
  assert.doesNotMatch(JSON.stringify(rows), /ABCDEFGHIJ/);
  const korean = () => tablesFrom(snapshot(Array.from({ length: 400 }, (_, index) => session(`k${index}`, 'idle', { lastMessage: '가'.repeat(290) }))), new Map(), text => text);
  const result = await db.query('SELECT last_message FROM sessions', 'korean', korean);
  assert.equal(result.truncated, true, 'about 870 bytes a row: fewer than 400 rows fit in 256 KB');
  assert.ok(Buffer.byteLength(JSON.stringify(result.rows)) <= 256 * 1024 + 1000);
});

test('the digest counts conversations that finished on their own, once each', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const local = snapshot([session('typed', 'idle', { lastCompletedAt: '2026-09-27T11:59:00Z' }), session('ran', 'idle', { lastCompletedAt: '2026-09-27T11:58:00Z' })],
    { runs: [{ id: 'r', sessionId: 'ran', prompt: 'p', status: 'completed', createdAt: '2026-09-27T11:50:00Z', finishedAt: '2026-09-27T11:58:00Z', output: '' }] });
  const digest = statusDigest(local, new Map(), now);
  assert.match(digest, /Finished in the last 30 min \(2\)/);
  assert.match(digest, /completed 1 min ago — title typed/);
  assert.equal(digest.match(/title ran/g)?.length, 1);
});

test('a lookup process whose host was killed exits by itself', { skip: noLookups }, async () => {
  const helper = spawn(process.execPath, ['--import', 'tsx', '-e', `
    const { ReadDatabase } = await import(${JSON.stringify(new URL('../../server/master/read-db.ts', import.meta.url).href)});
    const db = new ReadDatabase();
    await db.query('SELECT 1 AS one', 'v', () => []);
    console.log('child ' + db.child.pid);
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'], cwd: new URL('../..', import.meta.url).pathname });
  const pid = await new Promise<number>((resolve, reject) => {
    helper.stdout.on('data', chunk => { const match = /child (\d+)/.exec(String(chunk)); if (match) resolve(Number(match[1])); });
    helper.on('exit', () => reject(new Error('helper exited early')));
  });
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), true);
  helper.kill('SIGKILL');
  await until(() => !alive(), 8000);
});

test('a lookup process stuck in a runaway query when its host is killed is ended by its CPU limit', { skip: noLookups }, async () => {
  const helper = spawn(process.execPath, ['--import', 'tsx', '-e', `
    const { ReadDatabase, tablesFrom } = await import(${JSON.stringify(new URL('../../server/master/read-db.ts', import.meta.url).href)});
    const db = new ReadDatabase({ cpuLimitSeconds: 1 });
    const rows = Array.from({ length: 300 }, (_, index) => ({ id: 's' + index, nativeId: 's', provider: 'claude', title: 't', cwd: '/w', project: 'p', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true }));
    const tables = () => tablesFrom({ sessions: rows, runs: [], providers: [], scanning: false, hostname: 'h', version: 'v', updatedAt: '' }, new Map(), text => text);
    await db.query('SELECT 1 AS one', 'v', tables);
    console.log('child ' + db.child.pid);
    void db.query('SELECT count(*) FROM sessions a, sessions b, sessions c, sessions d', 'v', tables).catch(() => {});
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'], cwd: new URL('../..', import.meta.url).pathname });
  const pid = await new Promise<number>((resolve, reject) => {
    helper.stdout.on('data', chunk => { const match = /child (\d+)/.exec(String(chunk)); if (match) resolve(Number(match[1])); });
    helper.on('exit', () => reject(new Error('helper exited early')));
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  helper.kill('SIGKILL');
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await until(() => !alive(), 8000);
});

test('a key at the edge of a shortened text is hidden whole first, in the lookup database and in the digest', { skip: noLookups }, async t => {
  const db = new ReadDatabase();
  t.after(() => db.close());
  const key = 'AKIAABCDEFGHIJKLMNOP';
  const hide = (text: string) => text.replace(/\bAKIA[0-9A-Z]{16}\b/g, '{{secret}}');
  // The key straddles the 200-character cut of a title and the 80-character cut of the digest.
  const title = `${'x'.repeat(190)} ${key}`;
  const local = snapshot([session('a', 'working', { customTitle: `${'y'.repeat(70)} ${key}` }), session('b', 'idle', { customTitle: title })]);
  const rows = await db.query(`SELECT title FROM sessions`, 'edge', () => tablesFrom(local, new Map(), hide));
  assert.doesNotMatch(JSON.stringify(rows), /AKIAABCDEF/);
  assert.doesNotMatch(statusDigest(local, new Map(), Date.now(), [], hide), /AKIAABCDEF/);
});

test('the warning about computers without data survives any cut of a long digest', () => {
  const long = (index: number) => session(`s${index}`, 'working', { customTitle: 'T'.repeat(80), project: 'P'.repeat(80) });
  // Many joined computers with long names make the one line that has no count limit.
  const computers = Array.from({ length: 60 }, (_, index) => ({ id: index.toString(16).padStart(32, '0'), name: `computer-${index}-${'N'.repeat(70)}`, status: 'connected' as const, features: [], streaming: true }));
  const local = snapshot(Array.from({ length: 20 }, (_, index) => long(index)), { nodes: computers });
  const digest = statusDigest(local, new Map(), Date.now(), [computers[59].id]);
  assert.ok(digest.length <= 4200);
  assert.match(digest, /No current data yet from: computer-59-/);
  assert.match(digest, /cut; look up the rest/);
});

test('names of joined computers are hidden whole before the digest is cut', () => {
  const key = 'AKIAABCDEFGHIJKLMNOP';
  const hide = (text: string) => text.replace(/\bAKIA[0-9A-Z]{16}\b/g, '{{secret}}');
  const computers = Array.from({ length: 50 }, (_, index) => ({ id: index.toString(16).padStart(32, '0'), name: `computer-${index} ${key}`, status: 'connected' as const, features: [], streaming: true }));
  const local = snapshot([session('a', 'working')], { nodes: computers });
  for (const width of [0, 7, 13]) {
    const padded = { ...local, nodes: computers.map(node => ({ ...node, name: `${'w'.repeat(width)}${node.name}` })) };
    const digest = statusDigest(padded, new Map([[computers[0].id, snapshot([session('n', 'working')])]]), Date.now(), [computers[1].id], hide);
    assert.doesNotMatch(digest, /AKIAABCD/, `width ${width}`);
  }
});
