import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TowerError } from '../../../shared/errors.js';
import { TodoFiles } from '../../../server/todo/files.js';
import { TodoStore } from '../../../server/todo/store.js';
import { callTodoTool, TODO_TOOL_NAMES, todoToolList } from '../../../server/todo/agent-tools.js';

// Saturday, 2026-10-17, as the tools' local date.
const now = new Date(2026, 9, 17, 10, 0);

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-tools-'));
  const store = new TodoStore(dir);
  store.start();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  let applied = 0;
  const calls = { overview: () => store.overview(), detail: (id: string) => store.detail(id), completed: (input: Parameters<TodoStore['completed']>[0]) => store.completed(input),
    search: (query: string, input: Parameters<TodoStore['search']>[1]) => store.search(query, input), apply: (request: Parameters<TodoStore['apply']>[0], by: Parameters<TodoStore['apply']>[1]) => { applied++; return store.apply(request, by); } };
  const call = (name: string, args: Record<string, unknown> = {}, options: Parameters<typeof callTodoTool>[3] = {}) => callTodoTool(calls, name, args, { now, ...options }) as any;
  return { store, call, applied: () => applied };
}

test('the tools list their inputs, and every listed name is one the approvals can name', () => {
  const tools = todoToolList() as { name: string; description: string; inputSchema: { type: string } }[];
  assert.deepEqual(tools.map(tool => tool.name), TODO_TOOL_NAMES);
  for (const tool of tools) { assert.match(tool.name, /^todos_[a-z]+$/); assert.equal(tool.inputSchema.type, 'object'); assert.ok(tool.description.length > 20); }
});

test('a task added in words gets what the words say, explicit fields win, and new labels are made in the same request', async t => {
  const { call, applied } = await fixture(t);
  call('todos_apply', { ops: [{ op: 'project.create', id: 'tower', name: '타워' }, { op: 'section.create', id: 'ops', projectId: 'tower', name: '운영' }] });
  const { added } = call('todos_add', { text: '견적 회신 내일 오후 3시 #타워 /운영 p1 @급함', labels: ['call'] });
  assert.equal(added.content, '견적 회신');
  assert.deepEqual([added.projectId, added.sectionId, added.due, added.priority], ['tower', 'ops', '2026-10-18 15:00', 1]);
  assert.deepEqual(added.labels.sort(), ['call', '급함']);
  const plain = call('todos_add', { text: '내일 p1 그대로', parse: false, priority: 3 }).added;
  assert.deepEqual([plain.content, plain.priority, plain.project, plain.due], ['내일 p1 그대로', 3, 'Inbox', undefined]);
  assert.equal(applied(), 3);
  const overview = call('todos_overview');
  assert.deepEqual([overview.today, overview.counts.open, overview.labels.map((label: { name: string }) => label.name).sort()], ['2026-10-17', 2, ['call', '급함']]);
});

test('lists: today holds overdue and today, upcoming the coming days, and a project its own', async t => {
  const { call } = await fixture(t);
  call('todos_apply', { ops: [
    { op: 'project.create', id: 'p', name: 'Home' },
    { op: 'task.create', id: 'late', content: 'Late', dueDate: '2026-10-15' },
    { op: 'task.create', id: 'now', content: 'Now', dueDate: '2026-10-17', dueTime: '09:00' },
    { op: 'task.create', id: 'soon', content: 'Soon', dueDate: '2026-10-20', projectId: 'p' },
    { op: 'task.create', id: 'far', content: 'Far', dueDate: '2026-11-30' },
  ] });
  const ids = (view: string, extra: Record<string, unknown> = {}) => call('todos_list', { view, ...extra }).tasks.map((item: { id: string }) => item.id);
  assert.deepEqual(ids('today'), ['late', 'now']);
  assert.deepEqual(ids('upcoming'), ['now', 'soon']);
  assert.deepEqual(ids('upcoming', { days: 60 }), ['now', 'soon', 'far']);
  assert.deepEqual(ids('project', { projectId: 'p' }), ['soon']);
  assert.deepEqual(ids('inbox'), ['late', 'now', 'far']);
  assert.throws(() => call('todos_list', { view: 'project' }), /needs projectId/);
  assert.deepEqual(call('todos_search', { query: 'soo' }).tasks.map((item: { id: string }) => item.id), ['soon']);
});

test('complete and add next is one request: the first is done, the next follows it', async t => {
  const { call, applied } = await fixture(t);
  const first = call('todos_add', { text: 'Draft' }).added;
  const before = applied();
  const result = call('todos_complete', { id: first.id, next: { text: 'Review 내일' } });
  assert.equal(applied(), before + 1);
  assert.ok(result.completed.completedAt);
  assert.equal(result.added.due, '2026-10-18');
  const detail = call('todos_get', { id: first.id });
  assert.deepEqual(detail.next.map((item: { task: { id: string } }) => item.task.id), [result.added.id]);
  assert.equal(detail.completions.length, 1);
  assert.throws(() => call('todos_complete', { id: first.id }), (error: unknown) => error instanceof TowerError && error.kind === 'conflict');
  // Reopening takes back that completion.
  assert.equal(call('todos_reopen', { id: first.id }).reopened.completedAt, undefined);
  // A follow-up added after an open task, completing it in the same request.
  const third = call('todos_add', { text: 'Ship', after: result.added.id, completeAfter: true });
  assert.ok(third.completed.completedAt);
  assert.deepEqual(call('todos_completed').items.map((item: { task: { id: string } }) => item.task.id), [result.added.id], 'the reopened one is open again');
});

test('a repeating task moves on to its next date when completed', async t => {
  const { call } = await fixture(t);
  const weekly = call('todos_add', { text: 'Standup 매주 월' }).added;
  assert.equal(weekly.due, '2026-10-19');
  const done = call('todos_complete', { id: weekly.id }).completed;
  assert.deepEqual([done.due, done.completedAt], ['2026-10-26', undefined]);
});

test('update changes fields and place in one request; recurrence and labels are read from words and names', async t => {
  const { call, applied } = await fixture(t);
  call('todos_apply', { ops: [{ op: 'project.create', id: 'p', name: 'Work' }, { op: 'label.create', id: 'l', name: 'deep' }] });
  const item = call('todos_add', { text: 'Write' }).added;
  const before = applied();
  const { updated } = call('todos_update', { id: item.id, content: 'Write the plan', priority: 2, recurrence: '매일', labels: ['Deep', 'new'], projectId: 'p' });
  assert.equal(applied(), before + 1);
  assert.deepEqual([updated.content, updated.priority, updated.projectId, updated.due, updated.recurrence?.freq], ['Write the plan', 2, 'p', '2026-10-17', 'day']);
  assert.deepEqual(updated.labels.sort(), ['deep', 'new']);
  const cleared = call('todos_update', { id: item.id, recurrence: null, labels: [], dueDate: null }).updated;
  assert.deepEqual([cleared.recurrence, cleared.labels, cleared.due], [undefined, undefined, undefined]);
  assert.throws(() => call('todos_update', { id: item.id }), /Nothing to change/);
  assert.throws(() => call('todos_update', { id: item.id, recurrence: 'sometimes' }), /not read as a repeat/);
});

test('comments, deletes, and refusals come back as errors with their reason; nothing half-applied', async t => {
  const { call, store } = await fixture(t);
  const item = call('todos_add', { text: 'Call' }).added;
  await call('todos_comment', { id: item.id, body: '**Tomorrow** morning' });
  await assert.rejects(call('todos_comment', { id: 'missing', body: 'x' }), (error: unknown) => error instanceof TowerError && error.kind === 'not-found');
  assert.equal(call('todos_get', { id: item.id }).comments[0].body, '**Tomorrow** morning');
  // What the tools write is an agent's, however it is sent; the owner's comments say they are the owner's.
  call('todos_apply', { ops: [{ op: 'comment.create', id: 'via-apply', taskId: item.id, body: 'Applied' }] });
  store.apply({ requestId: randomUUID(), ops: [{ op: 'comment.create', id: 'owners', taskId: item.id, body: 'Mine' }] }, 'owner');
  const comments = call('todos_get', { id: item.id }).comments as { body: string; author?: string }[];
  assert.deepEqual(comments.map(comment => [comment.body, comment.author]), [['**Tomorrow** morning', 'agent'], ['Applied', 'agent'], ['Mine', 'owner']]);
  assert.equal(call('todos_get', { id: item.id, comment: 'owners' }).comment.author, 'owner');
  const revision = store.revision();
  assert.throws(() => call('todos_apply', { ops: [{ op: 'task.update', id: item.id, patch: { content: 'x' } }, { op: 'task.update', id: 'missing', patch: { content: 'y' } }] }),
    (error: unknown) => error instanceof TowerError && error.kind === 'not-found');
  assert.throws(() => call('todos_apply', { ops: [{ op: 'task.update', id: item.id, patch: { content: '' } }] }), /ops\.0\.patch\.content/, 'a mistake names the op and field it is in');
  assert.throws(() => call('todos_apply', { ops: [{ op: 'task.vanish', id: item.id }] }), /Invalid input/);
  assert.equal(store.revision(), revision, 'a refused request changes nothing');
  assert.throws(() => call('todos_add', { text: '' }), /Invalid input/);
  assert.throws(() => call('todos_nothing'), /Unknown todo tool/);
  call('todos_delete', { id: item.id });
  assert.equal(store.overview().tasks.length, 0);
  call('todos_apply', { ops: [{ op: 'task.restore', id: item.id }] });
  assert.equal(store.overview().tasks.length, 1);
});

test('inputs that would be changed quietly are refused instead, and one new label named twice is made once', async t => {
  const { call } = await fixture(t);
  assert.throws(() => call('todos_add', { text: 'Call', dueTime: '15:00' }), /dueTime needs a date/);
  assert.throws(() => call('todos_add', { text: 'x'.repeat(501), parse: false }), /at most 500/);
  const { added } = call('todos_add', { text: 'Plan', labels: ['new', 'New'] });
  assert.deepEqual(added.labels, ['new']);
});

test('todos that cannot be read are an error with the reason, never an empty list', () => {
  const store = { overview: () => ({ availability: { state: 'unavailable', reason: 'the file is held by another program' }, revision: 0, projects: [], sections: [], labels: [], tasks: [], links: [], commentCounts: {}, fileCounts: {} }) } as never;
  assert.throws(() => callTodoTool(store, 'todos_list', { view: 'today' }, { now }), /cannot be read now: the file is held/);
});

test('archived projects stay out of the lists and counts, as on the page, unless asked for by id', async t => {
  const { call } = await fixture(t);
  call('todos_apply', { ops: [
    { op: 'project.create', id: 'old', name: 'Old' }, { op: 'project.create', id: 'child', name: 'Child', parentId: 'old' },
    { op: 'task.create', id: 'a', content: 'A', projectId: 'old', dueDate: '2026-10-16' }, { op: 'task.create', id: 'b', content: 'B', projectId: 'child', dueDate: '2026-10-17' },
    { op: 'task.create', id: 'c', content: 'C', dueDate: '2026-10-17' },
    { op: 'project.update', id: 'old', patch: { archived: true } },
  ] });
  assert.deepEqual(call('todos_list', { view: 'today' }).tasks.map((item: { id: string }) => item.id), ['c']);
  assert.deepEqual([call('todos_overview').counts.open, call('todos_overview').counts.overdue], [1, 0]);
  assert.deepEqual(call('todos_list', { view: 'project', projectId: 'old' }).tasks.map((item: { id: string }) => item.id), ['a']);
});

test('a sub-task goes where its parent is; a long discussion comes back as its latest comments', async t => {
  const { call } = await fixture(t);
  const parent = call('todos_add', { text: 'Parent' }).added;
  assert.equal(call('todos_add', { text: 'Child', parentId: parent.id }).added.parentId, parent.id);
  assert.throws(() => call('todos_add', { text: 'Child', parentId: parent.id, projectId: 'inbox' }), /give parentId alone/);
  call('todos_apply', { ops: Array.from({ length: 55 }, (_, n) => ({ op: 'comment.create', id: `c${n}`, taskId: parent.id, body: n === 54 ? 'x'.repeat(3000) : `note ${n}` })) });
  const detail = call('todos_get', { id: parent.id });
  assert.deepEqual([detail.comments.length, detail.olderComments, detail.comments[0].body, detail.comments.at(-1).truncated], [50, 5, 'note 5', true]);
  assert.equal(detail.subtasks.length, 1);
  assert.equal(call('todos_get', { id: parent.id, comment: 'c54' }).comment.body.length, 3000, 'a cut comment can be read whole');
  assert.throws(() => call('todos_get', { id: parent.id, comment: 'nope' }), /not on this task/);
});

test('a comment carries screenshots and recordings from this computer, every path checked before the comment is made', async t => {
  const { store, call } = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-tool-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = new TodoFiles(dir, store);
  await files.start();
  const calls = { overview: () => store.overview(), detail: (id: string) => store.detail(id), completed: (input: Parameters<TodoStore['completed']>[0]) => store.completed(input),
    search: (query: string, input: Parameters<TodoStore['search']>[1]) => store.search(query, input), apply: (request: Parameters<TodoStore['apply']>[0], by: Parameters<TodoStore['apply']>[1]) => store.apply(request, by),
    attachFile: async (input: { taskId: string; commentId: string | null; path: string }) => (await files.attachLocal(input)).file };
  const withFiles = (args: Record<string, unknown>) => callTodoTool(calls, 'todos_comment', args, { now }) as Promise<any>;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(16, 1)]);
  await writeFile(join(dir, 'before.png'), png);
  await writeFile(join(dir, 'after.mp4'), Buffer.from('\0\0\0\x18ftypmp42 recording'));
  await writeFile(join(dir, 'notes.txt'), 'notes');
  const item = call('todos_add', { text: 'Header' }).added;

  await assert.rejects(withFiles({ id: item.id, body: 'Done', files: [join(dir, 'before.png'), join(dir, 'notes.txt')] }), /only screenshots/);
  await assert.rejects(withFiles({ id: item.id, body: 'Done', files: ['before.png'] }), /absolute path/);
  await assert.rejects(call('todos_comment', { id: item.id, body: 'Done', files: [join(dir, 'before.png')] }), /cannot be kept/, 'a store without files says so');
  assert.equal(store.detail(item.id).comments.length, 0, 'no comment while a file is wrong');

  const result = await withFiles({ id: item.id, body: '전/후', files: [join(dir, 'before.png'), join(dir, 'after.mp4')] });
  assert.deepEqual(result.attached.map((file: { name: string }) => file.name), ['before.png', 'after.mp4']);
  assert.equal(result.failed, undefined);
  const detail = call('todos_get', { id: item.id });
  assert.deepEqual(detail.files.map((file: { name: string; commentId: string }) => [file.name, file.commentId]), [['before.png', result.commented.id], ['after.mp4', result.commented.id]]);
  assert.deepEqual(store.detail(item.id).files.map(file => file.mimeType), ['image/png', 'video/mp4']);
  assert.deepEqual(Object.keys(await withFiles({ id: item.id, body: 'No files' })), ['commented'], 'without files the answer is as before');
  // A file that fails once the comment is made is reported, and the comment and the other files stay.
  const failing = { ...calls, attachFile: async (input: { taskId: string; commentId: string | null; path: string }) => input.path.endsWith('.mp4')
    ? Promise.reject(new TowerError('storage-full', 'disk full')) : (await files.attachLocal(input)).file };
  const partial = await callTodoTool(failing, 'todos_comment', { id: item.id, body: 'Partly', files: [join(dir, 'before.png'), join(dir, 'after.mp4')] }, { now }) as any;
  assert.deepEqual(partial.attached.map((file: { name: string }) => file.name), ['before.png']);
  assert.deepEqual(partial.failed, [{ path: join(dir, 'after.mp4'), error: 'disk full' }]);
  assert.ok(store.detail(item.id).comments.some(comment => comment.id === partial.commented.id));
});

test('in a Slack conversation the task an agent adds links to its thread, and only that task: not the one it completes, not elsewhere', async t => {
  const { store, call } = await fixture(t);
  const thread = { teamId: 'TBMLFLL3F', channel: 'C0A88QQ5607', threadTs: '1792746520.260769' };
  const before = call('todos_add', { text: 'Earlier, from the page' }).added;
  const slack = (name: string, args: Record<string, unknown>) => call(name, args, { slackThread: thread });
  const { added } = slack('todos_add', { text: 'B300 지원 여부 답변 #missing @beta' });
  assert.equal(added.slack, 'https://slack.com/archives/C0A88QQ5607/p1792746520260769');
  const { added: next, completed } = slack('todos_complete', { id: before.id, next: { text: 'Then reply @later' } });
  assert.deepEqual([store.detail(added.id).task.slackThread, store.detail(next.id).task.slackThread, store.detail(completed.id).task.slackThread, completed.slack], [thread, thread, undefined, undefined]);
  assert.equal(call('todos_add', { text: 'Elsewhere' }).added.slack, undefined);
  // Linking one made before, by hand.
  call('todos_apply', { ops: [{ op: 'task.update', id: before.id, patch: { slackThread: thread } }] });
  assert.equal(call('todos_get', { id: before.id }).task.slack, added.slack);
});
