import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TowerApi } from '../../../server/api/tower-api.js';
import { SessionService } from '../../../server/sessions/service.js';
import { TriggerService } from '../../../server/triggers/service.js';
import type { TriggerActor } from '../../../shared/triggers.js';
import type { Session } from '../../../shared/types.js';

const agent: TriggerActor = { kind: 'agent', via: 'mcp', sessionId: 'claude:caller', runId: 'run' };
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const claudeRow = (sessionId: string, role: 'user' | 'assistant', content: unknown, timestamp: string, uuid: string) =>
  ({ type: role, sessionId, cwd: '/work/app', uuid, timestamp, message: { role, content } });

/** Claude conversations in a private home, read through the same TowerApi agents call. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tower-session-tools-'));
  const claudeHome = join(root, 'claude');
  const codexHome = join(root, 'codex');
  await Promise.all([mkdir(join(claudeHome, 'projects', 'app'), { recursive: true }), mkdir(join(codexHome, 'sessions'), { recursive: true })]);
  const sessions = new SessionService({ claudeHome, codexHome, inspectProcesses: async () => ({ claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false } }) });
  const triggers = new TriggerService({ stateDir: root, tickMs: 60_000, executor: { submitAutoPrompt: async () => { throw new Error('unused'); }, getAutoPrompt: () => undefined,
    create: async () => { throw new Error('unused'); }, enqueue: async () => { throw new Error('unused'); }, runs: () => [], session: () => undefined } });
  await triggers.start();
  const api = new TowerApi({ stateDir: root, triggers, sessions: {
    list: () => sessions.list(),
    read: (session, limit, before) => sessions.detail(session, before, limit),
    search: (session, query) => sessions.search(session, query),
  } });
  t.after(async () => { sessions.stop(); triggers.close(); await rm(root, { recursive: true, force: true }); });
  const write = (n: number, rows: unknown[]) => writeFile(join(claudeHome, 'projects', 'app', `${id(n)}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const call = <T>(name: string, input: unknown) => api.call(name, input, agent) as Promise<T>;
  return { sessions, write, call };
}

test('agents list sessions a page at a time, most recently active first', async t => {
  const f = await fixture(t);
  for (let n = 1; n <= 5; n++) await f.write(n, [claudeRow(id(n), 'user', `Task ${n}`, `2026-09-0${n}T10:00:00.000Z`, `u${n}`)]);
  await f.sessions.refresh();
  type Page = { sessions: Array<{ id: string; title: string }>; nextCursor?: string };
  const first = await f.call<Page>('sessions.list', { limit: 2 });
  assert.deepEqual(first.sessions.map(item => item.id), [`claude:${id(5)}`, `claude:${id(4)}`]);
  const second = await f.call<Page>('sessions.list', { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.sessions.map(item => item.id), [`claude:${id(3)}`, `claude:${id(2)}`]);
  const last = await f.call<Page>('sessions.list', { limit: 2, cursor: second.nextCursor });
  assert.deepEqual(last.sessions.map(item => item.id), [`claude:${id(1)}`]);
  assert.equal(last.nextCursor, undefined);
  const period = await f.call<Page>('sessions.list', { since: '2026-09-02T00:00:00Z', until: '2026-09-04T00:00:00Z' });
  assert.deepEqual(period.sessions.map(item => item.id), [`claude:${id(3)}`, `claude:${id(2)}`]);
  await assert.rejects(f.call('sessions.list', { cursor: 'nonsense' }), { statusCode: 400 });
});

test('agents read a conversation backwards page by page, without tool calls unless asked', async t => {
  const f = await fixture(t);
  const session = id(1);
  await f.write(1, [
    claudeRow(session, 'user', 'first question', '2026-09-01T10:00:00.000Z', 'a'),
    claudeRow(session, 'assistant', [{ type: 'text', text: 'first answer' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], '2026-09-01T10:01:00.000Z', 'b'),
    claudeRow(session, 'user', 'second question', '2026-09-01T10:02:00.000Z', 'c'),
    claudeRow(session, 'assistant', 'second answer', '2026-09-01T10:03:00.000Z', 'd'),
  ]);
  await f.sessions.refresh();
  type Page = { messages: Array<{ role: string; text: string }>; hasMore: boolean; nextCursor?: string };
  const latest = await f.call<Page>('sessions.read', { id: `claude:${session}`, limit: 2 });
  assert.deepEqual(latest.messages.map(message => message.text), ['second question', 'second answer']);
  assert.equal(latest.hasMore, true);
  const earlier = await f.call<Page>('sessions.read', { id: `claude:${session}`, limit: 3, cursor: latest.nextCursor });
  assert.deepEqual(earlier.messages.map(message => message.text), ['first question', 'first answer']);
  assert.equal(earlier.hasMore, false);
  const withTools = await f.call<Page>('sessions.read', { id: `claude:${session}`, limit: 3, cursor: latest.nextCursor, tools: true });
  assert.deepEqual(withTools.messages.map(message => message.role), ['user', 'assistant', 'tool']);
});

test('agents find earlier sessions by keywords within a period, and read up to a match', async t => {
  const f = await fixture(t);
  await f.write(1, [
    claudeRow(id(1), 'user', 'Please fix the PAYMENT webhook retry', '2026-08-01T10:00:00.000Z', 'a'),
    claudeRow(id(1), 'assistant', 'The payment webhook now retries three times.', '2026-08-01T10:05:00.000Z', 'b'),
    claudeRow(id(1), 'user', 'Thanks, unrelated follow-up', '2026-08-01T10:06:00.000Z', 'c'),
  ]);
  await f.write(2, [
    claudeRow(id(2), 'user', '결제 웹훅 재시도 로그를 확인해 주세요', '2026-09-10T10:00:00.000Z', 'd'),
    claudeRow(id(2), 'assistant', [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'grep payment logs' } }], '2026-09-10T10:01:00.000Z', 'e'),
  ]);
  await f.write(3, [claudeRow(id(3), 'user', 'Nothing about it here', '2026-09-11T10:00:00.000Z', 'f')]);
  await f.sessions.refresh();
  type Found = { sessions: Array<{ id: string; matchCount: number; matches: Array<{ text: string; role: string; cursor: string }> }>; searched: number; nextCursor?: string };

  const words = await f.call<Found>('sessions.search', { query: 'webhook payment' });
  assert.deepEqual(words.sessions.map(item => [item.id, item.matchCount]), [[`claude:${id(1)}`, 2]]);
  assert.deepEqual(words.sessions[0].matches.map(match => match.role), ['assistant', 'user'], 'newest match first');
  assert.match(words.sessions[0].matches[1].text, /PAYMENT webhook/);

  const korean = await f.call<Found>('sessions.search', { query: '웹훅 재시도' });
  assert.deepEqual(korean.sessions.map(item => item.id), [`claude:${id(2)}`]);

  assert.deepEqual((await f.call<Found>('sessions.search', { query: 'payment' })).sessions.map(item => item.id), [`claude:${id(1)}`], 'tool calls are not searched by default');
  assert.deepEqual((await f.call<Found>('sessions.search', { query: 'payment', tools: true })).sessions.map(item => item.id), [`claude:${id(2)}`, `claude:${id(1)}`]);

  const inPeriod = await f.call<Found>('sessions.search', { query: 'payment', tools: true, since: '2026-09-01', until: '2026-09-30' });
  assert.deepEqual(inPeriod.sessions.map(item => item.id), [`claude:${id(2)}`]);
  assert.equal(inPeriod.searched, 2, 'a conversation last active before the period is not read');

  const paged = await f.call<Found>('sessions.search', { query: 'payment', tools: true, limit: 1 });
  assert.deepEqual(paged.sessions.map(item => item.id), [`claude:${id(2)}`]);
  const rest = await f.call<Found>('sessions.search', { query: 'payment', tools: true, limit: 1, cursor: paged.nextCursor });
  assert.deepEqual(rest.sessions.map(item => item.id), [`claude:${id(1)}`]);

  const around = await f.call<{ messages: Array<{ text: string }> }>('sessions.read', { id: `claude:${id(1)}`, cursor: words.sessions[0].matches[1].cursor });
  assert.deepEqual(around.messages.map(message => message.text), ['Please fix the PAYMENT webhook retry']);
  await assert.rejects(f.call('sessions.search', { query: 'x', since: '2026-09-02', until: '2026-09-01' }), { statusCode: 400 });
});

test('a search term with quotes matches what the JSONL file stores escaped', async t => {
  const f = await fixture(t);
  await f.write(1, [claudeRow(id(1), 'user', 'Rename "Old Name" to the new one', '2026-09-01T10:00:00.000Z', 'a')]);
  await f.sessions.refresh();
  const found = await f.call<{ sessions: Array<{ id: string }> }>('sessions.search', { query: '"old name"' });
  assert.deepEqual(found.sessions.map(item => item.id), [`claude:${id(1)}`]);
});

test('a long conversation is searched in parts, going on where the last part stopped', async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 40 }, (_, n) => claudeRow(id(1), 'user', `step ${n} ${n % 10 === 0 ? 'checkpoint' : 'filler '.repeat(4000)}`, `2026-09-01T10:${String(n).padStart(2, '0')}:00.000Z`, `r${n}`));
  await f.write(1, rows);
  await f.sessions.refresh();
  const session = `claude:${id(1)}`;
  const first = await f.sessions.search(session, { terms: ['checkpoint'], keep: 10, maxBytes: 1 });
  assert.ok(first!.next !== undefined && first!.count < 4, 'stopped early at a line boundary');
  let count = first!.count;
  for (let next: number | undefined = first!.next; next !== undefined;) {
    const part = await f.sessions.search(session, { terms: ['checkpoint'], keep: 10, maxBytes: 1, from: next, file: first!.file });
    assert.ok(part!.next === undefined || part!.next > next, 'always moves forward');
    count += part!.count; next = part!.next;
  }
  assert.equal(count, 4, 'every match found exactly once');
  // The same through the tool: a cursor inside the conversation finishes it before going on.
  const cursor = Buffer.from(JSON.stringify(['2026-09-01T10:39:00.000Z', session, first!.next, first!.file])).toString('base64url');
  const rest = await f.call<{ sessions: Array<{ id: string; matchCount: number }> }>('sessions.search', { query: 'checkpoint', cursor });
  assert.deepEqual(rest.sessions.map(item => [item.id, item.matchCount]), [[session, 4 - first!.count]]);
  // A place in another file (this one replaced since) is read again from the start.
  assert.equal((await f.sessions.search(session, { terms: ['checkpoint'], keep: 10, from: first!.next, file: first!.file! + 1 }))!.count, 4);
});

test('every search word counts, and letters outside ASCII match in either case', async t => {
  const f = await fixture(t);
  await f.write(1, [claudeRow(id(1), 'user', 'ÉCHEC du déploiement', '2026-09-01T10:00:00.000Z', 'a')]);
  await f.write(3, [claudeRow(id(3), 'user', 'Set the \u212aELVIN scale', '2026-09-03T10:00:00.000Z', 'c')]);
  await f.write(2, [claudeRow(id(2), 'user', 'alpha bravo charlie delta echo foxtrot golf hotel', '2026-09-02T10:00:00.000Z', 'b')]);
  await f.sessions.refresh();
  type Found = { sessions: Array<{ id: string }> };
  assert.deepEqual((await f.call<Found>('sessions.search', { query: 'échec' })).sessions.map(item => item.id), [`claude:${id(1)}`]);
  assert.deepEqual((await f.call<Found>('sessions.search', { query: 'kelvin' })).sessions.map(item => item.id), [`claude:${id(3)}`], 'the Kelvin sign lowercases to k');
  assert.deepEqual((await f.call<Found>('sessions.search', { query: 'alpha bravo charlie delta echo foxtrot golf hotel' })).sessions.map(item => item.id), [`claude:${id(2)}`]);
  assert.deepEqual((await f.call<Found>('sessions.search', { query: 'alpha bravo charlie delta echo foxtrot golf hotel zz' })).sessions, [], 'the shortest word counts too');
});

test('a conversation a search stopped inside keeps its place, however its activity changed since', async () => {
  const visits: Array<[string, number | undefined]> = [];
  const at = (day: string) => `2026-09-${day}T00:00:00.000Z`;
  let list: Session[] = [];
  const api = new TowerApi({ stateDir: tmpdir(), triggers: {} as TriggerService, sessions: { list: () => list, read: async () => undefined,
    search: async (session, query) => { visits.push([session, query.from]); return { count: 1, matches: [], bytes: 1 }; } } });
  const session = (id: string, day: string) => ({ id, updatedAt: at(day), createdAt: at('01'), title: id, cwd: '/w', provider: 'claude', status: 'completed', isSubagent: false }) as Session;
  const cursor = Buffer.from(JSON.stringify([at('10'), 'A', 100])).toString('base64url');
  type Found = { sessions: Array<{ id: string }>; nextCursor?: string };
  // Active again since: finished first, then the search goes on below where it was, not above B.
  list = [session('A', '20'), session('B', '15'), session('C', '05')];
  const first = await api.call('sessions.search', { query: 'x', cursor, limit: 1 }, agent) as Found;
  await api.call('sessions.search', { query: 'x', cursor: first.nextCursor, limit: 1 }, agent);
  assert.deepEqual(visits, [['A', 100], ['C', undefined]]);
  // A cursor naming a later time than the conversation has now still reads it once.
  visits.length = 0;
  list = [session('A', '09'), session('C', '05')];
  const all = await api.call('sessions.search', { query: 'x', cursor }, agent) as Found;
  assert.deepEqual(all.sessions.map(item => item.id), ['A', 'C']);
  assert.deepEqual(visits, [['A', 100], ['C', undefined]]);
});

test('a search stops inside a line too long to hold chat once its budget is spent', async t => {
  const f = await fixture(t);
  await f.write(1, [claudeRow(id(1), 'user', 'needle before', '2026-09-01T10:00:00.000Z', 'a'), { type: 'blob', data: 'x'.repeat(40 * 1024 * 1024) },
    claudeRow(id(1), 'user', 'needle after', '2026-09-01T10:02:00.000Z', 'b')]);
  await f.sessions.refresh();
  const session = `claude:${id(1)}`;
  let count = 0;
  let parts = 0;
  for (let from: number | undefined = 0, file: number | undefined; from !== undefined; parts++) {
    const part = await f.sessions.search(session, { terms: ['needle'], keep: 5, maxBytes: 1, deadline: 0, from, file });
    file = part!.file;
    assert.ok(part!.bytes <= 17 * 1024 * 1024, 'never reads much past the longest line kept');
    count += part!.count; from = part!.next;
  }
  assert.equal(count, 2);
  assert.ok(parts > 2, 'the long line was read in parts');
});
