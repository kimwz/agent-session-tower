import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BackupService } from '../../../server/backup/service.js';
import type { SkillBackup } from '../../../server/backup/payload.js';
import { TODO_FILES_FOLDER, TODO_SIDECAR, TodoBackup } from '../../../server/todo/backup.js';
import { TodoFiles, todoFilePath } from '../../../server/todo/files.js';
import { TODO_SCHEMA_STEP } from '../../../server/todo/schema.js';
import { TODO_RETENTION_MS, TodoStore } from '../../../server/todo/store.js';
import { TodoRequestSchema, type TodoOp } from '../../../shared/todo/ops.js';
import { fakeBucket } from '../../helpers/s3.js';
import { fastScrypt } from '../../helpers/fast-scrypt.js';

fastScrypt();

const PASS = 'correct horse battery';
const PIECE = 64;
const HOUR = 60 * 60 * 1000;
const skills: SkillBackup = { bundle: { format: 'agent-session-tower.skills', version: 1, exportedAt: '', from: 'a', skills: [] }, guidance: '', settings: { enabled: true, provider: 'claude' } };
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function* once(value: Buffer) { yield value; }
const store = { backupValue: () => undefined, restore: async () => undefined };

type Bucket = Awaited<ReturnType<typeof fakeBucket>>;

/** What the bucket does differently, for the requests it is asked. */
interface Faults { failDelete: Set<string>; failList: boolean; truncateList: boolean }

async function computer(t: TestContext, bucket: Bucket, options: { stateDir?: string; host?: string; keep?: number; faults?: Faults; clock?: { now: number } } = {}) {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), 'tower-todo-backup-'));
  const clock = options.clock ?? { now: Date.parse('2026-10-17T09:00:00Z') };
  const todos = new TodoStore(stateDir, { now: () => new Date(clock.now) });
  todos.start();
  const files = new TodoFiles(stateDir, todos, { now: () => clock.now });
  await files.start();
  const backup = new TodoBackup(todos, files, stateDir, { pieceBytes: PIECE });
  const faults = options.faults;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ''));
    if (init?.method === 'DELETE' && faults?.failDelete.has(key)) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    const attachmentList = init?.method === 'GET' && url.searchParams.has('list-type') && (url.searchParams.get('prefix') ?? '').includes(TODO_FILES_FOLDER);
    if (attachmentList && faults?.failList) return new Response('<Error><Code>AccessDenied</Code><Message>no listing</Message></Error>', { status: 403 });
    const response = await fetch(input, init);
    if (attachmentList && faults?.truncateList) return new Response((await response.text()).replace('<IsTruncated>false</IsTruncated>', '<IsTruncated>true</IsTruncated>'), { status: 200 });
    return response;
  };
  const service = new BackupService({ stateDir, version: '1.140.0', skills: async () => structuredClone(skills), triggers: async () => undefined,
    settings: async () => ({ 'permissions.json': {}, 'slack-automation.json': {}, 'github-automation.json': {} }), restartWorker: async () => true,
    stores: { groups: store, exclusions: store, decisions: store }, todos: backup, fetcher, now: () => clock.now, host: options.host ?? 'studio' });
  await service.start();
  await service.saveSettings({ enabled: false, intervalHours: 24, keep: options.keep ?? 14, passphrase: PASS,
    remote: { endpoint: bucket.endpoint, bucket: 'bucket', prefix: 'tower/', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret-key' } });
  t.after(async () => { service.close(); await service.flush(); backup.close(); await backup.downloads(); todos.close(); if (!options.stateDir) await rm(stateDir, { recursive: true, force: true }); });
  const apply = (...ops: TodoOp[]) => todos.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops }));
  const attach = async (taskId: string, content: Buffer, name = 'file.bin') => {
    const started = await files.startUpload({ taskId, name, mimeType: 'application/octet-stream', size: content.length });
    await files.appendUpload(started.id, 0, once(content));
    return (await files.completeUpload(started.id)).file;
  };
  /** Makes a backup an hour after the last, so each has a name of its own. */
  const upload = async () => { clock.now += HOUR; return service.upload(); };
  const restore = async (key: string, passphrase = PASS) => {
    const report = await service.apply((await service.check(bucket.objects.get(key)!.body.toString('utf8'), passphrase)).id);
    await backup.downloads();
    return report;
  };
  const computerName = async () => (JSON.parse(await readFile(join(stateDir, 'backup-settings.json'), 'utf8')) as { machine: string }).machine;
  return { stateDir, clock, todos, files, backup, service, apply, attach, upload, restore, machine: await computerName(), host: options.host ?? 'studio' };
}
type Computer = Awaited<ReturnType<typeof computer>>;

/** This computer's namespace for its current key. */
const namespaceOf = (c: Computer) => c.backup.snapshot(`${c.host}-${c.machine}`)!.part.files!.namespace;
const objectsOf = (bucket: Bucket, prefix: string) => [...bucket.objects.keys()].filter(key => key.startsWith(prefix)).sort();
const piecesOf = (bucket: Bucket, namespace: string, content: Buffer) => objectsOf(bucket, `tower/${TODO_FILES_FOLDER}${namespace}/${sha(content)}/`);
const attachmentPuts = (bucket: Bucket, from: number) => bucket.seen.slice(from).filter(line => line.startsWith('PUT ') && line.includes(TODO_FILES_FOLDER.slice(0, -1)));
const content = (c: Computer, value: Buffer) => readFile(todoFilePath(c.stateDir, sha(value)));
/** Everything in the data tables, as a backup reads it. */
const tables = (c: Computer) => c.todos.backupData()!.tables;

test('todos and their attachments go to the bucket, encrypted in pieces, only once, and come back on another computer', async t => {
  const bucket = await fakeBucket(t);
  const a = await computer(t, bucket);
  a.apply({ op: 'project.create', id: 'p', name: 'Work' }, { op: 'label.create', id: 'l', name: 'urgent' },
    { op: 'task.create', id: 't', projectId: 'p', content: 'Report', labelIds: ['l'], dueDate: '2026-10-20', recurrence: { freq: 'week', interval: 1 } },
    { op: 'task.create', id: 'u', parentId: 't', content: 'Draft' }, { op: 'comment.create', id: 'c', taskId: 't', body: 'Notes' },
    { op: 'task.create', id: 'n', content: 'Next' }, { op: 'link.create', id: 'k', fromTaskId: 't', toTaskId: 'n' });
  a.apply({ op: 'task.complete', id: 'u', completionId: 'done-u', occurrence: null, today: '2026-10-17' });
  const small = Buffer.from('a small note');
  const large = randomBytes(PIECE * 15 + 7);
  const onComment = Buffer.from('on the comment');
  await a.attach('t', small, 'note.txt');
  await a.attach('t', large, 'random.bin');
  await a.attach('t', onComment);
  const deleted = await a.attach('n', Buffer.from('deleted but within 30 days'));
  a.apply({ op: 'file.delete', id: deleted.id }, { op: 'comment.create', id: 'c2', taskId: 'n', body: 'Gone' }, { op: 'comment.delete', id: 'c2' });
  const key = await a.upload();
  const namespace = namespaceOf(a);
  assert.match(namespace, new RegExp(`^studio-${a.machine}-[0-9a-f]{16}$`));
  // Incompressible contents in pieces of the configured size, each sealed apart.
  const pieces = piecesOf(bucket, namespace, large);
  assert.equal(pieces.length, 16);
  assert.deepEqual(pieces.map(name => name.slice(name.lastIndexOf('/') + 1)).sort(), Array.from({ length: 16 }, (_, index) => `${index + 1}-of-16`).sort());
  for (const name of pieces) {
    const body = bucket.objects.get(name)!.body;
    assert.ok(body.length <= PIECE + 28);
    assert.equal(body.includes(large.subarray(0, 16)), false, 'sealed');
  }
  assert.equal(piecesOf(bucket, namespace, small).length, 1);
  assert.ok(bucket.objects.has(`${key}${TODO_SIDECAR}`), 'the list of what the backup needs is beside it');
  const body = bucket.objects.get(key)!.body.toString('utf8');
  assert.equal(body.includes('a small note'), false);

  // A second backup uploads only what is new.
  const added = randomBytes(PIECE * 2);
  await a.attach('n', added);
  const before = bucket.seen.length;
  const second = await a.upload();
  assert.deepEqual(attachmentPuts(bucket, before).map(line => line.split('/').slice(-2, -1)[0]).filter((value, index, all) => all.indexOf(value) === index), [sha(added)]);
  assert.equal(attachmentPuts(bucket, before).length, 2);

  // Another computer, with its own key: its rows become these, its attachments come from the first computer's namespace.
  const b = await computer(t, bucket, { host: 'laptop' });
  b.apply({ op: 'task.create', id: 'mine', content: 'Replaced by the restore' });
  const keyBefore = b.todos.filesKey();
  const revision = b.todos.revision();
  const report = await b.restore(second);
  assert.ok(report.applied.includes('todos'), JSON.stringify(report));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(tables(b), tables(a));
  assert.equal(b.todos.filesKey(), keyBefore, 'this computer keeps its own key');
  assert.ok(b.todos.revision() > revision + 1, 'restored, then the attachments came back');
  assert.deepEqual(b.todos.overview().restore, { state: 'done', total: 5, missing: 0 }, 'the deleted file is brought back too, for its 30 days');
  for (const value of [small, large, onComment, added, Buffer.from('deleted but within 30 days')]) assert.deepEqual(await content(b, value), value);
  assert.deepEqual(b.todos.detail('t').files.map(file => file.name), ['note.txt', 'random.bin', 'file.bin']);
  assert.equal(b.todos.detail('t').files.some(file => file.missing), false);
  // The file's own bookkeeping stays its own.
  b.todos.close();
  const db = new DatabaseSync(join(b.stateDir, 'todos.sqlite'), { readOnly: true });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM todo_requests').get() as { n: number }).n, 1, 'only its own request');
  assert.equal((db.prepare("SELECT value FROM todo_meta WHERE key = 'min_writer'").get() as { value: string }).value, '1');
  db.close();
  b.todos.start();
  assert.ok(report.todoBefore);
  assert.equal((await stat(report.todoBefore)).mode & 0o777, 0o600);
  const copy = new DatabaseSync(report.todoBefore, { readOnly: true });
  t.after(() => copy.close());
  assert.deepEqual(copy.prepare('SELECT id FROM todo_tasks').all().map(row => (row as { id: string }).id), ['mine'], 'the file before the restore');

  // Its next backup puts the attachments in its own namespace, under its own key.
  await b.upload();
  const own = namespaceOf(b);
  assert.notEqual(own, namespace);
  assert.equal(piecesOf(bucket, own, large).length, 16);
});

test('a changed passphrase needs no attachment uploaded again, and both backups open their attachments', async t => {
  const bucket = await fakeBucket(t);
  const a = await computer(t, bucket);
  a.apply({ op: 'task.create', id: 't', content: 'Task' });
  const file = randomBytes(PIECE * 3);
  await a.attach('t', file);
  const first = await a.upload();
  await a.service.saveSettings({ enabled: false, intervalHours: 24, keep: 14, passphrase: 'a different passphrase', remote: { endpoint: bucket.endpoint, bucket: 'bucket', prefix: 'tower/', region: 'auto', accessKeyId: 'AKID' } });
  const before = bucket.seen.length;
  const second = await a.upload();
  assert.deepEqual(attachmentPuts(bucket, before), []);
  for (const [key, passphrase] of [[second, 'a different passphrase'], [first, PASS]] as const) {
    const b = await computer(t, bucket);
    await b.restore(key, passphrase);
    assert.deepEqual(b.todos.overview().restore, { state: 'done', total: 1, missing: 0 });
    assert.deepEqual(await content(b, file), file);
  }
});

test('old attachment objects go only when no backup still there lists them; other computers’ and unreadable lists stop nothing of theirs', async t => {
  const bucket = await fakeBucket(t);
  const faults: Faults = { failDelete: new Set(), failList: false, truncateList: false };
  const a = await computer(t, bucket, { keep: 1, faults });
  a.apply({ op: 'task.create', id: 't', content: 'Task' }, { op: 'task.create', id: 'keep', content: 'Keeps a file' });
  const old = Buffer.from('attached, then deleted');
  const kept = Buffer.from('attached for good');
  const oldFile = await a.attach('t', old);
  await a.attach('keep', kept);
  const first = await a.upload();
  const namespace = namespaceOf(a);
  const computerPrefix = `tower/${TODO_FILES_FOLDER}studio-${a.machine}-`;
  // Not this computer's, or from a key it lost: a host whose name starts with this one's, another computer, an old key.
  const lookalike = `${computerPrefix}zz-0123456789abcdef/${sha(old)}/1-of-1`;
  const other = `tower/${TODO_FILES_FOLDER}other-abcdef-0123456789abcdef/${sha(old)}/1-of-1`;
  const oldKey = `${computerPrefix}0000000000000000/${sha(old)}/1-of-1`;
  for (const name of [lookalike, other, oldKey]) bucket.objects.set(name, { body: Buffer.from('x'), at: '2026-01-01T00:00:00Z' });

  // The file goes from this computer for good; the first backup, still there, lists it.
  a.apply({ op: 'file.delete', id: oldFile.id });
  a.clock.now += TODO_RETENTION_MS + HOUR;
  a.todos.purge(); await a.files.purge();
  assert.equal(await a.files.hasContent(sha(old), old.length), false);
  // Removing the first backup fails, so it stays, and so does what it lists.
  faults.failDelete.add(first);
  await a.upload();
  assert.match((await a.service.overview()).status.lastWarning ?? '', /오래된 백업을 정리하지 못했습니다/);
  assert.ok(bucket.objects.has(first));
  assert.equal(piecesOf(bucket, namespace, old).length, 1, 'listed by a backup that could not be removed');
  assert.equal(bucket.objects.has(oldKey), false, 'an old key’s object no backup lists');
  assert.ok(bucket.objects.has(lookalike) && bucket.objects.has(other));

  // A list that cannot be read, and a listing that may not be whole, each stop the cleanup.
  faults.failDelete.clear();
  const unreadable = await a.upload();
  const sidecar = bucket.objects.get(`${unreadable}${TODO_SIDECAR}`)!;
  bucket.objects.set(`${unreadable}${TODO_SIDECAR}`, { ...sidecar, body: Buffer.from('damaged') });
  bucket.objects.set(oldKey, { body: Buffer.from('x'), at: '2026-01-01T00:00:00Z' });
  faults.failDelete.add(unreadable);
  await a.upload();
  assert.ok(bucket.objects.has(oldKey), 'a backup whose list cannot be read may need anything');
  faults.failDelete.clear();
  faults.truncateList = true;
  await a.upload();
  assert.ok(bucket.objects.has(oldKey), 'an incomplete listing removes nothing');
  faults.truncateList = false;

  // Once every backup that listed it is gone, it goes; its list goes with each backup.
  await a.upload();
  assert.deepEqual(piecesOf(bucket, namespace, old), []);
  assert.equal(bucket.objects.has(oldKey), false);
  assert.equal(piecesOf(bucket, namespace, kept).length, 1, 'still named by the file');
  assert.ok(bucket.objects.has(lookalike) && bucket.objects.has(other), 'never another computer’s');
  const backups = objectsOf(bucket, `tower/tower-backup-studio-${a.machine}-`);
  assert.equal(backups.filter(name => name.endsWith('.towerbackup')).length, 1);
  assert.deepEqual(backups.filter(name => name.endsWith(TODO_SIDECAR)), backups.filter(name => name.endsWith('.towerbackup')).map(name => `${name}${TODO_SIDECAR}`));

  // Uploaded again after its rows went: named by the file once more, so it stays.
  const again = await a.attach('t', old);
  await a.upload();
  assert.equal(piecesOf(bucket, namespace, old).length, 1);
  assert.ok(again);
});

test('a bucket that cannot list attachments gets them all again and keeps everything, and the backup still succeeds', async t => {
  const bucket = await fakeBucket(t);
  const faults: Faults = { failDelete: new Set(), failList: false, truncateList: false };
  const a = await computer(t, bucket, { keep: 1, faults });
  a.apply({ op: 'task.create', id: 't', content: 'Task' });
  const file = randomBytes(PIECE * 2);
  const gone = await a.attach('t', Buffer.from('to be removed'));
  await a.attach('t', file);
  await a.upload();
  a.apply({ op: 'file.delete', id: gone.id });
  a.clock.now += TODO_RETENTION_MS + HOUR;
  a.todos.purge(); await a.files.purge();
  faults.failList = true;
  const before = bucket.seen.length;
  const key = await a.upload();
  assert.ok(bucket.objects.has(key));
  assert.equal((await a.service.overview()).status.lastError, undefined);
  assert.equal(attachmentPuts(bucket, before).length, 2, 'every piece again');
  assert.equal(piecesOf(bucket, namespaceOf(a), Buffer.from('to be removed')).length, 1, 'no cleanup without a listing');
});

test('a backup of a computer whose todo file was made anew restores, backs up under the new key, and opens elsewhere', async t => {
  const bucket = await fakeBucket(t);
  const a = await computer(t, bucket);
  a.apply({ op: 'task.create', id: 't', content: 'Task' });
  const file = randomBytes(PIECE * 4 + 3);
  await a.attach('t', file);
  const first = await a.upload();
  const firstNamespace = namespaceOf(a);
  // Everything of the todos is lost on this computer; its backup settings stay.
  a.service.close(); await a.service.flush(); a.todos.close();
  for (const name of await readdir(a.stateDir)) if (name.startsWith('todos.sqlite') || name === 'todo-files') await rm(join(a.stateDir, name), { recursive: true, force: true });
  const again = await computer(t, bucket, { stateDir: a.stateDir, clock: a.clock });
  assert.notEqual(namespaceOf(again), firstNamespace, 'a new key, a new namespace');
  await again.restore(first);
  assert.deepEqual(again.todos.overview().restore, { state: 'done', total: 1, missing: 0 });
  assert.deepEqual(await content(again, file), file);
  const second = await again.upload();
  assert.equal(piecesOf(bucket, namespaceOf(again), file).length, 5);
  const elsewhere = await computer(t, bucket, { host: 'laptop' });
  await elsewhere.restore(second);
  assert.deepEqual(elsewhere.todos.overview().restore, { state: 'done', total: 1, missing: 0 });
  assert.deepEqual(await content(elsewhere, file), file);
});

test('attachments the bucket no longer has keep their rows and are counted as missing', async t => {
  const bucket = await fakeBucket(t);
  const a = await computer(t, bucket);
  a.apply({ op: 'task.create', id: 't', content: 'Task' });
  const lost = Buffer.from('removed from the bucket'), found = Buffer.from('still there');
  await a.attach('t', lost); await a.attach('t', found);
  const key = await a.upload();
  for (const name of piecesOf(bucket, namespaceOf(a), lost)) bucket.objects.delete(name);
  const b = await computer(t, bucket);
  await b.restore(key);
  assert.deepEqual(b.todos.overview().restore, { state: 'partial', total: 2, missing: 1 });
  assert.deepEqual(b.todos.detail('t').files.map(file => [file.sha256 === sha(lost), Boolean(file.missing)]), [[true, true], [false, false]]);
});

test('the copy made before a restore has the latest changes still in the write-ahead log; only the newest three are kept', async t => {
  const bucket = await fakeBucket(t);
  const a = await computer(t, bucket);
  const key = await a.upload();
  a.apply({ op: 'task.create', id: 'latest', content: 'Only in the WAL' });
  assert.ok((await stat(join(a.stateDir, 'todos.sqlite-wal'))).size > 0);
  const copies: string[] = [];
  for (let index = 0; index < 4; index++) {
    a.clock.now += 1000;
    copies.push((await a.restore(key)).todoBefore!);
    if (index) continue;
    const copy = new DatabaseSync(copies[0]!, { readOnly: true });
    assert.deepEqual(copy.prepare("SELECT content FROM todo_tasks WHERE id = 'latest'").all().map(row => (row as { content: string }).content), ['Only in the WAL']);
    copy.close();
    assert.equal(a.todos.overview().tasks.length, 0, 'restored to the backup made before it');
  }
  assert.deepEqual((await readdir(a.stateDir)).filter(name => name.startsWith('todo-restore-before-')).sort(), copies.slice(1).map(path => path.slice(path.lastIndexOf('/') + 1)));
});

test('todos of a newer schema, or a file of a newer build here, are not restored while the rest of the backup is', async t => {
  const bucket = await fakeBucket(t);
  const a = await computer(t, bucket);
  a.apply({ op: 'task.create', id: 'theirs', content: 'From the backup' });
  const snapshot = a.backup.snapshot.bind(a.backup);
  a.backup.snapshot = computer => { const value = snapshot(computer)!; return { ...value, part: { ...value.part, schema: TODO_SCHEMA_STEP + 1 } }; };
  const newer = await a.upload();
  a.backup.snapshot = snapshot;
  const b = await computer(t, bucket);
  b.apply({ op: 'task.create', id: 'mine', content: 'Stays' });
  const report = await b.restore(newer);
  assert.ok(report.applied.includes('backup'));
  assert.equal(report.applied.includes('todos'), false);
  assert.match(report.errors.join(' '), /^todos: .*더 새로운 Tower/);
  assert.deepEqual(b.todos.overview().tasks.map(task => task.id), ['mine']);

  // A build older than its file restores nothing into it.
  const plain = await a.upload();
  b.todos.close();
  const db = new DatabaseSync(join(b.stateDir, 'todos.sqlite'));
  db.exec(`PRAGMA user_version = ${TODO_SCHEMA_STEP + 1}`);
  db.close();
  b.todos.start();
  const refused = await b.restore(plain);
  assert.match(refused.errors.join(' '), /^todos: /);
  assert.deepEqual(b.todos.overview().tasks.map(task => task.id), ['mine']);
});
