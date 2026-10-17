import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UPLOAD_CHUNK_BYTES } from '../../../shared/attachments.js';
import { TowerError } from '../../../shared/errors.js';
import { TodoRequestSchema, type TodoOp } from '../../../shared/todo/ops.js';
import { TODO_FILE_MAX_BYTES } from '../../../shared/todo/types.js';
import { TODO_UPLOAD_TTL_MS, TodoFiles, todoFilePath } from '../../../server/todo/files.js';
import { TODO_SCHEMA_STEP } from '../../../server/todo/schema.js';
import { TODO_RETENTION_MS, TodoStore, type TodoTables } from '../../../server/todo/store.js';

const DAY = 24 * 60 * 60 * 1000;
const kind = (error: unknown) => error instanceof TowerError ? error.kind : undefined;
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function* once(value: Buffer) { yield value; }
/** The smallest bytes rasterMime takes for a PNG. */
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(16, 1)]);

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-files-'));
  let clock = new Date('2026-10-17T09:00:00.000Z');
  const open = async () => {
    const store = new TodoStore(dir, { now: () => clock });
    store.start();
    const files = new TodoFiles(dir, store, { now: () => clock.getTime() });
    await files.start();
    return { store, files };
  };
  let { store, files } = await open();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const apply = (...ops: TodoOp[]) => store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops }));
  const upload = async (taskId: string, content: Buffer, options: { commentId?: string; name?: string; mimeType?: string } = {}) => {
    const started = await files.startUpload({ taskId, commentId: options.commentId, name: options.name ?? 'notes.txt', mimeType: options.mimeType ?? 'text/plain', size: content.length });
    if (content.length) await files.appendUpload(started.id, 0, once(content));
    return files.completeUpload(started.id);
  };
  return {
    dir, apply, upload, get store() { return store; }, get files() { return files; },
    tick: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    reopen: async () => { store.close(); ({ store, files } = await open()); },
  };
}

test('an upload arrives in pieces, resumes where it stands, and completes once into contents stored once', async t => {
  const { dir, apply, store, files, upload } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' }, { op: 'task.create', id: 'u', content: 'Other' });
  const content = Buffer.from('hello attachment');
  const started = await files.startUpload({ taskId: 't', name: '보고서 final.txt', mimeType: 'text/plain', size: content.length });
  assert.equal(started.offset, 0);
  assert.equal((await files.appendUpload(started.id, 0, once(content.subarray(0, 5)))).offset, 5);
  assert.equal(await files.uploadOffset(started.id), 5);
  await assert.rejects(files.appendUpload(started.id, 2, once(content.subarray(2))), (error: unknown) => kind(error) === 'conflict' && (error as { offset?: number }).offset === 5);
  await assert.rejects(files.appendUpload(started.id, 5, once(Buffer.alloc(content.length))), (error: unknown) => kind(error) === 'invalid', 'more than it said it was');
  assert.equal(await files.uploadOffset(started.id), 5, 'a refused piece is taken back whole');
  await assert.rejects(files.completeUpload(started.id), (error: unknown) => kind(error) === 'conflict' && (error as { offset?: number }).offset === 5);
  await files.appendUpload(started.id, 5, once(content.subarray(5)));
  const done = await files.completeUpload(started.id);
  assert.deepEqual({ ...done.file, id: 'x', createdAt: 'x' }, { id: 'x', taskId: 't', commentId: null, name: '보고서 final.txt', mimeType: 'text/plain', size: content.length, sha256: sha(content), createdAt: 'x', deletedAt: null });
  assert.deepEqual(done.changes.files, [done.file]);
  assert.equal(done.changes.revision, store.revision());
  assert.deepEqual(await files.completeUpload(started.id), done, 'completing again answers the same');
  assert.equal(store.revision(), done.changes.revision);
  await assert.rejects(files.appendUpload(started.id, content.length, once(Buffer.from('x'))), (error: unknown) => kind(error) === 'conflict');
  assert.equal((await stat(todoFilePath(dir, sha(content)))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'todo-files'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'todo-uploads'))).mode & 0o777, 0o700);
  assert.deepEqual(store.detail('t').files, [done.file]);
  assert.deepEqual(store.overview().fileCounts, { t: 1 });
  // The same contents on another task: a second row, one copy.
  const again = await upload('u', content, { name: 'copy.txt' });
  assert.notEqual(again.file.id, done.file.id);
  assert.deepEqual((await readdir(join(dir, 'todo-files'))).filter(name => !name.startsWith('.')), [sha(content)]);
  // A piece is at most 4 MiB.
  const big = await files.startUpload({ taskId: 't', name: 'big.bin', mimeType: '', size: UPLOAD_CHUNK_BYTES + 1 });
  await assert.rejects(files.appendUpload(big.id, 0, once(Buffer.alloc(UPLOAD_CHUNK_BYTES + 1))), (error: unknown) => kind(error) === 'too-large');
  assert.equal(await files.uploadOffset(big.id), 0);
  await files.cancelUpload(big.id);
  await assert.rejects(files.uploadOffset(big.id), (error: unknown) => kind(error) === 'not-found');
});

test('a file is at most 100 MiB, with a name and type that can be shown and sent', async t => {
  const { apply, files } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' });
  await assert.rejects(files.startUpload({ taskId: 't', name: 'huge.bin', mimeType: 'application/octet-stream', size: TODO_FILE_MAX_BYTES + 1 }), (error: unknown) => kind(error) === 'too-large');
  assert.equal((await files.startUpload({ taskId: 't', name: 'max.bin', mimeType: 'application/octet-stream', size: TODO_FILE_MAX_BYTES })).offset, 0);
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'line\nbreak', 'x'.repeat(256)]) {
    await assert.rejects(files.startUpload({ taskId: 't', name, mimeType: 'text/plain', size: 1 }), (error: unknown) => kind(error) === 'invalid', JSON.stringify(name));
  }
  await assert.rejects(files.startUpload({ taskId: 't', name: 'a.txt', mimeType: 'text/plain; charset=utf-8', size: 1 }), (error: unknown) => kind(error) === 'invalid');
  await assert.rejects(files.startUpload({ taskId: 't', name: 'a.txt', mimeType: 'text/plain', size: -1 }), (error: unknown) => kind(error) === 'invalid');
});

test('completing again after a stop between moving the contents and adding the row, or before the answer is kept, makes one row', async t => {
  const { dir, apply, store, files } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' });
  const content = Buffer.from('crash-safe contents');
  const started = await files.startUpload({ taskId: 't', name: 'a.txt', mimeType: 'text/plain', size: content.length });
  await files.appendUpload(started.id, 0, once(content));
  const attach = store.attach.bind(store);
  store.attach = () => { throw new Error('stopped'); };
  await assert.rejects(files.completeUpload(started.id), /stopped/);
  store.attach = attach;
  assert.equal((await stat(todoFilePath(dir, sha(content)))).size, content.length, 'the contents moved into place');
  await assert.rejects(stat(join(dir, 'todo-uploads', started.id, 'content')), { code: 'ENOENT' });
  // A cleanup meanwhile keeps contents an unfinished upload is about to name.
  await files.purge();
  const done = await files.completeUpload(started.id);
  assert.deepEqual(store.detail('t').files.map(file => file.id), [done.file.id]);
  // Stopped after the row was added, before the answer was kept: the fixed id finds the row.
  const manifestPath = join(dir, 'todo-uploads', started.id, 'manifest.json');
  const { receipt: _receipt, ...manifest } = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const revision = store.revision();
  const repeated = await files.completeUpload(started.id);
  assert.deepEqual(repeated.file, done.file);
  assert.equal(store.revision(), revision, 'nothing changed');
  assert.equal(store.detail('t').files.length, 1);
});

test('completion checks again that the task and the comment are there, and the comment is the task’s', async t => {
  const { apply, store, files, upload } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' }, { op: 'task.create', id: 'u', content: 'Other' }, { op: 'comment.create', id: 'c', taskId: 't', body: 'See file' });
  await assert.rejects(files.startUpload({ taskId: 'u', commentId: 'c', name: 'a.txt', mimeType: 'text/plain', size: 1 }), (error: unknown) => kind(error) === 'invalid');
  await assert.rejects(files.startUpload({ taskId: 'missing', name: 'a.txt', mimeType: 'text/plain', size: 1 }), (error: unknown) => kind(error) === 'not-found');
  const started = await files.startUpload({ taskId: 't', commentId: 'c', name: 'a.txt', mimeType: 'text/plain', size: 1 });
  await files.appendUpload(started.id, 0, once(Buffer.from('a')));
  apply({ op: 'comment.delete', id: 'c' });
  await assert.rejects(files.completeUpload(started.id), (error: unknown) => kind(error) === 'not-found');
  apply({ op: 'comment.restore', id: 'c' });
  const done = await files.completeUpload(started.id);
  assert.equal(done.file.commentId, 'c');
  apply({ op: 'task.delete', id: 't' });
  await assert.rejects(upload('t', Buffer.from('b')), (error: unknown) => kind(error) === 'not-found');
  assert.equal(store.visibleFile(done.file.id), undefined);
});

test('what shows comes from the file, its task and its comment, whichever build deleted and restored them', async t => {
  const { dir, apply, store, upload } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' }, { op: 'comment.create', id: 'c', taskId: 't', body: 'With a file' });
  const own = await upload('t', Buffer.from('description file'));
  const onComment = await upload('t', Buffer.from('comment file'), { commentId: 'c' });
  const shown = () => store.detail('t').files.map(file => file.id);
  assert.deepEqual(shown(), [own.file.id, onComment.file.id]);
  assert.deepEqual(store.overview().fileCounts, { t: 2 });

  apply({ op: 'comment.delete', id: 'c' });
  assert.deepEqual(shown(), [own.file.id]);
  assert.equal(store.visibleFile(onComment.file.id), undefined);
  assert.deepEqual(store.overview().fileCounts, { t: 1 });
  apply({ op: 'comment.restore', id: 'c' });
  assert.deepEqual(shown(), [own.file.id, onComment.file.id]);
  apply({ op: 'file.delete', id: onComment.file.id }, { op: 'comment.delete', id: 'c' });
  assert.throws(() => apply({ op: 'file.restore', id: onComment.file.id }), (error: unknown) => kind(error) === 'not-found', 'nothing restores below a deleted comment');
  apply({ op: 'comment.restore', id: 'c' }, { op: 'file.restore', id: onComment.file.id });
  assert.deepEqual(shown(), [own.file.id, onComment.file.id]);

  apply({ op: 'task.delete', id: 't' });
  assert.equal(store.visibleFile(own.file.id), undefined);
  assert.deepEqual(store.overview().fileCounts, {});
  apply({ op: 'task.restore', id: 't' });
  assert.deepEqual(shown(), [own.file.id, onComment.file.id]);

  const deleted = apply({ op: 'file.delete', id: own.file.id });
  assert.equal(deleted.files[0]?.id, own.file.id);
  assert.ok(deleted.files[0]?.deletedAt);
  assert.deepEqual(shown(), [onComment.file.id]);
  apply({ op: 'file.restore', id: own.file.id });
  assert.deepEqual(shown(), [own.file.id, onComment.file.id]);

  // A build that knows only step 1 deletes and restores the task without knowing files exist.
  store.close();
  const older = new DatabaseSync(join(dir, 'todos.sqlite'));
  older.prepare('UPDATE todo_tasks SET deleted_at = ?, deleted_with = ? WHERE id = ?').run('2026-10-17T09:00:00.000Z', 'older', 't');
  const reopened = new TodoStore(dir);
  reopened.start();
  assert.equal(reopened.visibleFile(own.file.id), undefined);
  reopened.close();
  older.prepare('UPDATE todo_tasks SET deleted_at = NULL, deleted_with = NULL WHERE id = ?').run('t');
  older.close();
  const back = new TodoStore(dir);
  back.start();
  t.after(() => back.close());
  assert.deepEqual(back.detail('t').files.map(file => file.id), [own.file.id, onComment.file.id]);
});

test('deleted file rows go after 30 days with their parents, then contents no row names; uploads left for a day go too', async t => {
  const { dir, apply, store, files, upload, tick } = await fixture(t);
  apply({ op: 'task.create', id: 't1', content: 'One' }, { op: 'task.create', id: 't2', content: 'Two' }, { op: 'task.create', id: 't3', content: 'Three' });
  const a = Buffer.from('shared contents'), b = Buffer.from('only on three');
  const first = await upload('t1', a), second = await upload('t2', a);
  await upload('t3', b);
  apply({ op: 'file.delete', id: first.file.id });
  tick(TODO_RETENTION_MS + 1000);
  store.purge(); await files.purge();
  assert.throws(() => apply({ op: 'file.restore', id: first.file.id }), (error: unknown) => kind(error) === 'not-found');
  assert.ok(await files.hasContent(sha(a), a.length), 'another row still names it');
  apply({ op: 'file.delete', id: second.file.id }, { op: 'task.delete', id: 't3' });
  // An upload left unfinished, and one finished but never completed whose contents already moved.
  const left = await files.startUpload({ taskId: 't1', name: 'left.txt', mimeType: 'text/plain', size: 4 });
  await files.appendUpload(left.id, 0, once(Buffer.from('left')));
  tick(TODO_RETENTION_MS + 1000);
  store.purge(); await files.purge();
  assert.equal(await files.hasContent(sha(a), a.length), false);
  assert.equal(await files.hasContent(sha(b), b.length), false, 'gone with its task');
  assert.deepEqual(await readdir(join(dir, 'todo-files')), []);
  assert.deepEqual(await readdir(join(dir, 'todo-uploads')), [], 'left for a day');
  // Contents uploaded again after their rows went are kept by their new row.
  await upload('t1', a);
  tick(DAY * 31);
  store.purge(); await files.purge();
  assert.ok(await files.hasContent(sha(a), a.length));
  assert.ok(TODO_UPLOAD_TTL_MS <= DAY);
});

test('a build older than the file never removes contents', async t => {
  const fx = await fixture(t);
  fx.store.close();
  const db = new DatabaseSync(join(fx.dir, 'todos.sqlite'));
  db.exec(`PRAGMA user_version = ${TODO_SCHEMA_STEP + 1}`);
  db.close();
  await fx.reopen();
  const orphan = Buffer.from('named by a table this build does not know');
  await writeFile(todoFilePath(fx.dir, sha(orphan)), orphan, { mode: 0o600 });
  await fx.files.purge();
  assert.ok(await fx.files.hasContent(sha(orphan), orphan.length));
});

test('an attachment opens only while it shows, and as an image only when its bytes are one', async t => {
  const { dir, apply, files, upload } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' });
  const image = await upload('t', PNG, { name: 'shot.png', mimeType: 'image/png' });
  const fake = await upload('t', Buffer.from('<script>alert(1)</script> padded to look long enough'), { name: 'fake.png', mimeType: 'image/png' });
  const opened = await files.openFile(image.file.id, true);
  assert.equal(opened.image, 'image/png');
  await opened.handle.close();
  const pretending = await files.openFile(fake.file.id, true);
  assert.equal(pretending.image, undefined);
  await pretending.handle.close();
  const plain = await files.openFile(image.file.id);
  assert.equal(plain.image, undefined, 'only when asked');
  await plain.handle.close();
  apply({ op: 'file.delete', id: image.file.id });
  await assert.rejects(files.openFile(image.file.id), (error: unknown) => kind(error) === 'not-found');
  await rm(todoFilePath(dir, fake.file.sha256));
  await assert.rejects(files.openFile(fake.file.id), (error: unknown) => kind(error) === 'not-found');
});

test('restored file rows must name contents inside the store, and paths are built only from a content hash', async t => {
  const { dir, apply, store, upload } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' });
  const kept = await upload('t', Buffer.from('kept'));
  const tables = store.backupData()!.tables;
  const row = tables.todo_files![0]!;
  for (const [field, value] of [['sha256', '../../../package.json'], ['sha256', 'A'.repeat(64)], ['size', -1], ['size', 1.5], ['name', 'a/b'], ['mime', 'not a type'], ['id', 'x/y']] as const) {
    const bad = { ...tables, todo_files: [{ ...row, [field]: value }] };
    assert.throws(() => store.restoreData(TODO_SCHEMA_STEP, bad), (error: unknown) => kind(error) === 'invalid', `${field}: ${value}`);
  }
  assert.deepEqual(store.detail('t').files.map(file => file.id), [kept.file.id], 'nothing was replaced');
  assert.throws(() => todoFilePath(dir, '../../../package.json'), (error: unknown) => kind(error) === 'invalid');
});

test('a cleanup waiting its turn keeps contents an upload moved into place after the cleanup began', async t => {
  const { dir, apply, store, files } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' });
  const content = Buffer.from('moved while a cleanup waited');
  const started = await files.startUpload({ taskId: 't', name: 'a.txt', mimeType: 'text/plain', size: content.length });
  await files.appendUpload(started.id, 0, once(content));
  // The cleanup reads the uploads now, then waits for its turn while the upload moves its contents and fails to add its row.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const turn = files.contentTurnOf.bind(files);
  let first = true, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  files.contentTurnOf = <T>(work: () => T | Promise<T>) => {
    if (!first) return turn(work);
    first = false;
    entered();
    return gate.then(() => turn(work));
  };
  const cleaning = files.purge();
  await waiting;
  const attach = store.attach.bind(store);
  store.attach = () => { throw new Error('stopped'); };
  await assert.rejects(files.completeUpload(started.id), /stopped/);
  store.attach = attach;
  release();
  await cleaning;
  assert.ok(await files.hasContent(sha(content), content.length), 'the upload may still be completed');
  const done = await files.completeUpload(started.id);
  assert.equal(done.file.sha256, sha(content));
  assert.ok((await stat(todoFilePath(dir, sha(content)))).isFile());
});

test('contents with another link to them are not served', async t => {
  const { dir, apply, files, upload } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' });
  const done = await upload('t', Buffer.from('linked elsewhere'));
  await link(todoFilePath(dir, done.file.sha256), join(dir, 'elsewhere'));
  await assert.rejects(files.openFile(done.file.id), (error: unknown) => kind(error) === 'not-found');
});

test('contents only a kept copy from before a restore names stay, so going back to it finds them', async t => {
  const { apply, store, files, upload, tick } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' });
  const content = Buffer.from('only in the copy before the restore');
  await upload('t', content);
  const tables = store.backupData()!.tables;
  store.restoreData(TODO_SCHEMA_STEP, { ...tables, todo_files: [] });
  tick(TODO_RETENTION_MS + 1000);
  store.purge(); await files.purge();
  assert.ok(await files.hasContent(sha(content), content.length));
});

test('the same contents uploaded again replace a damaged or linked copy', async t => {
  const { dir, apply, store, upload } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' });
  const content = Buffer.from('good bytes, same size as the damage');
  const first = await upload('t', content);
  await writeFile(todoFilePath(dir, sha(content)), Buffer.alloc(content.length, 0x42));
  assert.equal(store.detail('t').files[0]?.missing, undefined, 'the size still matches');
  await upload('t', content);
  assert.deepEqual(await readFile(todoFilePath(dir, sha(content))), content);
  await link(todoFilePath(dir, sha(content)), join(dir, 'elsewhere'));
  assert.equal(store.detail('t').files.find(file => file.id === first.file.id)?.missing, true, 'a linked copy cannot be used');
  await upload('t', content);
  assert.equal((await stat(todoFilePath(dir, sha(content)))).nlink, 1);
  assert.equal(store.detail('t').files.some(file => file.missing), false);
});

test('a task’s detail marks contents missing by the same test that serving makes', async t => {
  const { dir, apply, store, files, upload } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' });
  const done = await upload('t', Buffer.from('contents of one size'));
  await writeFile(todoFilePath(dir, done.file.sha256), Buffer.from('another size'));
  assert.equal(store.detail('t').files[0]?.missing, true);
  await assert.rejects(files.openFile(done.file.id), (error: unknown) => kind(error) === 'not-found');
});

test('a restore refused for an unknown table, column or a broken reference leaves the rows and the revision as they were', async t => {
  const { apply, store } = await fixture(t);
  apply({ op: 'task.create', id: 't', content: 'Task' });
  const tables = store.backupData()!.tables;
  const before = { tables: store.backupData()!.tables, revision: store.revision() };
  const cases: [string, TodoTables][] = [
    ['an unknown table', { ...tables, todo_future: [{ id: 'x' }] }],
    ['an unknown column', { ...tables, todo_tasks: tables.todo_tasks!.map(row => ({ ...row, effort: 1 })) }],
    ['a task in a project that is not there', { ...tables, todo_tasks: tables.todo_tasks!.map(row => ({ ...row, project_id: 'gone' })) }],
  ];
  for (const [what, bad] of cases) {
    assert.throws(() => store.restoreData(TODO_SCHEMA_STEP, bad), (error: unknown) => kind(error) === 'invalid' || /FOREIGN KEY/.test(String(error)), what);
    assert.deepEqual(store.backupData()!.tables, before.tables, what);
    assert.equal(store.revision(), before.revision, what);
  }
});
