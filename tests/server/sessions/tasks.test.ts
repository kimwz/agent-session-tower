import test from 'node:test';
import { until } from '../../helpers/until.js';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { applySummary, conversationSince, DAILY_CALLS, SessionTasks, summarizable, type SessionTaskDependencies } from '../../../server/sessions/tasks.js';
import { runAutoPromptModel, type AutoPromptModelRequest } from '../../../server/auto-prompt/native.js';
import { saveModelSettings } from '../../../server/models/settings.js';
import { initialModelSettings } from '../../../shared/models.js';
import { currentTask } from '../../../shared/session-tasks.js';
import type { ChatMessage, Session, SessionTask } from '../../../shared/types.js';
import { asideNames, blockQuarantine, captureErrors } from '../../helpers/quarantine.js';

const NOW = Date.now();
const iso = (offset: number) => new Date(NOW + offset).toISOString();
const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, nativeId: `n-${id}`, provider: 'claude', title: `Title ${id}`, cwd: '/work/app', project: 'app',
  status: 'completed', statusReason: '', createdAt: iso(-60_000), updatedAt: iso(-1_000), lastCompletedAt: iso(-1_000), lastMessage: 'Deployed.', messageCount: 4,
  isSubagent: false, resumable: true, ...patch });
let ids = 0;
const message = (role: ChatMessage['role'], text: string, at = iso(-2_000), toolName?: string): ChatMessage => ({ id: `m${ids++}`, role, text, timestamp: at, ...(toolName ? { toolName } : {}) });

type Answer = Record<string, unknown> | Error;
const update = (action: string, taskId: string, title: string, stage: string) => ({ action, taskId, title, stage });
const u = (action: string, taskId: string, title: string, stage: string) => ({ updates: [update(action, taskId, title, stage)] });
async function setup(t: test.TestContext, options: { list?: Session[]; answers?: Answer[]; history?: ChatMessage[]; startedAt?: number; prepare?: (stateDir: string) => Promise<unknown> } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-tasks-'));
  await options.prepare?.(stateDir);
  const list = options.list ?? [session('a')];
  const requests: AutoPromptModelRequest[] = [];
  const answers = [...options.answers ?? [u('new', '', 'Voice playback fix', '원인 분석중')]];
  let history = options.history ?? [message('user', 'Voice does not play on the master'), message('tool', '', iso(-1_900), 'Bash'), message('assistant', 'Looking into the audio path.', iso(-1_500))];
  let now = options.startedAt ?? NOW - 10_000;
  /** Pages of history, when a test reads more than one. */
  let pages: SessionTaskDependencies['history'] | undefined;
  const dependencies: SessionTaskDependencies = { stateDir, sessions: () => list, history: (...args) => pages ? pages(...args) : Promise.resolve({ messages: history, hasMore: false }), settleMs: 0, now: () => now,
    model: async request => { requests.push(request); const answer = answers.shift() ?? u('continue', '', '', '구현중'); if (answer instanceof Error) throw answer; return answer; } };
  const tasks = new SessionTasks(dependencies);
  await tasks.start();
  now = NOW;
  t.after(async () => { await tasks.close(); await rm(stateDir, { recursive: true, force: true }); });
  let changes = 0;
  tasks.on('change', () => changes++);
  /** Runs passes until nothing is left to do. */
  const settle = async () => {
    tasks.changed();
    // Wait for scheduled passes and their writes, including a slow CI filesystem.
    const pending = tasks as unknown as { timer?: unknown; running?: Promise<void>; again: boolean };
    await until(() => !pending.timer && !pending.running && !pending.again);
    await tasks.flush();
  };
  return { stateDir, tasks, list, requests, answers, settle, changes: () => changes, setHistory: (next: ChatMessage[]) => { history = next; }, setNow: (next: number) => { now = next; }, setPages: (next: SessionTaskDependencies['history']) => { pages = next; } };
}

test('a finished turn of any conversation is summarized; helpers, joined computers and running turns are not', () => {
  assert.equal(summarizable(session('a')), true);
  assert.equal(summarizable(session('a', { launchedBy: { kind: 'trigger', triggerId: 't' } })), true, 'trigger work is summarized too');
  assert.equal(summarizable(session('a', { closed: true })), true, 'a closed conversation can still work and be opened again');
  assert.equal(summarizable(session('a', { master: true })), true, "the master's conversation too");
  for (const patch of [{ status: 'working' }, { isSubagent: true }, { launchedByAgent: true }, { node: 'b' }, { creationPending: true }, { messageCount: 0 }] as Partial<Session>[]) {
    assert.equal(summarizable(session('a', patch)), false, JSON.stringify(patch));
  }
});

test('the first finished turn starts a task, with the model of the summarizer role and no tools', async t => {
  const { tasks, list, requests, settle, changes } = await setup(t);
  await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual({ provider: requests[0].provider, model: requests[0].model, effort: requests[0].effort }, { provider: 'claude', model: 'haiku', effort: 'off' });
  assert.match(requests[0].prompt, /Voice does not play on the master/);
  assert.match(requests[0].prompt, /first summary/);
  const shown = tasks.apply(list[0]).tasks!;
  assert.equal(shown.length, 1);
  assert.deepEqual({ title: shown[0].title, stage: shown[0].stage }, { title: 'Voice playback fix', stage: '원인 분석중' });
  assert.ok(changes() >= 1, 'a summary is a change the worker passes on');
  await settle();
  assert.equal(requests.length, 1, 'the same turn is summarized once');
});

test('the same work moves its task on; different work adds a task; the current task is the latest moved on', async t => {
  const { tasks, list, requests, answers, settle, setHistory } = await setup(t);
  await settle();
  const first = tasks.apply(list[0]).tasks![0];
  answers.push(u('continue', first.id, '', 'PR 리뷰중'));
  setHistory([message('user', 'Voice does not play on the master', iso(-2_000)), message('assistant', 'Looking into the audio path.', iso(-1_500)),
    message('user', 'Open a PR', iso(-500)), message('assistant', 'Opened #12.', iso(-400))]);
  list[0] = { ...list[0], messageCount: 6, lastMessage: 'Opened #12.' };
  await settle();
  let shown = tasks.apply(list[0]).tasks!;
  assert.equal(shown.length, 1, 'same context: no new row');
  assert.deepEqual({ title: shown[0].title, stage: shown[0].stage }, { title: 'Voice playback fix', stage: 'PR 리뷰중' });
  assert.match(requests[1].prompt, /Said since the last summary/);
  assert.doesNotMatch(requests[1].prompt, /Voice does not play/, 'only what was said since the last summary is sent');
  assert.match(requests[1].prompt, new RegExp(`"id":"${first.id}"`));

  answers.push(u('new', '', 'Snapshot compression', '설계중'));
  setHistory([message('user', 'Now compress the snapshot', iso(-300)), message('assistant', 'Designing it.', iso(-200))]);
  list[0] = { ...list[0], messageCount: 8, lastMessage: 'Designing it.' };
  await settle();
  shown = tasks.apply(list[0]).tasks!;
  assert.deepEqual(shown.map(task => [task.title, task.stage]), [['Voice playback fix', 'PR 리뷰중'], ['Snapshot compression', '설계중']]);
  assert.equal(currentTask(shown)?.title, 'Snapshot compression');
});

test('turns that ended back to back on different work each get their task, the last one current', async t => {
  const { tasks, list, settle, answers, setHistory } = await setup(t);
  await settle();
  const first = tasks.apply(list[0]).tasks![0];
  answers.push({ updates: [update('continue', first.id, '', '완료'), update('new', '', 'Release notes', '작성중')] });
  setHistory([message('user', 'Finish it', iso(-500)), message('assistant', 'Fixed.', iso(-450)), message('user', 'Now the release notes', iso(-400)), message('assistant', 'Writing.', iso(-300))]);
  list[0] = { ...list[0], messageCount: 8, lastMessage: 'Writing.' };
  await settle();
  const shown = tasks.apply(list[0]).tasks!;
  assert.deepEqual(shown.map(task => [task.title, task.stage]), [['Voice playback fix', '완료'], ['Release notes', '작성중']]);
  assert.equal(currentTask(shown)?.title, 'Release notes');
});

test('more than a page since the last summary is read back to it, page by page', async t => {
  const { list, requests, settle, setHistory, setPages } = await setup(t);
  await settle();
  const pages: Array<number | undefined> = [];
  const older = [message('user', 'ALREADY summarized', iso(-3_000)), message('user', 'EARLY request after the summary', iso(-900))];
  const latest = [message('assistant', 'LATE answer', iso(-100))];
  setHistory([]);
  setPages(async (_session, _limit, before) => {
    pages.push(before);
    return before === undefined ? { messages: latest, hasMore: true, nextBefore: 7 } : { messages: older, hasMore: true, nextBefore: 3 };
  });
  list[0] = { ...list[0], messageCount: 9, lastMessage: 'LATE answer' };
  await settle();
  assert.deepEqual(pages, [undefined, 7], 'reads back until it reaches what was summarized');
  assert.match(requests[1].prompt, /EARLY request after the summary[\s\S]*LATE answer/);
  assert.doesNotMatch(requests[1].prompt, /ALREADY summarized/);
});

test('an empty history page with older pages behind it is read past', async t => {
  const { tasks, list, requests, settle, setPages } = await setup(t);
  setPages(async (_session, _limit, before) =>
    before === undefined ? { messages: [], hasMore: true, nextBefore: 9 } : { messages: [message('user', 'BEHIND an empty page')], hasMore: false });
  await settle();
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /BEHIND an empty page/);
  assert.ok(tasks.apply(list[0]).tasks);
});

test('a failed or unusable summary changes nothing and is tried once more later', async t => {
  const { tasks, list, requests, settle, setNow } = await setup(t, { answers: [new Error('model down'), u('new', '', '', ''), u('new', '', 'Late', '완료')] });
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(tasks.apply(list[0]).tasks, undefined);
  setNow(NOW + 6 * 60_000);
  await settle();
  assert.equal(requests.length, 2, 'retried after the wait');
  assert.equal(tasks.apply(list[0]).tasks, undefined, 'an answer without stage or title is rejected');
  setNow(NOW + 20 * 60_000);
  await settle();
  assert.equal(requests.length, 2, 'a turn that failed twice is passed over');
});

test('only turns that end after the summaries started are read, and working conversations wait', async t => {
  const list = [session('old', { lastCompletedAt: iso(-60_000), updatedAt: iso(-60_000) }), session('busy', { status: 'working' }), session('new')];
  const { requests, settle } = await setup(t, { list });
  await settle();
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /Title new/);
});

test('summaries are kept across restarts, and the model follows Settings › Models', async t => {
  const { stateDir, tasks, list, settle, requests, answers, setHistory } = await setup(t);
  await settle();
  await tasks.flush();
  const saved = JSON.parse(await readFile(join(stateDir, 'session-tasks.json'), 'utf8'));
  assert.equal(saved.sessions.a.tasks[0].title, 'Voice playback fix');
  const again = new SessionTasks({ stateDir, sessions: () => list, history: async () => ({ messages: [], hasMore: false }), model: async () => ({}) });
  await again.start();
  assert.equal(again.apply(list[0]).tasks?.[0].title, 'Voice playback fix');

  const settings = initialModelSettings();
  settings.roles['sessions.summarizer'] = { provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol', effort: 'low' } };
  await saveModelSettings(stateDir, settings);
  answers.push(u('continue', saved.sessions.a.tasks[0].id, '', '배포됨'));
  setHistory([message('user', 'Deploy', iso(-100)), message('assistant', 'Deployed 1.2.', iso(-50))]);
  list[0] = { ...list[0], messageCount: 6, lastMessage: 'Deployed 1.2.' };
  await settle();
  assert.deepEqual({ provider: requests[1].provider, model: requests[1].model, effort: requests[1].effort }, { provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
});

test('model answers are cleaned and bounded', () => {
  const at = iso(0);
  const one = applySummary([], u('new', '', '  A\nlong   title ' + 'x'.repeat(200), '구현중이고 아주 길게 쓴 단계 설명'), at);
  assert.equal(one[0].title.length, 80);
  assert.doesNotMatch(one[0].title, /\n/);
  assert.equal(one[0].stage.length, 16);
  const unknown = applySummary(one, u('continue', 'missing', 'Other work', '설계중'), at);
  assert.equal(unknown.length, 2, 'a continue for an unknown task starts a new one');
  assert.throws(() => applySummary(one, u('continue', 'missing', '', '설계중'), at));
  let many: SessionTask[] = [];
  for (let i = 0; i < 150; i++) many = applySummary(many, u('new', '', `T${i}`, 's'), at);
  assert.equal(many.length, 150, 'every task is kept');
  assert.equal(applySummary([], { updates: Array.from({ length: 25 }, (_, i) => update('new', '', `U${i}`, 's')) }, at).length, 25, 'every update of a summary is applied');
});

test('after a summary the model reads on from where it stopped, oldest first; the first time, the latest part', () => {
  const messages = [message('user', 'old', iso(-5_000)), message('user', 'new request', iso(-3_000)), message('tool', '', iso(-2_900), 'Bash'), message('tool', '', iso(-2_800), 'Bash'),
    message('system', 'Background check passed', iso(-2_700)), message('assistant', 'answer', iso(-2_000))];
  assert.deepEqual(conversationSince(messages, iso(-4_000)), { text: 'Person: new request\n\n[Bash]\n\nNotice: Background check passed\n\nAgent: answer', upTo: iso(-2_000), more: false });
  assert.deepEqual(conversationSince(messages, iso(-1_000)), { text: '', more: false });
  const long = Array.from({ length: 30 }, (_, i) => message('assistant', `${i} ${'y'.repeat(1_400)}`, iso(-1_000 + i)));
  const first = conversationSince(long);
  assert.ok(first.text.length <= 14_000);
  assert.match(first.text, /29 y/, 'the first summary reads the newest part');
  assert.equal(first.more, false);
  const half = long.slice(0, 15);
  const part = conversationSince(half, iso(-2_000));
  assert.match(part.text, /^Agent: 0 y/, 'later, the oldest unread part comes first');
  assert.equal(part.more, true);
  const rest = conversationSince(half, part.upTo);
  assert.equal(rest.more, false);
  assert.match(rest.text, /14 y/);
  assert.equal(part.text.split('\n\n').length + rest.text.split('\n\n').length, 15, 'nothing read twice or skipped');
});

test('a long stretch since the last summary is read in parts, so no work in it is passed over', async t => {
  const { tasks, list, requests, answers, settle, setHistory } = await setup(t);
  await settle();
  const first = tasks.apply(list[0]).tasks![0];
  setHistory(Array.from({ length: 15 }, (_, i) => message('assistant', `${i} ${'z'.repeat(1_400)}`, iso(-900 + i))));
  answers.push(u('continue', first.id, '', '구현중'), u('new', '', 'Second thing', '설계중'));
  list[0] = { ...list[0], messageCount: 40, lastMessage: 'z' };
  await settle();
  assert.equal(requests.length, 3, 'two parts, two calls');
  assert.match(requests[1].prompt, /Agent: 0 z/);
  assert.match(requests[2].prompt, /Agent: 14 z/);
  assert.deepEqual(tasks.apply(list[0]).tasks!.map(task => task.title), ['Voice playback fix', 'Second thing']);
  await settle();
  assert.equal(requests.length, 3, 'then the turn is done');
});

test('a day has a call limit', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-tasks-limit-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(join(stateDir, 'session-tasks.json'), JSON.stringify({ version: 1, startedAt: iso(-10_000), calls: { day: new Date(NOW).toISOString().slice(0, 10), count: DAILY_CALLS - 1 }, sessions: {} }));
  const list = Array.from({ length: 3 }, (_, i) => session(`s${i}`));
  let calls = 0;
  const tasks = new SessionTasks({ stateDir, sessions: () => list, history: async () => ({ messages: [message('user', 'hello')], hasMore: false }), settleMs: 0, now: () => NOW,
    model: async () => { calls++; return u('new', '', 'T', 's'); } });
  await tasks.start();
  t.after(() => tasks.close());
  for (let i = 0; i < 6; i++) { tasks.changed(); await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.equal(calls, 1, 'one call was left for today');
  assert.equal(list.filter(item => tasks.apply(item).tasks).length, 1);
});

test('a summary through a fake Claude CLI leaves no saved conversation and passes the role model', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-tasks-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = join(dir, 'args.json');
  const script = join(dir, 'claude.mjs');
  await writeFile(script, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.argv.slice(2)));
let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { updates: [{ action: 'new', taskId: '', title: 'From the CLI', stage: '조사중' }] } }) + '\\n');
});`);
  await chmod(script, 0o700);
  const list = [session('cli')];
  const tasks = new SessionTasks({ stateDir: dir, sessions: () => list, history: async () => ({ messages: [message('user', 'Why is it slow?')], hasMore: false }), settleMs: 0, now: () => NOW,
    model: (request, options) => runAutoPromptModel(request, { stateDir: dir, timeoutMs: options.timeoutMs, findExecutable: async () => process.execPath,
      spawnProcess: ((command: string, args: string[], spawnOptions: object) => spawn(command, [script, ...args], spawnOptions as never)) as never }) });
  await tasks.start();
  // Started before the turn ended.
  list[0] = { ...list[0], lastCompletedAt: new Date(Date.now() + 1_000).toISOString() };
  t.after(() => tasks.close());
  for (let i = 0; i < 40 && !tasks.apply(list[0]).tasks; i++) { tasks.changed(); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(tasks.apply(list[0]).tasks?.[0].title, 'From the CLI');
  const args = JSON.parse(await readFile(report, 'utf8')) as string[];
  assert.ok(args.includes('--no-session-persistence'), 'no native conversation is saved');
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'haiku']);
  assert.equal(args.includes('--effort'), false, 'thinking off passes no effort');
});

test('closing ends a summary underway instead of waiting for it, and saves nothing for that turn', { timeout: 10_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-tasks-close-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  // Ended after the summaries started.
  const list = [session('a', { lastCompletedAt: iso(1_000) })];
  let started!: () => void;
  const asked = new Promise<void>(resolve => { started = resolve; });
  const tasks = new SessionTasks({ stateDir, sessions: () => list, history: async () => ({ messages: [message('user', 'hello')], hasMore: false }), settleMs: 0, now: () => NOW,
    model: request => { started(); return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))); } });
  await tasks.start();
  for (let i = 0; i < 3; i++) { tasks.changed(); await new Promise(resolve => setTimeout(resolve, 5)); }
  await asked;
  assert.equal(tasks.inFlight(), true);
  const at = Date.now();
  await tasks.close();
  assert.ok(Date.now() - at < 1_000, 'close does not wait out the call');
  assert.equal(tasks.apply(list[0]).tasks, undefined);
});

test('turns that need no model call do not count against the day', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-tasks-count-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const list = [session('a', { lastCompletedAt: iso(1_000) })];
  let calls = 0;
  const tasks = new SessionTasks({ stateDir, sessions: () => list, history: async () => ({ messages: [message('system', '')], hasMore: false }), settleMs: 0, now: () => NOW,
    model: async () => { calls++; return u('new', '', 'T', 's'); } });
  await tasks.start();
  t.after(() => tasks.close());
  for (let i = 0; i < 4; i++) { tasks.changed(); await new Promise(resolve => setTimeout(resolve, 15)); }
  await tasks.flush();
  assert.equal(calls, 0);
  const saved = JSON.parse(await readFile(join(stateDir, 'session-tasks.json'), 'utf8'));
  assert.equal(saved.calls.count, 0);
  assert.ok(saved.sessions.a, 'the turn still counts as read');
});

test('a long stretch waiting for the next day is not read again and again meanwhile', { timeout: 10_000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-tasks-wait-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const long = Array.from({ length: 15 }, (_, i) => message('assistant', `${i} ${'w'.repeat(1_400)}`, iso(-900 + i)));
  await writeFile(join(stateDir, 'session-tasks.json'), JSON.stringify({ version: 1, startedAt: iso(-10_000), calls: { day: new Date(NOW).toISOString().slice(0, 10), count: DAILY_CALLS },
    sessions: { a: { mark: 'old', upTo: iso(-2_000), tasks: [{ id: 't', title: 'T', stage: 's', startedAt: iso(-3_000), updatedAt: iso(-3_000) }] } } }));
  const list = [session('a')];
  let reads = 0;
  const tasks = new SessionTasks({ stateDir, sessions: () => list, history: async () => { reads++; return { messages: long, hasMore: false }; }, settleMs: 0, now: () => NOW,
    model: async () => { throw new Error('the day is used up'); } });
  await tasks.start();
  t.after(() => tasks.close());
  for (let i = 0; i < 3; i++) { tasks.changed(); await new Promise(resolve => setTimeout(resolve, 15)); }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(reads <= 3, `read ${reads} times`);
});

test('unreadable session tasks are moved aside and start empty', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-tasks-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const path = join(stateDir, 'session-tasks.json');
  await writeFile(path, '{ not json', { mode: 0o600 });
  const logged = captureErrors(t, path);
  const tasks = new SessionTasks({ stateDir, sessions: () => [], history: async () => ({ messages: [], hasMore: false }), model: async () => ({}) });
  t.after(() => tasks.close());
  await tasks.start();
  await tasks.flush();
  assert.equal(tasks.apply(session('a')).tasks, undefined);
  const [aside] = await asideNames(path);
  assert.equal(await readFile(join(stateDir, aside), 'utf8'), '{ not json');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).sessions, {}, 'fresh state is saved');
  assert.match(String(logged[0].args[0]), /^Session tasks were set aside: /);
  assert.equal(logged[0].present, false, 'logged after the move');
});

test('session tasks that cannot be moved aside are logged and the summaries still start', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-tasks-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const path = join(stateDir, 'session-tasks.json');
  await writeFile(path, '{ not json', { mode: 0o600 });
  const blocked = await blockQuarantine(t, path);
  const logged = captureErrors(t, path);
  const tasks = new SessionTasks({ stateDir, sessions: () => [], history: async () => ({ messages: [], hasMore: false }), model: async () => ({}) });
  t.after(() => tasks.close());
  await tasks.start();
  blocked.release();
  await tasks.flush();
  assert.match(String(logged[0].args[0]), /^Session tasks were set aside: /);
  assert.deepEqual(await readdir(blocked.aside), ['occupied'], 'the move failed');
});

test('session tasks that cannot be moved aside are never written over, and summaries go on in memory', async t => {
  let blocked: Awaited<ReturnType<typeof blockQuarantine>> | undefined;
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const { stateDir, tasks, list, settle } = await setup(t, { prepare: async dir => {
    await writeFile(join(dir, 'session-tasks.json'), '{ not json', { mode: 0o600 });
    blocked = await blockQuarantine(t, join(dir, 'session-tasks.json'));
  } });
  blocked!.release();
  await settle();
  assert.equal(tasks.apply(list[0]).tasks?.[0].title, 'Voice playback fix', 'the summary is kept in memory');
  await tasks.flush();
  assert.equal(await readFile(join(stateDir, 'session-tasks.json'), 'utf8'), '{ not json');
  assert.deepEqual((await readdir(stateDir)).filter(name => name.startsWith('session-tasks.json')).sort(), ['session-tasks.json', basename(blocked!.aside)].sort());
  assert.equal(logged.filter(args => String(args[0]).startsWith('Session tasks could not be moved aside')).length, 1, 'said once');
});

test('session tasks of the wrong shape are moved aside', async t => {
  const { stateDir, tasks } = await setup(t, { prepare: dir => writeFile(join(dir, 'session-tasks.json'), '[]', { mode: 0o600 }) });
  await tasks.flush();
  const path = join(stateDir, 'session-tasks.json');
  const [aside] = await asideNames(path);
  assert.ok(aside);
  assert.equal(await readFile(join(stateDir, aside), 'utf8'), '[]');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1, 'fresh state is saved');
});
