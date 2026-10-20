import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { removeTodoMasterGuide, writeTodoMasterGuide } from '../../../server/master/guide.js';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { TowerError } from '../../../shared/errors.js';
import { MASTER_FOLDER } from '../../../shared/master.js';
import { TodoRequestSchema, type TodoOp } from '../../../shared/todo/ops.js';
import type { TodoTaskDetail } from '../../../shared/todo/types.js';
import type { AutoPromptJob, CreateSessionRequest, Run } from '../../../shared/types.js';
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
  const jobs: Pick<AutoPromptJob, 'id' | 'sessionId' | 'decision' | 'delegation'>[] = [];
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
    jobs: () => jobs,
    reopen: async id => {
      calls.push(`reopen ${id}`);
      if (cold.has(id)) { sessions.push(cold.get(id)!); cold.delete(id); }
      const found = sessions.find(item => item.id === id);
      if (found) { found.closed = false; delete found.archiveRequested; }
      return found && { ...found };
    },
    // As the worker does: a handed-over session is listed as waiting to leave until taken back.
    requestArchive: async ids => {
      calls.push(`archive ${ids.join(',')}`); await hooks.requestArchive(ids);
      for (const item of sessions) if (ids.includes(item.id)) item.archiveRequested = true;
    },
    withdrawArchive: async ids => {
      calls.push(`withdraw ${ids.join(',')}`);
      for (const item of sessions) if (ids.includes(item.id)) delete item.archiveRequested;
    },
    createSession: async input => { created.push(input); return hooks.create(input); },
    uncertain: error => (error as { disposition?: string }).disposition === 'uncertain',
    model: async () => ({ provider: 'claude', model: 'opus', effort: 'high' }),
    writeGuide: async (folder, taskId) => { calls.push(`guide ${taskId} ${folder === todoMasterFolder(dir, taskId)}`); },
    removeGuide: async folder => { calls.push(`unguide ${basename(folder)}`); },
    startHost: async () => { hosts++; },
    onChange: () => { changes++; },
    now: () => clock.getTime(),
  });
  t.after(async () => { agents.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  // As the web answers a change (server/index.ts): the masters it moved, at the revision that moved them.
  const apply = (...ops: TodoOp[]) => {
    const answer = store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops }), 'owner');
    const moved = agents.settle(answer.tasks.map(task => task.id));
    return { ...answer, revision: Object.keys(moved).length ? store.revision() : answer.revision, agents: moved };
  };
  const tick = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  const folder = (taskId: string) => todoMasterFolder(dir, taskId);
  return { dir, store, agents, sessions, cold, runs, jobs, calls, created, hooks, session, apply, tick, folder, changes: () => changes, hosts: () => hosts };
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
  const { store, agents, hooks, calls, session, apply, tick, folder } = await fixture(t);
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
  // The guide it wrote goes with it (only Tower's files, and the folder if then empty).
  assert.equal(calls.at(-1), 'unguide b');

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
  assert.ok(!calls.includes('unguide c'));
  tick(TODO_AGENT_START_WAIT_MS + 1000);
  await agents.schedule();
  assert.equal(store.agent('c'), undefined);
  assert.equal(calls.at(-1), 'unguide c');
  assert.equal(folder('c').endsWith('/todo-masters/c'), true);
});

test('completing a todo hands its master, its folder and its family to retention, listed as leaving but not stopped; reopening takes back the master, from compressed storage too, and its family still listed', async t => {
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
  // Pages list them with the closed ones at once (Session.archiveRequested), but none is closed: their work goes on.
  assert.equal(sub.closed, undefined);
  assert.equal(extra.closed, undefined);
  assert.equal(child.closed, undefined);
  assert.equal(child.archiveRequested, true);

  // Moved to compressed storage meanwhile: reopening asks for it by id, which brings it back.
  const master = sessions.splice(sessions.findIndex(item => item.id === sessionId), 1)[0];
  cold.set(sessionId!, master);
  calls.length = 0;
  const reopened = apply({ op: 'task.uncomplete', id: 'a', completionId: 'ca' });
  assert.equal(reopened.agents.a?.state, 'active');
  await agents.schedule();
  // Its folder is written first: the master host removes a closed issue's files after a while, and a turn needs it.
  // Its family still listed shows again; an older session of its folder stays handed over.
  assert.deepEqual(calls, ['guide a true', `reopen ${sessionId}`, 'withdraw child']);
  assert.ok(sessions.some(item => item.id === sessionId));
  assert.equal(child.archiveRequested, undefined);
  assert.equal(extra.archiveRequested, true);
  // Reopened while it was still listed (its hand-over not yet carried out), it is taken back all the same.
  calls.length = 0;
  apply(complete('a', 'ca2'));
  await agents.schedule();
  assert.deepEqual(calls, [`archive ${sessionId},child`]);
  apply({ op: 'task.uncomplete', id: 'a', completionId: 'ca2' });
  await agents.schedule();
  assert.deepEqual(calls, [`archive ${sessionId},child`, 'guide a true', `reopen ${sessionId}`, 'withdraw child']);
  // A family member still marked as leaving while its todo is open (a take-back that failed) is taken back by a pass.
  calls.length = 0;
  child.archiveRequested = true;
  await agents.schedule();
  assert.deepEqual(calls, ['withdraw child']);
  await agents.schedule();
  assert.deepEqual(calls, ['withdraw child'], 'once taken back, nothing more');
});

test('a closed todo keeps its family record while a member still waits to leave, so reopening it brings that member back', async t => {
  const { store, agents, sessions, calls, session, apply, tick } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  await agents.begin('a', 'go');
  const child = session('child', '/work/project');
  store.addFamily('child', 'a');
  apply(complete('a', 'ca'));
  await agents.schedule();
  await agents.schedule();
  // Idle and handed over, but retention has not moved it yet (no recorded end, say): its record stays.
  assert.equal(child.archiveRequested, true);
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId), ['child']);
  calls.length = 0;
  apply({ op: 'task.uncomplete', id: 'a', completionId: 'ca' });
  await agents.schedule();
  assert.ok(calls.includes('withdraw child'));
  assert.equal(child.archiveRequested, undefined);
  // Moved to compressed storage with its master (no longer listed), the record goes.
  apply(complete('a', 'ca2'));
  await agents.schedule();
  sessions.splice(0, sessions.length);
  tick(TODO_AGENT_START_WAIT_MS + 1000);
  await agents.schedule();
  assert.deepEqual(store.familyOf('a'), []);
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
  const first = store.apply(request, 'owner');
  assert.equal(agents.settle(first.tasks.map(task => task.id)).a?.state, 'closing');
  await agents.schedule();
  apply({ op: 'task.uncomplete', id: 'a', completionId: 'ca' });
  await agents.schedule();
  assert.equal(store.agent('a')!.state, 'active');
  const again = store.apply(request, 'owner');
  assert.deepEqual(agents.settle(again.tasks.map(task => task.id)), {});
  assert.equal(store.agent('a')!.state, 'active');
});

test('a restored backup keeps the masters (they are not in it) and moves them to what its todos say, closed ones too', async t => {
  const { store, agents, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' }, { op: 'task.create', id: 'b', content: 'B' });
  await agents.begin('b', 'go');
  apply(complete('a', 'ca'));
  const backup = store.backupData()!;
  assert.equal(Object.keys(backup.tables).some(table => table.startsWith('todo_agent')), false);
  assert.equal((TODO_DATA_TABLES as readonly string[]).includes('todo_agents'), false);
  apply({ op: 'task.uncomplete', id: 'a', completionId: 'ca' });
  await agents.begin('a', 'go');
  apply(complete('b', 'cb'));
  await agents.schedule();
  assert.equal(store.agent('b')!.state, 'closed');
  store.restoreData(backup.schema, backup.tables);
  await agents.recheckAll();
  assert.equal(store.agent('a')!.state, 'closed');
  assert.equal(store.agent('b')!.state, 'active');
});

test('a pass compares only the masters not closed; a change only the todos it touched; every master now and then', async t => {
  const { store, agents, apply, tick } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  await agents.begin('a', 'go');
  apply(complete('a', 'ca'));
  await agents.schedule();
  assert.equal(store.agent('a')!.state, 'closed');
  // Reopened behind the web's back (an older build, a copy put back): an ordinary pass does not look at closed masters…
  store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops: [{ op: 'task.uncomplete', id: 'a', completionId: 'ca' }] }), 'owner');
  assert.deepEqual(agents.settle(['other']), {});
  await agents.schedule();
  assert.equal(store.agent('a')!.state, 'closed');
  // …the hourly one does.
  tick(60 * 60_000);
  await agents.schedule();
  assert.equal(store.agent('a')!.state, 'active');
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
  const { store, agents, sessions, session, apply, tick } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' }, { op: 'task.create', id: 'b', content: 'B' });
  const { sessionId } = await agents.begin('a', 'go');
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
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId), ['working'], 'idle, but still waiting to leave');
  // Taken back by the owner by hand, its master gone to compressed storage: the record goes, and the rest is left to
  // ordinary retention.
  delete working.archiveRequested;
  sessions.splice(sessions.findIndex(item => item.id === sessionId), 1);
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
    reopen: async () => { asked++; }, requestArchive: async () => { asked++; }, withdrawArchive: async () => { asked++; }, createSession: async () => { throw new Error('unused'); }, uncertain: () => false,
    model: async () => ({ provider: 'codex' }), writeGuide: async () => {}, removeGuide: async () => {}, startHost: async () => {}, onChange: () => {} });
  store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a', content: 'A' }] }), 'owner');
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
const comment = (index: number, body: string, author: 'owner' | 'agent' | null = null) => ({ id: `c${index}`, taskId: 't1', body, author, createdAt: `2026-10-17T09:${String(index % 60).padStart(2, '0')}:00.000Z`, updatedAt: '', deletedAt: null });

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

test('each comment in the first prompt says who wrote it, where that was recorded', () => {
  const prompt = todoAgentPrompt('봐줘', detail({}, { comments: [comment(1, 'mine', 'owner'), comment(2, 'report', 'agent'), comment(3, 'old')] }), names, sha256 => sha256);
  assert.match(prompt, /- 2026-10-17T09:01:00.000Z · 소유자\n  mine\n- 2026-10-17T09:02:00.000Z · 에이전트\n  report\n- 2026-10-17T09:03:00.000Z\n  old/);
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
  store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a', content: 'A' }] }), 'owner');
  store.changeAgent('a', null, { state: 'active', sessionId: 'm', provider: 'claude' });
  sessions.push({ id: 'm', cwd: todoMasterFolder(dir, 'a'), provider: 'claude', status: 'idle', createdAt: '2026-10-17T09:00:00.000Z', isSubagent: false });
  // A family member not marked as leaving is not asked about (an older worker would refuse the question).
  sessions.push({ id: 'f', cwd: '/work/project', provider: 'claude', status: 'idle', createdAt: '2026-10-17T09:00:00.000Z', isSubagent: false });
  store.addFamily('f', 'a');
  const again = new TodoAgents({ stateDir: dir, store, sessions: () => sessions.map(item => ({ ...item })), run: () => undefined,
    reopen: async id => { calls.push(`reopen ${id}`); return sessions.find(item => item.id === id); }, requestArchive: async ids => { calls.push(`archive ${ids.join(',')}`); }, withdrawArchive: async ids => { calls.push(`withdraw ${ids.join(',')}`); },
    createSession: async () => { throw new Error('unused'); }, uncertain: () => false, model: async () => ({ provider: 'claude' }), writeGuide: async (_folder, taskId) => { calls.push(`guide ${taskId}`); }, removeGuide: async () => {}, startHost: async () => {}, onChange: () => {} });
  t.after(() => again.close());
  await again.schedule();
  await again.schedule();
  assert.deepEqual(calls, ['guide a', 'reopen m']);
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
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId), ['unlisted'], 'the master still waits to leave');
  sessions.splice(sessions.indexOf(master), 1);
  await agents.schedule();
  assert.deepEqual(store.familyOf('a'), []);
});

test('a session an issue master makes itself joins its todo\'s family; one made for a closed issue is handed over', async t => {
  const { store, agents, calls, session, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  await agents.begin('a', 'go');
  session('made', '/work/one');
  agents.recordIssueSession('a', 'made');
  agents.recordIssueSession('missing', 'other');
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId), ['made']);
  assert.equal(store.familyTask('other'), undefined);
  apply(complete('a', 'ca'));
  await agents.schedule();
  calls.length = 0;
  session('after', '/work/two');
  agents.recordIssueSession('a', 'after');
  await agents.schedule();
  assert.deepEqual(calls, ['archive after']);
});

test('closed issues cost a pass nothing once their family is settled: they are not even read', async t => {
  const { store, agents, sessions, apply } = await fixture(t);
  for (const id of ['a', 'b', 'c']) {
    apply({ op: 'task.create', id, content: id });
    await agents.begin(id, 'go');
    apply(complete(id, `c${id}`));
  }
  await agents.schedule();
  // Their masters are moved to compressed storage by retention: no longer listed.
  sessions.length = 0;
  await agents.schedule();
  assert.deepEqual(store.agentsToSettle(), []);
  assert.deepEqual(['a', 'b', 'c'].map(id => store.agent(id)!.state), ['closed', 'closed', 'closed']);
});

test('hand-overs go at most 500 at a time, and only those that went count as handed over', async t => {
  const { store, agents, calls, hooks, session, apply, tick } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  const { sessionId } = await agents.begin('a', 'go');
  for (let index = 0; index < 1100; index++) { session(`s${index}`, '/work'); store.addFamily(`s${index}`, 'a'); }
  let refuse = true;
  hooks.requestArchive = async ids => { if (refuse && ids.includes('s700')) throw new Error('worker busy'); };
  apply(complete('a', 'ca'));
  await agents.schedule();
  const ids = (call: string) => call.slice('archive '.length).split(',');
  const first = calls.filter(call => call.startsWith('archive')).map(ids);
  assert.deepEqual(first.map(chunk => chunk.length), [500, 500]);
  assert.equal(store.agent('a')!.state, 'closing');
  // A minute later the rest goes, the chunk that went not again.
  calls.length = 0;
  refuse = false;
  tick(61_000);
  await agents.schedule();
  const sent = calls.filter(call => call.startsWith('archive')).flatMap(ids);
  assert.equal(sent.length, 601);
  assert.equal(new Set([...first[0], ...sent]).size, 1101);
  assert.ok(first[0].includes(sessionId!));
  assert.equal(store.agent('a')!.state, 'closed');
});

test('the folder\'s master is chosen as the master host chooses it: helpers an agent ran there are neither the master nor handed over as extra', async t => {
  const { store, agents, calls, session, apply, tick, folder } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  const { sessionId } = await agents.begin('a', 'go');
  tick(1000);
  session('helper', folder('a'), { launchedByAgent: true });
  calls.length = 0;
  await agents.schedule();
  assert.equal(store.agent('a')!.sessionId, sessionId);
  assert.deepEqual(calls, []);
});

test('sessions in the folder of a todo with no master are handed over, unless its start is under way', async t => {
  const { agents, calls, hooks, session, apply, folder } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' }, { op: 'task.create', id: 'b', content: 'B' });
  session('orphan', folder('gone'));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  hooks.create = async input => { const made = session('fresh', input.cwd); await held; return { session: made }; };
  const starting = agents.begin('b', 'go');
  await new Promise(resolve => setImmediate(resolve));
  await agents.schedule();
  assert.deepEqual(calls.filter(call => call.startsWith('archive')), ['archive orphan']);
  release();
  await starting;
  await agents.schedule();
  assert.deepEqual(calls.filter(call => call.startsWith('archive')), ['archive orphan']);
});

test('the first prompt keeps every attachment path, cutting the rest for them, or refuses when the paths alone do not fit', () => {
  const files = Array.from({ length: 80 }, (_, index) => ({ id: `f${index}`, taskId: 't1', commentId: null, name: `file-${index}.png`, mimeType: 'image/png', size: 10, sha256: String(index).padStart(64, '0'), createdAt: '', deletedAt: null }));
  const many = detail({ description: 'D'.repeat(20_000) }, { files, comments: Array.from({ length: 20 }, (_, index) => comment(index, 'c'.repeat(1000))) });
  const prompt = todoAgentPrompt('x'.repeat(20_000), many, names, sha256 => `/state/todo-files/${sha256}`);
  assert.ok(prompt.length <= 32_000, String(prompt.length));
  for (const file of files) assert.ok(prompt.includes(`/state/todo-files/${file.sha256}`), file.name);
  assert.throws(() => todoAgentPrompt('x'.repeat(28_000), many, names, sha256 => `/state/todo-files/${sha256}`), error => kind(error) === 'invalid');
});

test('taking a guide away leaves every other file, and the folder while anything else is in it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-guide-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const used = join(dir, 'used'), empty = join(dir, 'empty');
  await writeTodoMasterGuide(used, 'used');
  await writeFile(join(used, 'notes.md'), 'mine');
  await writeTodoMasterGuide(empty, 'empty');
  await removeTodoMasterGuide(used);
  await removeTodoMasterGuide(empty);
  await removeTodoMasterGuide(join(dir, 'never'));
  assert.deepEqual(await readdir(used), ['notes.md']);
  await assert.rejects(stat(empty), { code: 'ENOENT' });
});

test('closed masters are found through indexes, never by reading every master', async t => {
  const { dir, store } = await fixture(t);
  store.close();
  const db = new DatabaseSync(join(dir, 'todos.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(row => row.detail).join('; ');
  assert.match(plan("SELECT * FROM todo_agents WHERE state != 'closed'"), /USING INDEX todo_agents_open/);
  // A scan only of the index of masters not closed, or a search by todo: never a scan of the whole table.
  assert.match(plan("SELECT a.* FROM todo_agents a LEFT JOIN todo_tasks t ON t.id = a.task_id WHERE a.state != 'closed' AND (a.state IN ('starting', 'active')) != (t.id IS NOT NULL AND t.completed_at IS NULL AND t.deleted_at IS NULL)"), /SCAN a USING INDEX todo_agents_open/);
  assert.match(plan('SELECT a.* FROM (SELECT DISTINCT task_id FROM todo_agent_sessions) s JOIN todo_agents a ON a.task_id = s.task_id'), /SEARCH a USING INDEX/);
});

test('a start that comes to nothing after its todo closed meanwhile still takes its row and guide away', async t => {
  const { store, agents, calls, hooks, session, apply, tick, folder } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' }, { op: 'task.create', id: 'b', content: 'B' }, { op: 'task.create', id: 'c', content: 'C' });
  /** Starts a todo's master and completes the todo while the session is being made, then fails as `outcome` says. */
  const startClosing = async (id: string, outcome: 'refused' | 'lost', late = false) => {
    let fail!: () => void;
    const held = new Promise<void>(resolve => { fail = resolve; });
    hooks.create = async input => {
      await held;
      if (late) session(`late-${id}`, input.cwd);
      throw new TowerError('unavailable', outcome, { disposition: outcome === 'lost' ? 'uncertain' : 'not-admitted' });
    };
    const starting = agents.begin(id, 'go');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(apply(complete(id, `c${id}`)).agents[id]?.state, 'closing');
    fail();
    await assert.rejects(starting, new RegExp(outcome));
  };

  // Refused: the row and the guide go at once, though the row was `closing`.
  await startClosing('a', 'refused');
  assert.equal(store.agent('a'), undefined);
  assert.ok(calls.includes('unguide a'));

  // Lost with nothing in the folder: it waits two minutes for a late session, then goes the same way.
  await startClosing('b', 'lost');
  await agents.schedule();
  assert.equal(store.agent('b')!.state, 'closing');
  assert.ok(!calls.includes('unguide b'));
  tick(TODO_AGENT_START_WAIT_MS + 1000);
  await agents.schedule();
  assert.equal(store.agent('b'), undefined);
  assert.ok(calls.includes('unguide b'));

  // Lost, but its session turns up: it is handed over with the issue, and its folder keeps its guide.
  await startClosing('c', 'lost', true);
  await agents.schedule();
  assert.equal(store.agent('c')!.state, 'closed');
  assert.ok(calls.includes('archive late-c'));
  assert.ok(!calls.includes('unguide c'));
  assert.equal(folder('c').endsWith('/c'), true);
});

test('sessions Auto Prompt makes for an issue master join its family, sent with its Tower tools or with the master\'s calls; a job that continued a session leaves it alone', async t => {
  const { store, agents, runs, jobs, calls, session, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  const { sessionId } = await agents.begin('a', 'go');
  runs.set('run-master', { sessionId: sessionId! });
  const made = (id: string, decision: 'create' | 'resume', extra: Partial<AutoPromptJob> = {}) => {
    session(`s-${id}`, '/work/' + id);
    jobs.push({ id, sessionId: `s-${id}`, decision: { action: decision, cwd: '/work/' + id, reason: 'r' }, ...extra });
  };
  // With its Tower tools: the job names the calling turn.
  made('j1', 'create', { delegation: { parentRunId: 'run-master', rootRunId: 'run-master' } });
  // With the master's calls, which name the todo when it is sent.
  agents.recordIssueJob('a', 'j2');
  made('j2', 'create');
  // An existing session continued: used, not made.
  made('j3', 'resume', { delegation: { parentRunId: 'run-master', rootRunId: 'run-master' } });
  // Someone else's job.
  made('j4', 'create');
  await agents.schedule();
  assert.deepEqual(store.familyOf('a').map(member => member.sessionId).sort(), ['s-j1', 's-j2']);
  // A job claimed for one todo stays that todo's: a later claim for another changes nothing.
  apply({ op: 'task.create', id: 'b', content: 'B' });
  await agents.begin('b', 'go');
  agents.recordIssueJob('a', 'j5');
  agents.recordIssueJob('b', 'j5');
  made('j5', 'create');
  await agents.schedule();
  assert.equal(store.familyTask('s-j5'), 'a');
  assert.equal(store.claimedJobs().size, 0, 'a claim is let go once its session is recorded');
  // Closing the todo hands them over with the master.
  calls.length = 0;
  apply(complete('a', 'ca'));
  await agents.schedule();
  assert.ok(calls.some(call => /^archive .*s-j1.*s-j2|^archive .*s-j2.*s-j1/.test(call)), calls.join(' | '));
  assert.ok(!calls.some(call => /s-j3|s-j4/.test(call)), 'the continued and the unrelated sessions stay');
});

test('a job an issue master sent is still its todo\'s after a restart, while the job is routed', async t => {
  const { dir, store, agents, jobs, session, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  await agents.begin('a', 'go');
  agents.recordIssueJob('a', 'routing');
  jobs.push({ id: 'routing' });
  await agents.schedule();
  assert.equal(store.claimedJobs().get('routing'), 'a', 'kept while the job has no session yet');
  agents.close();
  // A new process (a web restart) finds the claim in the store.
  const again = new TodoAgents({ stateDir: dir, store, sessions: () => [{ id: 's-routing', cwd: '/work', provider: 'claude', status: 'idle', createdAt: new Date().toISOString(), isSubagent: false }],
    run: () => undefined, jobs: () => jobs, reopen: async () => undefined, requestArchive: async () => {}, withdrawArchive: async () => {}, createSession: async () => { throw new Error('unused'); },
    uncertain: () => false, model: async () => ({ provider: 'claude' }), writeGuide: async () => {}, removeGuide: async () => {}, startHost: async () => {}, onChange: () => {} });
  t.after(() => again.close());
  session('s-routing', '/work');
  jobs[0] = { id: 'routing', sessionId: 's-routing', decision: { action: 'create', cwd: '/work', reason: 'r' } };
  await again.schedule();
  assert.equal(store.familyTask('s-routing'), 'a');
});
