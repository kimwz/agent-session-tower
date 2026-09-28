import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveState } from '../../server/master/live-state.js';
import { MasterJournal } from '../../server/master/journal.js';
import type { ModelCall, ModelItem, ModelRequest } from '../../server/master/model-openai.js';
import { lookupsSupported, ReadDatabase } from '../../server/master/read-db.js';
import { MasterRoom } from '../../server/master/room.js';
import { MasterService } from '../../server/master/service.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { TowerClient } from '../../server/master/tower-client.js';
import type { Session, Snapshot } from '../../shared/types.js';
import { until } from '../helpers/until.js';

const session = (id: string, status: Session['status']): Session => ({ id, nativeId: id, provider: 'claude', title: `title ${id}`, cwd: `/work/${id}`, project: `project-${id}`,
  status, statusReason: '', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z', lastRequestAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true });
const say = (text: string): ModelItem => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
/** The live status the turn starts from: data from the owner's side, never Tower's own instructions. */
const statusOf = (request: { input: ModelItem[] }) => {
  const found = request.input.find(item => item.role === 'user' && String(item.content).startsWith('[data] '));
  assert.ok(found, 'the status is given as data');
  assert.ok(!request.input.some(item => item.role === 'developer' && String(item.content).includes('Working now')));
  return String(found.content);
};

test('each turn starts from the live Tower status, and quick lookups answer from it without asking for whole snapshots', { skip: !lookupsSupported() && 'this Node.js has no SQLite authorizer' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-live-'));
  const state: Snapshot = { sessions: [session('a', 'working'), session('b', 'idle')], runs: [], providers: [], scanning: false, hostname: 'here', version: '1.46.0', updatedAt: '' };
  const paths: string[] = [];
  const streams: ServerResponse[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url!.startsWith('/api/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`id: 1\nevent: snapshot\ndata: ${JSON.stringify(state)}\n\n`);
      streams.push(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const tower = new TowerClient();
  tower.setCredentials({ port: (server.address() as { port: number }).port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const settings = new MasterSettingsStore(dir); await settings.start(); await settings.update({ apiKey: 'sk-test-0123456789abcdef' });
  const room = new MasterRoom(dir); await room.start();
  const journal = new MasterJournal(dir); await journal.start();
  const live = new LiveState((path, signal) => tower.stream(path, signal));
  const readDb = new ReadDatabase();
  const requests: ModelRequest[] = [];
  const steps: Array<(request: ModelRequest) => ModelItem[]> = [
    request => { assert.match(statusOf(request), /Working now \(1\):\n {2}- title a/); return [{ type: 'function_call', call_id: 'q1', name: 'tower_query', arguments: JSON.stringify({ sql: "SELECT id, status FROM sessions WHERE status = 'idle'" }) }]; },
    request => {
      const output = JSON.parse(String(request.input.at(-1)!.output)) as { rows: Array<{ id: string }>; asOf: string };
      assert.deepEqual(output.rows.map(row => row.id), ['b']);
      assert.ok(output.asOf);
      return [say('대기 중인 세션은 b 하나입니다.')];
    },
  ];
  const model: ModelCall = async request => { requests.push(request); const output = steps.shift()!(request); return { output, text: output.filter(item => item.type === 'message').map(item => (item.content as Array<{ text: string }>)[0].text).join('') }; };
  const service = new MasterService({ settings, room, journal, tower, model, live, readDb, taskPollMs: 40 });
  await service.start();
  t.after(async () => { await service.close(); live.close(); readDb.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  await service.send({ clientMessageId: 'live-0001', text: '대기 중인 세션 뭐 있어?', local: true });
  await until(() => room.recent(10).some(entry => entry.data.kind === 'master' && entry.data.text.includes('b 하나')), 15_000);
  assert.equal(requests.length, 2);
  assert.ok(!paths.includes('/api/snapshot'), 'no whole snapshot was fetched');
  assert.equal(paths.filter(path => path.startsWith('/api/events')).length, 1, 'one live stream, like one more page');
});

test('without lookups (Node.js 22 has no SQLite authorizer) the master is not offered them and still starts from the live status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-nolookup-'));
  const state: Snapshot = { sessions: [session('a', 'working')], runs: [], providers: [], scanning: false, hostname: 'here', version: '1.46.1', updatedAt: '' };
  const streams: ServerResponse[] = [];
  const server = createServer((req, res) => {
    if (req.url!.startsWith('/api/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`id: 1\nevent: snapshot\ndata: ${JSON.stringify(state)}\n\n`);
      streams.push(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const tower = new TowerClient();
  tower.setCredentials({ port: (server.address() as { port: number }).port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const settings = new MasterSettingsStore(dir); await settings.start(); await settings.update({ apiKey: 'sk-test-0123456789abcdef' });
  const room = new MasterRoom(dir); await room.start();
  const journal = new MasterJournal(dir); await journal.start();
  const live = new LiveState((path, signal) => tower.stream(path, signal));
  const requests: ModelRequest[] = [];
  const model: ModelCall = async request => { requests.push(request); return { output: [say('a 하나가 작업 중입니다.')], text: 'a 하나가 작업 중입니다.' }; };
  const service = new MasterService({ settings, room, journal, tower, model, live, taskPollMs: 40 });
  await service.start();
  t.after(async () => { await service.close(); live.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  await service.send({ clientMessageId: 'live-0002', text: '지금 뭐 돌아가?', local: true });
  await until(() => room.recent(10).some(entry => entry.data.kind === 'master' && entry.data.text.includes('a 하나')), 15_000);
  assert.equal(requests.length, 1);
  assert.match(statusOf(requests[0]), /Working now \(1\):\n {2}- title a/);
  assert.deepEqual(requests[0].tools.map(tool => tool.name), ['tower_api', 'session_read', 'ui', 'browser_action', 'request_secret', 'terminal_read']);
  assert.doesNotMatch(requests[0].instructions, /tower_query/);
});
