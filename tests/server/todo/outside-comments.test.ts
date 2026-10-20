import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoRequestSchema, type TodoOp } from '../../../shared/todo/ops.js';
import type { TodoCommentAuthor } from '../../../shared/todo/types.js';
import { TodoStore } from '../../../server/todo/store.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-outside-'));
  // One clock for every comment: the newest is told by insertion, not by time.
  const store = new TodoStore(dir, { now: () => new Date('2026-10-20T09:00:00.000Z') });
  store.start();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const apply = (by: TodoCommentAuthor, ...ops: TodoOp[]) => store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops }), by);
  return { store, apply, dir };
}

test('the overview names each open todo’s newest comment the owner did not write', async t => {
  const { store, apply, dir } = await fixture(t);
  apply('owner',
    { op: 'task.create', id: 'a', content: 'Agent wrote' },
    { op: 'task.create', id: 'b', content: 'Owner only' },
    { op: 'task.create', id: 'c', content: 'Done' },
    { op: 'task.create', id: 'd', content: 'Deleted comment' },
  );
  apply('agent', { op: 'comment.create', id: 'a1', taskId: 'a', body: 'First' }, { op: 'comment.create', id: 'a0', taskId: 'a', body: 'Second' });
  apply('owner', { op: 'comment.create', id: 'a2', taskId: 'a', body: 'Owner reply' }, { op: 'comment.create', id: 'b1', taskId: 'b', body: 'Mine' });
  apply('agent', { op: 'comment.create', id: 'c1', taskId: 'c', body: 'Report' }, { op: 'comment.create', id: 'd1', taskId: 'd', body: 'Kept' }, { op: 'comment.create', id: 'd2', taskId: 'd', body: 'Gone' });
  apply('owner', { op: 'task.complete', id: 'c', completionId: 'done', occurrence: null, today: '2026-10-20' }, { op: 'comment.delete', id: 'd2' });
  assert.deepEqual(store.overview().outside, { a: 'a0', d: 'd1' });
  // A comment whose author is not recorded (GitHub's, or one from before 1.162.0) is not the owner's.
  apply('owner', { op: 'comment.create', id: 'b2', taskId: 'b', body: 'From GitHub' });
  const db = new DatabaseSync(join(dir, 'todos.sqlite'));
  db.prepare("UPDATE todo_comments SET author = NULL WHERE id = 'b2'").run();
  db.close();
  assert.deepEqual(store.overview().outside, { a: 'a0', b: 'b2', d: 'd1' });
});
