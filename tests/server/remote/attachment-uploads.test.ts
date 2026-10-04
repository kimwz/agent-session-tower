import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore } from '../../../server/stores/attachments.js';
import { AttachmentUploads } from '../../../server/stores/attachment-uploads.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { createRemoteRouter } from '../../../server/remote/router.js';
import { TowerError } from '../../../shared/errors.js';
import type { Session } from '../../../shared/types.js';

test('remote chunks bind canonical sessions and controller ownership and recheck current visibility', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-remote-chunks-')));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const stores = { chat: new AttachmentStore(root), auto: new AttachmentStore(join(root, 'auto-prompt-staging')) };
  await Promise.all([stores.chat.start(), stores.auto.start()]);
  const uploads = new AttachmentUploads(root, stores); await uploads.start();
  const exclusions = new RemoteExclusionStore(root); await exclusions.start();
  const session: Session = { id: 'codex:canonical', nativeId: 'alias', provider: 'codex', title: 'Fixture', cwd, project: 'p', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
  let capable = true;
  const router = createRemoteRouter({ attachmentStores: stores, attachmentUploads: uploads, exclusions, mutationsPerMinute: 8, backend: {
    attachmentReferences: () => capable, coordinators: () => new Set(), session: id => ['codex:canonical', 'codex:alias'].includes(id) ? session : undefined,
    snapshot: () => ({ sessions: [session], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: '' }),
    enqueue: async () => { throw new Error('unused'); }, detail: async () => undefined, subscribe: () => () => {}, cancel: async () => {},
  } });
  const server = createServer((req, res) => { void router.handle(req, res, { controllerId: String(req.headers['x-fixture-controller'] ?? 'controller-a') }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { uploads.close(); router.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const start = async (size: number) => fetch(`${base}/api/sessions/codex:alias/attachment-uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'original.bin', mimeType: 'application/octet-stream', size }) });
  const originalStart = uploads.start.bind(uploads);
  uploads.start = (async () => { throw new TowerError('storage-full', '첨부 파일을 저장할 디스크 여유 공간이 부족합니다.'); }) as typeof uploads.start;
  const full = await start(1); assert.equal(full.status, 507);
  assert.equal((await full.json()).error, '첨부 파일을 저장할 디스크 여유 공간이 부족합니다.');
  uploads.start = originalStart;
  capable = false; assert.equal((await start(1)).status, 503); capable = true;
  const bytes = Buffer.alloc(21 * 1024 * 1024 + 1, 47);
  const started = await start(bytes.length); assert.equal(started.status, 201);
  const { id } = await started.json();
  const url = `${base}/api/attachment-uploads/${id}`;
  assert.equal((await fetch(url, { headers: { 'x-fixture-controller': 'controller-b' } })).status, 404);
  const state = await uploads.status(id, 'controller-a'); assert.equal(state.target.sessionId, session.id);
  for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
    const response = await fetch(`${url}?offset=${offset}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes.subarray(offset, offset + 512 * 1024)) });
    assert.equal(response.status, 200, 'chunks do not consume the metadata mutation budget');
  }
  const complete = () => fetch(`${url}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const publishedId = JSON.parse(await readFile(join(uploads.directory, id, 'manifest.json'), 'utf8')).attachmentId;
  for (const code of ['ENOSPC', 'EDQUOT']) {
    const save = t.mock.method(uploads as unknown as { save(...args: unknown[]): Promise<void> }, 'save', async () => { throw Object.assign(new Error('receipt disk full'), { code }); });
    const refused = await complete(); assert.equal(refused.status, 507);
    assert.equal((await refused.json()).error, '파일을 저장할 디스크 여유 공간이 부족합니다.');
    save.mock.restore();
  }
  const completed = await complete(); assert.equal(completed.status, 200);
  const { attachment } = await completed.json();
  assert.equal(attachment.id, publishedId, 'receipt retries recover the original ID');
  const download = await fetch(`${base}/api/attachments/${attachment.id}`); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const activeDownload = await fetch(`${base}/api/attachments/${attachment.id}`);
  const reader = activeDownload.body!.getReader(); assert.equal((await reader.read()).done, false);
  await exclusions.add(cwd);
  await assert.rejects(async () => { while (!(await reader.read()).done) {} }, /terminated|aborted|closed/i);
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await complete()).status, 404);
  assert.equal((await fetch(`${base}/api/attachments/${attachment.id}`)).status, 404);
});
