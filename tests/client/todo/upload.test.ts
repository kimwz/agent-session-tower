import test from 'node:test';
import assert from 'node:assert/strict';
import { UPLOAD_CHUNK_BYTES } from '../../../shared/attachments.js';
import { TODO_FILE_MAX_BYTES, type TodoChanges, type TodoFile } from '../../../shared/todo/types.js';
import { fileProblem, isPreviewable, MIN_CHUNK_BYTES, newJob, nextChunk, nextChunkBytes, runUpload, sizeLabel, type AppendResult, type UploadIO, type UploadJob } from '../../../client/src/todo/attachments/upload.js';
import { visibleFiles } from '../../../client/src/todo/todo-model.js';
import { TodoUploads } from '../../../client/src/todo/attachments/uploads.js';
import { AttachmentList, UploadRows } from '../../../client/src/todo/attachments/Attachments.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const settle = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const file = (id: string, patch: Partial<TodoFile> = {}): TodoFile => ({ id, taskId: 't', commentId: null, name: `${id}.txt`, mimeType: 'text/plain', size: 3, sha256: 'x'.repeat(64), createdAt: 'x', deletedAt: null, ...patch });
const changes = (files: TodoFile[]): TodoChanges => ({ revision: 2, projects: [], sections: [], labels: [], tasks: [], links: [], removedLinks: [], comments: [], files });

/** A server that keeps the bytes it was sent, and can lose an answer or move ahead on its own. */
class FakeServer implements UploadIO {
  stored = 0;
  calls: string[] = [];
  size = 0;
  failAppendAt?: number;
  loseAnswerAt?: number;
  async start(input: { size: number }) { this.size = input.size; this.calls.push('start'); return { id: 'u1', offset: 0 }; }
  async offset() { this.calls.push(`offset:${this.stored}`); return this.stored; }
  async append(_id: string, offset: number, piece: Blob): Promise<AppendResult> {
    this.calls.push(`append:${offset}`);
    if (offset !== this.stored) return { conflict: this.stored };
    if (this.failAppendAt === offset) { this.failAppendAt = undefined; throw new TypeError('network'); }
    this.stored += piece.size;
    if (this.loseAnswerAt === offset) { this.loseAnswerAt = undefined; throw new TypeError('answer lost'); }
    return { offset: this.stored };
  }
  async complete() {
    this.calls.push('complete');
    if (this.stored < this.size) return { conflict: this.stored };
    return { file: file('f1', { size: this.size }), changes: changes([file('f1', { size: this.size })]) };
  }
  async cancel() { this.calls.push('cancel'); }
}

const blob = (size: number) => new Blob([new Uint8Array(size)]);
const job = (size: number, chunk = 4) => ({ ...newJob('k', blob(size), { taskId: 't' }), chunkBytes: chunk });

test('pieces cover the file and shrink when slow or failing, never past the server limit', () => {
  assert.deepEqual(nextChunk(0, 10, 4), { start: 0, end: 4 });
  assert.deepEqual(nextChunk(8, 10, 4), { start: 8, end: 10 });
  assert.equal(nextChunk(10, 10, 4), null);
  assert.equal(nextChunkBytes(UPLOAD_CHUNK_BYTES, 'failed'), UPLOAD_CHUNK_BYTES / 2);
  assert.equal(nextChunkBytes(UPLOAD_CHUNK_BYTES, 40_000), UPLOAD_CHUNK_BYTES / 2);
  assert.equal(nextChunkBytes(MIN_CHUNK_BYTES, 'failed'), MIN_CHUNK_BYTES);
  assert.equal(nextChunkBytes(UPLOAD_CHUNK_BYTES * 2, 100), UPLOAD_CHUNK_BYTES);
  assert.equal(fileProblem(TODO_FILE_MAX_BYTES), undefined);
  assert.equal(fileProblem(TODO_FILE_MAX_BYTES + 1), 'too-large');
});

test('an upload sends every piece and completes, reporting its progress', async () => {
  const server = new FakeServer();
  const reports: UploadJob[] = [];
  const result = await runUpload(job(10), server, new AbortController().signal, update => reports.push(update));
  assert.equal(result.file.id, 'f1');
  assert.deepEqual(server.calls, ['start', 'append:0', 'append:4', 'append:8', 'complete']);
  assert.deepEqual(reports.map(report => [report.offset, report.status]), [[0, 'uploading'], [0, 'uploading'], [4, 'uploading'], [8, 'uploading'], [10, 'uploading'], [10, 'finishing'], [10, 'done']]);
});

test('a lost answer is retried from where the server says it is, not from the start', async () => {
  const server = new FakeServer();
  server.loseAnswerAt = 4;
  let last!: UploadJob;
  await assert.rejects(runUpload(job(10), server, new AbortController().signal, update => { last = update; }), /answer lost/);
  assert.equal(last.uploadId, 'u1');
  assert.equal(last.offset, 4, 'the page saw only the first piece');
  // The retry asks where the server is (8: it kept the second piece), then goes on.
  server.calls = [];
  await runUpload(last, server, new AbortController().signal, () => undefined);
  assert.deepEqual(server.calls, ['offset:8', 'append:8', 'complete']);
});

test('a piece sent at the wrong place goes on from the place the server answers (409)', async () => {
  const server = new FakeServer();
  server.size = 10;
  server.stored = 8;
  server.calls = [];
  await runUpload({ ...job(10), uploadId: 'u1', offset: 0 }, { ...server, offset: async () => 4, append: server.append.bind(server), complete: server.complete.bind(server), start: server.start.bind(server), cancel: server.cancel.bind(server) },
    new AbortController().signal, () => undefined);
  assert.deepEqual(server.calls, ['append:4', 'append:8', 'complete']);
});

test('a failed piece is tried smaller, and an answer outside the file stops the upload', async () => {
  const server = new FakeServer();
  server.failAppendAt = 0;
  let last!: UploadJob;
  await assert.rejects(runUpload(job(10, MIN_CHUNK_BYTES * 2), server, new AbortController().signal, update => { last = update; }));
  assert.equal(last.chunkBytes, MIN_CHUNK_BYTES);
  const broken: UploadIO = { ...server, start: async () => ({ id: 'u2', offset: 0 }), append: async () => ({ offset: 99 }), complete: server.complete.bind(server), offset: server.offset.bind(server), cancel: server.cancel.bind(server) };
  await assert.rejects(runUpload(job(10), broken, new AbortController().signal, () => undefined), /업로드 위치/);
});

test('the uploads run two at a time, refuse too large files, hand finished ones to the store, and cancel on the server', async () => {
  const received: TodoChanges[] = [];
  const toasts: string[] = [];
  const gates: (() => void)[] = [];
  let started = 0;
  const io: UploadIO = {
    start: async () => { started++; return { id: `u${started}`, offset: 0 }; },
    offset: async () => 0,
    append: async (_id, offset, piece) => { await new Promise<void>(resolve => gates.push(resolve)); return { offset: offset + piece.size }; },
    complete: async id => ({ file: file(id), changes: changes([file(id)]) }),
    cancel: async id => { toasts.push(`cancel:${id}`); },
  };
  const uploads = new TodoUploads(io, { receive: value => { received.push(value); }, toast: text => { toasts.push(text); return 0; }, apply: () => true });
  const big = Object.assign(new Blob([]), { name: 'huge.bin' });
  Object.defineProperty(big, 'size', { value: TODO_FILE_MAX_BYTES + 1 });
  uploads.add([Object.assign(blob(3), { name: 'a.txt' }), Object.assign(blob(3), { name: 'b.txt' }), Object.assign(blob(3), { name: 'c.txt' }), big], { taskId: 't' });
  await settle();
  assert.equal(uploads.getJobs().length, 3);
  assert.match(toasts[0], /huge\.bin/);
  assert.equal(started, 2, 'two at a time');
  uploads.cancel(uploads.getJobs()[1].key);
  await settle();
  assert.deepEqual(toasts.slice(1), ['cancel:u2']);
  // Everything sent so far gets its answer, the cancelled upload's too: its late answer is ignored.
  for (let round = 0; round < 3; round++) { while (gates.length) gates.shift()!(); await settle(); }
  assert.deepEqual(received.map(item => item.files[0].id), ['u1', 'u3']);
  assert.equal(uploads.getJobs().length, 0);
  uploads.dispose();
});

test('files show while they and their comment are there; images are previewed; sizes read short', () => {
  const files = [file('a'), file('b', { deletedAt: 'x' }), file('c', { commentId: 'gone' }), file('d', { commentId: 'live' })];
  assert.deepEqual(visibleFiles(files, new Set(['live'])).map(item => item.id), ['a', 'd']);
  assert.equal(isPreviewable({ mimeType: 'image/png' }), true);
  assert.equal(isPreviewable({ mimeType: 'image/svg+xml' }), false);
  assert.equal(isPreviewable({ mimeType: 'image/png', missing: true }), false);
  assert.deepEqual([sizeLabel(512), sizeLabel(2048), sizeLabel(5 * 1024 * 1024), sizeLabel(42 * 1024 * 1024)], ['512 B', '2.0 KB', '5.0 MB', '42 MB']);
});

test('attachments: thumbnails for images, rows with size or the missing note for the rest', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentList, { files: [file('img', { mimeType: 'image/png', name: 'photo.png' }), file('doc', { name: 'report.pdf', mimeType: 'application/pdf', size: 2048 }), file('gone', { missing: true, name: 'lost.zip' })], onDelete() {} }));
  assert.match(markup, /<img src="\/api\/todos\/files\/img\?inline=1" alt="photo.png"/);
  assert.match(markup, /href="\/api\/todos\/files\/doc" download="report.pdf"/);
  assert.match(markup, /2\.0 KB/);
  assert.match(markup, /lost\.zip<\/span><span class="todo-file-size">백업에서 찾을 수 없음/);
  assert.doesNotMatch(markup, /files\/gone/);
});

test('an upload shows its progress, and a failed one its reason with retry and cancel', () => {
  const base = newJob('k', Object.assign(blob(200), { name: 'video.mp4' }), { taskId: 't' });
  const markup = renderToStaticMarkup(createElement(UploadRows, { jobs: [{ ...base, offset: 50 }, { ...base, key: 'f', status: 'failed', error: '연결이 끊겼습니다' }], onCancel() {}, onRetry() {} }));
  assert.match(markup, />25%</);
  assert.match(markup, /<progress max="100" value="25"/);
  assert.match(markup, /aria-label="“video.mp4” 다시 올리기"/);
  assert.equal((markup.match(/올리기 취소/g) ?? []).length, 2);
  assert.match(markup, /role="alert">연결이 끊겼습니다/);
});

test('after the page goes, no queued file starts and no late answer is kept', async () => {
  const received: TodoChanges[] = [];
  let started = 0;
  const gates: (() => void)[] = [];
  const io: UploadIO = {
    start: async () => { started++; return { id: `u${started}`, offset: 0 }; },
    offset: async () => 0,
    append: async (_id, offset, piece) => { await new Promise<void>(resolve => gates.push(resolve)); return { offset: offset + piece.size }; },
    complete: async id => ({ file: file(id), changes: changes([file(id)]) }),
    cancel: async () => undefined,
  };
  const uploads = new TodoUploads(io, { receive: value => { received.push(value); }, toast: () => 0, apply: () => true });
  uploads.add(['a', 'b', 'c'].map(name => Object.assign(blob(3), { name })), { taskId: 't' });
  await settle();
  assert.equal(started, 2);
  uploads.dispose();
  for (let round = 0; round < 3; round++) { while (gates.length) gates.shift()!(); await settle(); }
  assert.equal(started, 2, 'the third file never starts');
  assert.deepEqual(received, []);
  assert.deepEqual(uploads.getJobs(), []);
  uploads.add([Object.assign(blob(3), { name: 'd' })], { taskId: 't' });
  await settle();
  assert.equal(started, 2);
});

test('while the server makes the attachment, the upload cannot be cancelled', async () => {
  let finish!: () => void;
  const cancels: string[] = [];
  const received: TodoChanges[] = [];
  const io: UploadIO = {
    start: async () => ({ id: 'u1', offset: 0 }),
    offset: async () => 0,
    append: async (_id, offset, piece) => ({ offset: offset + piece.size }),
    complete: async id => { await new Promise<void>(resolve => { finish = resolve; }); return { file: file(id), changes: changes([file(id)]) }; },
    cancel: async id => { cancels.push(id); },
  };
  const uploads = new TodoUploads(io, { receive: value => { received.push(value); }, toast: () => 0, apply: () => true });
  uploads.add([Object.assign(blob(3), { name: 'a' })], { taskId: 't' });
  await settle();
  assert.equal(uploads.getJobs()[0].status, 'finishing');
  uploads.cancel(uploads.getJobs()[0].key);
  assert.equal(uploads.getJobs().length, 1);
  finish();
  await settle();
  assert.deepEqual(cancels, []);
  assert.equal(received.length, 1, 'the attachment made is shown, not left unseen on the server');
  uploads.dispose();
});

test('a cancel after a completion whose answer was lost deletes the file the server may have made', async () => {
  const calls: string[] = [];
  const applied: unknown[] = [];
  let lose = true;
  const io: UploadIO = {
    start: async () => ({ id: 'u1', offset: 0 }),
    offset: async () => 3,
    append: async (_id, offset, piece) => ({ offset: offset + piece.size }),
    complete: async id => { calls.push('complete'); if (lose) { lose = false; throw new TypeError('answer lost'); } return { file: file('f1'), changes: changes([file('f1')]) }; },
    cancel: async id => { calls.push(`cancel:${id}`); },
  };
  const uploads = new TodoUploads(io, { receive: () => undefined, toast: () => 0, apply: ops => { applied.push(...ops); return true; } });
  uploads.add([Object.assign(blob(3), { name: 'a' })], { taskId: 't' });
  await settle();
  assert.equal(uploads.getJobs()[0].status, 'failed');
  uploads.cancel(uploads.getJobs()[0].key);
  await settle();
  assert.deepEqual(calls, ['complete', 'complete']);
  assert.deepEqual(applied, [{ op: 'file.delete', id: 'f1' }]);
  assert.deepEqual(uploads.getJobs(), []);
});
