import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TowerError } from '../../../shared/errors.js';
import { MASTER_FOLDER } from '../../../shared/master.js';
import { TodoRequestSchema, type TodoOp } from '../../../shared/todo/ops.js';
import type { TodoTaskDetail } from '../../../shared/todo/types.js';
import type { CreateSessionRequest, Run } from '../../../shared/types.js';
import { TODO_AGENT_START_WAIT_MS, TodoAgents, todoAgentPrompt, todoMasterFolder, type AgentSession } from '../../../server/todo/agents.js';
import { TODO_RETENTION_MS, TodoStore } from '../../../server/todo/store.js';
import { TODO_DATA_TABLES } from '../../../server/todo/schema.js';

/**
 * Issue masters against a real todo file and a fake computer: sessions as a list the test changes, and every reopen
 * and hand-over recorded in order.
 */
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-agents-'));
  let clock = new Date('2026-10-17T09:00:00.000Z');
  const store = new TodoStore(dir, { now: () => clock });
  store.start();
  const sessions: AgentSession[] = [];
  /** Sessions moved to compressed storage: not listed, but a reopen brings them back. */
  const cold = new Map<string, AgentSession>();
  const runs = new Map<string, Pick<Run, 'sessionId'>>();
  const calls: string[] = [];
  const created: CreateSessionRequest[] = [];
  let changes = 0, hosts = 0, sequence = 0;
  const session = (id: string, cwd: string, extra: Partial<AgentSession> = {}): AgentSession => {
    const item: AgentSession = { id, cwd, provider: 'claude', status: 'idle', createdAt: new Date(clock.getTime() + sequence++).toISOString(), isSubagent: false, ...extra };
    sessions.push(item);
    return item;
  };
  const hooks = {
    create: async (input: CreateSessionRequest) => ({ session: session(`issue-${sequence}`, input.cwd) }),
    requestArchive: async (_ids: string[]) => {},
  };
  const agents = new TodoAgents({
    stateDir: dir, store,
    sessions: () => sessions.map(item => ({ ...item })),
    run: id => runs.get(id),
    reopen: async id => {
      calls.push(`reopen ${id}`);
      if (cold.has(id)) { sessions.push(cold.get(id)!); cold.delete(id); }
      const found = sessions.find(item => item.id === id);
      if (found) found.closed = false;
      return found && { ...found };
    },
    requestArchive: async ids => { calls.push(`archive ${ids.join(',')}`); await hooks.requestArchive(ids); },
    createSession: async input => { created.push(input); return hooks.create(input); },
    uncertain: error => (error as { disposition?: string }).disposition === 'uncertain',
    model: async () => ({ provider: 'claude', model: 'opus', effort: 'high' }),
    writeGuide: async (folder, taskId) => { calls.push(`guide ${taskId} ${folder === todoMasterFolder(dir, taskId)}`); },
    startHost: async () => { hosts++; },
    onChange: () => { changes++; },
    now: () => clock.getTime(),
  });
  t.after(async () => { agents.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  // As the web answers a change (server/index.ts): the masters it moved, at the revision that moved them.
  const apply = (...ops: TodoOp[]) => {
    const answer = store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops }));
    const moved = agents.settle();
    return { ...answer, revision: Object.keys(moved).length ? store.revision() : answer.revision, agents: moved };
  };
  const tick = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  const folder = (taskId: string) => todoMasterFolder(dir, taskId);
  return { dir, store, agents, sessions, cold, runs, calls, created, hooks, session, apply, tick, folder, changes: () => changes, hosts: () => hosts };
}

const kind = (error: unknown) => error instanceof TowerError ? error.kind : undefined;
const complete = (id: string, completionId: string, occurrence: string | null = null): TodoOp => ({ op: 'task.complete', id, completionId, occurrence, today: '2026-10-17' });

test('the owner starts an issue master: a session in its folder, with its guide, the todo after the first message, and the host running', async t => {
  const { store, agents, created, calls, apply, folder, hosts } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'Fix the login page', description: 'It fails on Safari.' });
  const agent = await agents.begin('a', '이거 고쳐줘');
  assert.equal(agent.state, 'active');
  assert.equal(agent.provider, 'claude');
  assert.equal(created.length, 1);
  assert.deepEqual({ ...created[0], prompt: undefined }, { provider: 'claude', model: 'opus', effort: 'high', cwd: folder('a'), prompt: undefined, title: '이슈: Fix the login page' });
  assert.match(created[0].prompt, /^이거 고쳐줘\n\n--- 이 할 일의 내용/);
  assert.match(created[0].prompt, /할 일 id: a\n제목: Fix the login page/);
  assert.match(created[0].prompt, /설명:\nIt fails on Safari\./);
  assert.deepEqual(calls, ['guide a true']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hosts(), 1);
  assert.deepEqual(store.overview().agents, { a: agent });
  assert.ok(agent.sessionId);
});

test('a start is refused for a closed or gone todo and for one that has a master; a refused start leaves nothing, a lost answer is found or given up', async t => {
  const { store, agents, hooks, session, apply, tick, folder } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' }, { op: 'task.create', id: 'b', content: 'B' }, { op: 'task.create', id: 'c', content: 'C' }, { op: 'task.create', id: 'd', content: 'D' });
  apply(complete('d', 'cd'));
  await assert.rejects(agents.begin('d', 'go'), error => kind(error) === 'conflict');
  await assert.rejects(agents.begin('missing', 'go'), error => kind(error) === 'not-found');
  await agents.begin('a', 'go');
  await assert.rejects(agents.begin('a', 'again'), error => kind(error) === 'conflict');

  // Refused by the worker: no row, the owner may send again.
  hooks.create = async () => { throw new TowerError('unavailable', 'not now', { disposition: 'not-admitted' }); };
  await assert.rejects(agents.begin('b', 'go'), /not now/);
  assert.equal(store.agent('b'), undefined);

  // The answer was lost: the row waits, and a pass finds the session the start made in the folder.
  hooks.create = async input => { session('late-b', input.cwd); throw new TowerError('unavailable', 'lost', { disposition: 'uncertain' }); };
  await assert.rejects(agents.begin('b', 'go'), /lost/);
  await agents.schedule();
  assert.deepEqual({ state: store.agent('b')!.state, sessionId: store.agent('b')!.sessionId }, { state: 'active', sessionId: 'late-b' });

  // Lost with nothing in the folder: the row stays two minutes, then goes.
  hooks.create = async () => { throw new TowerError('unavailable', 'lost', { disposition: 'uncertain' }); };
  await assert.rejects(agents.begin('c', 'go'), /lost/);
  await agents.schedule();
  assert.equal(store.agent('c')!.state, 'starting');
  tick(TODO_AGENT_START_WAIT_MS + 1000);
  await agents.schedule();
  assert.equal(store.agent('c'), undefined);
  assert.equal(folder('c').endsWith('/todo-masters/c'), true);
});

test('completing a todo hands its master, its folder and its family to retention without hiding or stopping them; reopening takes back only the master, from compressed storage too', async t => {
  const { store, agents, sessions, cold, calls, session, apply, folder } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  const { sessionId } = await agents.begin('a', 'go');
  const extra = session('extra', folder('a'));
  const sub = session('sub', folder('a'), { isSubagent: true, parentId: sessionId });
  const child = session('child', '/work/project');
  store.addFamily('child', 'a');
  calls.length = 0;

  const answer = apply(complete('a', 'ca'));
  assert.equal(answer.agents.a?.state, 'closing');
  assert.equal(answer.revision, store.revision());
  await agents.schedule();
  assert.deepEqual(calls, [`archive ${sessionId},extra,child`], 'its own sub-agents go with it in retention, not one by one');
  assert.equal(store.agent('a')!.state, 'closed');
  assert.equal(store.overview().agents?.a, undefined);
  assert.equal(sub.closed, undefined);
  assert.equal(extra.closed, undefined);
  assert.equal(child.closed, undefined);

  // Moved to compressed storage meanwhile: reopening asks for it by id, which brings it back.
  const master = sessions.splice(sessions.findIndex(item => item.id === sessionId), 1)[0];
  cold.set(sessionId!, master);
  calls.length = 0;
  const reopened = apply({ op: 'task.uncomplete', id: 'a', completionId: 'ca' });
  assert.equal(reopened.agents.a?.state, 'active');
  await agents.schedule();
  assert.deepEqual(calls, [`reopen ${sessionId}`]);
  assert.ok(sessions.some(item => item.id === sessionId));
  // Reopened while it was still listed (its hand-over not yet carried out), it is taken back all the same.
  calls.length = 0;
  apply(complete('a', 'ca2'));
  await agents.schedule();
  assert.deepEqual(calls, [`archive ${sessionId}`]);
  apply({ op: 'task.uncomplete', id: 'a', completionId: 'ca2' });
  await agents.schedule();
  assert.deepEqual(calls, [`archive ${sessionId}`, `reopen ${sessionId}`]);
});

test('a repeating todo closes its master only with its last occurrence; deleting closes it and restoring reopens it', async t => {
  const { store, agents, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'r', content: 'Daily', dueDate: '2026-10-17', recurrence: { freq: 'day', interval: 1, until: '2026-10-18' } },
    { op: 'task.create', id: 'x', content: 'X' });
  await agents.begin('r', 'go');
  await agents.begin('x', 'go');
  assert.deepEqual(apply(complete('r', 'c1', '2026-10-17')).agents, {});
  assert.equal(store.agent('r')!.state, 'active');
  assert.equal(apply(complete('r', 'c2', '2026-10-18')).agents.r?.state, 'closing');

  assert.equal(apply({ op: 'task.delete', id: 'x' }).agents.x?.state, 'closing');
  await agents.schedule();
  assert.equal(store.agent('x')!.state, 'closed');
  assert.equal(apply({ op: 'task.restore', id: 'x' }).agents.x?.state, 'active');
});

test('a request sent again answers what it did first and moves no master', async t => {
  const { store, agents, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  await agents.begin('a', 'go');
  const request = TodoRequestSchema.parse({ requestId: randomUUID(), ops: [complete('a', 'ca')] });
  store.apply(request);
  assert.equal(agents.settle().a?.state, 'closing');
  await agents.schedule();
  apply({ op: 'task.uncomplete', id: 'a', completionId: 'ca' });
  await agents.schedule();
  assert.equal(store.agent('a')!.state, 'active');
  store.apply(request);
  assert.deepEqual(agents.settle(), {});
  assert.equal(store.agent('a')!.state, 'active');
});

test('a restored backup keeps the masters (they are not in it) and moves them to what its todos say', async t => {
  const { store, agents, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' }, { op: 'task.create', id: 'b', content: 'B' });
  apply(complete('a', 'ca'));
  const backup = store.backupData()!;
  assert.equal(Object.keys(backup.tables).some(table => table.startsWith('todo_agent')), false);
  assert.equal((TODO_DATA_TABLES as readonly string[]).includes('todo_agents'), false);
  apply({ op: 'task.uncomplete', id: 'a', completionId: 'ca' });
  await agents.begin('a', 'go');
  store.restoreData(backup.schema, backup.tables);
  assert.equal(store.agent('a')!.state, 'active');
  await agents.schedule();
  assert.equal(store.agent('a')!.state, 'closed');
});

test('a todo reopened while its master is being closed ends open, with its master taken back', async t => {
  const { store, agents, hooks, calls, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  const { sessionId } = await agents.begin('a', 'go');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  hooks.requestArchive = async () => { await held; };
  calls.length = 0;
  apply(complete('a', 'ca'));
  const closing = agents.schedule();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [`archive ${sessionId}`]);
  // Reopened while the hand-over is under way; the pass asked for meanwhile runs after this one.
  assert.equal(apply({ op: 'task.uncomplete', id: 'a', completionId: 'ca' }).agents.a?.state, 'active');
  release();
  await closing;
  await agents.schedule();
  assert.equal(store.agent('a')!.state, 'active');
  assert.equal(calls.at(-1), `reopen ${sessionId}`);
});

test('an issue master that compacts or starts twice keeps the newest session; the others are handed over', async t => {
  const { store, agents, calls, session, apply, tick, folder } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  const { sessionId } = await agents.begin('a', 'go');
  tick(1000);
  session('newer', folder('a'));
  session('pending', folder('a'), { creationPending: true });
  calls.length = 0;
  await agents.schedule();
  assert.equal(store.agent('a')!.sessionId, 'newer');
  assert.deepEqual(calls, [`archive ${sessionId}`]);
});

test('sessions an issue master starts, directly or through them, join its family; the main master\'s and others\' do not', async t => {
  const { dir, store, agents, sessions, runs, calls, session, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  const { sessionId } = await agents.begin('a', 'go');
  runs.set('run-master', { sessionId: sessionId! });
  session('child', '/work/one');
  agents.recordFamily({ sessionId: 'child', delegation: { parentRunId: 'run-master', rootRunId: 'run-master' } });
  runs.set('run-child', { sessionId: 'child' });
  session('grandchild', '/work/two');
  agents.recordFamily({ sessionId: 'grandchild', delegation: { parentRunId: 'run-child', rootRunId: 'run-master' } });
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId), ['child', 'grandchild']);
  assert.deepEqual(store.agentSessions(), { [sessionId!]: { taskId: 'a', title: 'A' }, child: { taskId: 'a', title: 'A' }, grandchild: { taskId: 'a', title: 'A' } });

  session('main', join(dir, MASTER_FOLDER));
  runs.set('run-main', { sessionId: 'main' });
  session('from-main', '/work/three');
  agents.recordFamily({ sessionId: 'from-main', delegation: { parentRunId: 'run-main', rootRunId: 'run-main' } });
  session('owner', '/work/four');
  agents.recordFamily({ sessionId: 'owner' });
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId), ['child', 'grandchild']);

  // Closed: a session one of them starts now is handed over by the next pass.
  apply(complete('a', 'ca'));
  await agents.schedule();
  calls.length = 0;
  session('late', '/work/five');
  agents.recordFamily({ sessionId: 'late', delegation: { parentRunId: 'run-child', rootRunId: 'run-master' } });
  await agents.schedule();
  assert.deepEqual(calls, ['archive late']);
  assert.equal(sessions.find(item => item.id === 'late')!.closed, undefined);
  assert.deepEqual(store.agentSessions(), {});
  assert.equal(store.hasOpenAgents(), false);
});

test('a closed master\'s family record goes once none of its sessions can lose work; its row goes with its task, once closed', async t => {
  const { store, agents, session, apply, tick } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' }, { op: 'task.create', id: 'b', content: 'B' });
  await agents.begin('a', 'go');
  await agents.begin('b', 'go');
  const working = session('working', '/work/one', { status: 'working' });
  store.addFamily('working', 'a');
  apply({ op: 'task.delete', id: 'a' });
  await agents.schedule();
  assert.equal(store.agent('a')!.state, 'closed');
  await agents.schedule();
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId), ['working']);
  working.status = 'idle';
  await agents.schedule();
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId), []);

  // Removed for good after 30 days: the closed master goes with it; one not yet closed waits for its pass.
  apply({ op: 'task.delete', id: 'b' });
  tick(TODO_RETENTION_MS + 1000);
  store.purge();
  assert.equal(store.agent('a'), undefined);
  assert.equal(store.agent('b')!.state, 'closing');
  await agents.schedule();
  assert.equal(store.agent('b')!.state, 'closed');
  store.purge();
  assert.equal(store.agent('b'), undefined);
});

test('nothing is decided while the sessions cannot be known', async t => {
  const { dir, store } = await fixture(t);
  let asked = 0;
  const agents = new TodoAgents({ stateDir: dir, store, sessions: () => undefined, run: () => undefined,
    reopen: async () => { asked++; }, requestArchive: async () => { asked++; }, createSession: async () => { throw new Error('unused'); }, uncertain: () => false,
    model: async () => ({ provider: 'codex' }), writeGuide: async () => {}, startHost: async () => {}, onChange: () => {} });
  store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a', content: 'A' }] }));
  store.changeAgent('a', null, { state: 'active', sessionId: 's', provider: 'codex' });
  await agents.schedule();
  assert.equal(asked, 0);
  assert.equal(store.agent('a')!.state, 'active');
});

const detail = (overrides: Partial<TodoTaskDetail['task']> = {}, extra: Partial<Pick<TodoTaskDetail, 'subtasks' | 'comments' | 'files'>> = {}): Pick<TodoTaskDetail, 'task' | 'subtasks' | 'comments' | 'files'> => ({
  task: { id: 't1', projectId: 'work', sectionId: 'doing', parentId: null, content: 'Ship it', description: 'The **plan**.', priority: 1, dueDate: '2026-10-20', dueTime: '09:30',
    recurrence: null, durationMin: 30, deadlineDate: '2026-10-24', labelIds: ['l1'], sortKey: 'a', dayOrder: null, completedAt: null, createdAt: '', updatedAt: '', deletedAt: null, ...overrides },
  subtasks: [], comments: [], files: [], ...extra,
});
const names = { projects: [{ id: 'work', name: 'Work', inbox: false }], sections: [{ id: 'doing', name: 'Doing' }], labels: [{ id: 'l1', name: 'urgent' }] } as never;
const comment = (index: number, body: string) => ({ id: `c${index}`, taskId: 't1', body, createdAt: `2026-10-17T09:${String(index % 60).padStart(2, '0')}:00.000Z`, updatedAt: '', deletedAt: null });

test('the first prompt carries the todo as data: names, dates, sub-tasks, the latest 20 comments and attachments at their paths', () => {
  const prompt = todoAgentPrompt('봐줘', detail({}, {
    subtasks: [{ ...detail().task, id: 's1', content: 'Write', completedAt: '2026-10-17T00:00:00.000Z' }, { ...detail().task, id: 's2', content: 'Test' }],
    comments: Array.from({ length: 25 }, (_, index) => comment(index, `note ${index}`)),
    files: [{ id: 'f1', taskId: 't1', commentId: null, name: 'shot.png', mimeType: 'image/png', size: 2048, sha256: 'ab'.repeat(32), createdAt: '', deletedAt: null },
      { id: 'f2', taskId: 't1', commentId: 'c1', name: 'gone.pdf', mimeType: 'application/pdf', size: 10, sha256: 'cd'.repeat(32), createdAt: '', deletedAt: null, missing: true }],
  }), names, sha256 => `/state/todo-files/${sha256}`);
  assert.match(prompt, /^봐줘\n\n--- 이 할 일의 내용 \(Tower가 붙인 참고 데이터\) ---\n할 일 id: t1\n제목: Ship it\n프로젝트: Work \/ 섹션: Doing\n/);
  assert.match(prompt, /날짜: 2026-10-20 09:30 \(30분\) · 마감: 2026-10-24 · 우선순위: P1 · 라벨: urgent/);
  assert.match(prompt, /설명:\nThe \*\*plan\*\*\./);
  assert.match(prompt, /하위 작업:\n- \[x\] Write\n- \[ \] Test/);
  assert.match(prompt, /최근 댓글 \(25개 중 20개, 오래된 것부터\):\n- 2026-10-17T09:05:00.000Z\n  note 5\n/);
  assert.doesNotMatch(prompt, /note 4\n/);
  assert.match(prompt, new RegExp(`- shot.png \\(2.0 KB\\): /state/todo-files/${'ab'.repeat(32)}`));
  assert.match(prompt, /- gone.pdf \(10 B, 댓글 첨부\): 이 컴퓨터에 없음/);
  assert.match(prompt, /시작하기 전에 첨부 파일\(이미지·문서\)을 먼저 읽으세요\./);
  assert.doesNotMatch(prompt, /todos_get/);
});

test('a prompt too long for the limit cuts the description and the oldest comments, and says where the rest is', () => {
  const long = detail({ description: 'D'.repeat(40_000) }, { comments: Array.from({ length: 20 }, (_, index) => comment(index, `${index}:${'c'.repeat(3000)}`)) });
  const prompt = todoAgentPrompt('봐줘', long, names, sha256 => sha256);
  assert.ok(prompt.length <= 32_000, String(prompt.length));
  assert.match(prompt, /todos_get으로 전체를 읽으세요/);
  assert.match(prompt, /설명:\nD+…/);
  assert.match(prompt, /19:c+/, 'the newest comment is kept');
  assert.doesNotMatch(prompt, /\n {2}0:c/, 'the oldest is the first to go');
  // A first message that leaves no room for the todo itself is refused rather than cut.
  assert.throws(() => todoAgentPrompt('x'.repeat(31_990), long, names, sha256 => sha256), error => kind(error) === 'invalid');
  const tight = todoAgentPrompt('x'.repeat(31_000), long, names, sha256 => sha256);
  assert.ok(tight.length <= 32_000);
  assert.match(tight, /할 일 id: t1/);
});

test('a long first message never costs the attachments: their paths and the instruction to read them stay, or the message is refused', () => {
  const files = [{ id: 'f1', taskId: 't1', commentId: null, name: 'shot.png', mimeType: 'image/png', size: 2048, sha256: 'ab'.repeat(32), createdAt: '', deletedAt: null }];
  const withFile = detail({ description: 'D'.repeat(5000) }, { files, subtasks: Array.from({ length: 30 }, (_, index) => ({ ...detail().task, id: `s${index}`, content: `Sub ${index} ${'s'.repeat(200)}` })) });
  const prompt = todoAgentPrompt('x'.repeat(31_500), withFile, names, sha256 => `/state/todo-files/${sha256}`);
  assert.ok(prompt.length <= 32_000, String(prompt.length));
  assert.ok(prompt.includes(`/state/todo-files/${'ab'.repeat(32)}`));
  assert.match(prompt, /시작하기 전에 첨부 파일\(이미지·문서\)을 먼저 읽으세요\.\n\(길어서 일부를 줄였습니다/);
  assert.throws(() => todoAgentPrompt('x'.repeat(31_850), withFile, names, sha256 => `/state/todo-files/${sha256}`), error => kind(error) === 'invalid' && /자 이하로 줄여/.test((error as Error).message));
});

test('a closed master keeps collecting: a late start in its folder is handed over too', async t => {
  const { store, agents, calls, session, apply, folder } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  await agents.begin('a', 'go');
  session('child', '/work/one');
  store.addFamily('child', 'a');
  apply(complete('a', 'ca'));
  await agents.schedule();
  assert.equal(store.agent('a')!.state, 'closed');
  calls.length = 0;
  session('late', folder('a'));
  await agents.schedule();
  assert.deepEqual(calls, ['archive late']);
});

test('after a restart, an open todo\'s master is taken back from retention once, in case a hand-over was left', async t => {
  const { dir, store, sessions } = await fixture(t);
  const calls: string[] = [];
  store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a', content: 'A' }] }));
  store.changeAgent('a', null, { state: 'active', sessionId: 'm', provider: 'claude' });
  sessions.push({ id: 'm', cwd: todoMasterFolder(dir, 'a'), provider: 'claude', status: 'idle', createdAt: '2026-10-17T09:00:00.000Z', isSubagent: false });
  const again = new TodoAgents({ stateDir: dir, store, sessions: () => sessions.map(item => ({ ...item })), run: () => undefined,
    reopen: async id => { calls.push(`reopen ${id}`); return sessions.find(item => item.id === id); }, requestArchive: async ids => { calls.push(`archive ${ids.join(',')}`); },
    createSession: async () => { throw new Error('unused'); }, uncertain: () => false, model: async () => ({ provider: 'claude' }), writeGuide: async () => {}, startHost: async () => {}, onChange: () => {} });
  t.after(() => again.close());
  await again.schedule();
  await again.schedule();
  assert.deepEqual(calls, ['reopen m']);
});

test('a closed master\'s family record waits for a session recorded but not listed yet, and for its master\'s own work', async t => {
  const { store, agents, sessions, apply, tick } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  const { sessionId } = await agents.begin('a', 'go');
  apply(complete('a', 'ca'));
  await agents.schedule();
  store.addFamily('unlisted', 'a');
  await agents.schedule();
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId), ['unlisted']);
  const master = sessions.find(item => item.id === sessionId)!;
  master.status = 'working';
  tick(TODO_AGENT_START_WAIT_MS + 1000);
  await agents.schedule();
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId), ['unlisted'], 'the master still works');
  master.status = 'idle';
  await agents.schedule();
  assert.deepEqual(store.familyOf('a'), []);
});
