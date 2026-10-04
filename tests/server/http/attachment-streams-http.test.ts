import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMonitorServer } from '../../../server/http/server.js';
import { AttachmentUploads } from '../../../server/stores/attachment-uploads.js';
import { AttachmentStore } from '../../../server/stores/attachments.js';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import type { Session, Run, AutoPromptInput } from '../../../shared/types.js';

const session: Session = { id: 'codex:fixture', nativeId: 'fixture', provider: 'codex', title: 'Fixture', cwd: '/tmp/fixture', project: 'fixture', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
test('original binary uploads send references, stream downloads, and preserve auth and other body limits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-upload-http-'));
  const attachments = new AttachmentStore(root); await attachments.start();
  const staging = new AttachmentStore(join(root, 'auto-prompt-staging')); await staging.start();
  const uploads = new AttachmentUploads(root, { chat: attachments, auto: staging }); await uploads.start();
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(root);
  const runs: Run[] = [];
  let autoInput: AutoPromptInput | undefined;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: root, auth, remote: { origins }, attachmentStores: { chat: attachments, auto: staging }, attachmentUploads: uploads, backend: {
    attachmentReferences: () => true,
    snapshot: () => ({ sessions: [session], runs, providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: '' }),
    detail: async () => undefined, subscribe: () => () => {}, cancel: async () => {},
    enqueue: async (id, prompt, input) => {
      assert.equal(input?.attachments, undefined);
      const saved = await attachments.prepare(id, input);
      const run: Run = { id: 'run', sessionId: id, status: 'queued', prompt, output: '', createdAt: '', attachments: saved.attachments }; runs.push(run); return run;
    },
    startAutoPrompt: async input => {
      autoInput = input;
      const saved = await staging.prepare(input.requestId, { attachmentIds: input.attachmentIds });
      assert.equal(saved.attachments[0].size, 11 * 1024 * 1024);
      return { id: input.requestId, provider: 'codex', prompt: input.prompt, routerModel: '', status: 'queued', createdAt: '', updatedAt: '' };
    },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { uploads.close(); dispose(); auth.close(); await auth.flush(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, 'Content-Type': 'application/octet-stream', 'X-Agent-Monitor-Token': token };
  const endpoint = `${base}/api/sessions/${session.id}/attachment-uploads`;
  const body = Buffer.alloc(21 * 1024 * 1024 + 17, 171);
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  const metadata = JSON.stringify({ name: 'large.bin', mimeType: 'application/octet-stream', size: body.length });
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...jsonHeaders, cookie: '' }, body: metadata })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...jsonHeaders, 'X-Agent-Monitor-Token': '' }, body: metadata })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...jsonHeaders, Origin: 'https://bad.example' }, body: metadata })).status, 403);
  async function upload(path: string, bytes: Buffer, name: string, mimeType: string) {
    const response = await fetch(path, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name, mimeType, size: bytes.length }) });
    assert.equal(response.status, 201);
    const { id } = await response.json();
    const chunkUrl = `${base}/api/attachment-uploads/${id}`;
    assert.equal((await fetch(`${chunkUrl}?offset=1`, { method: 'POST', headers, body: Buffer.from('bad') })).status, 409);
    let offset = (await (await fetch(chunkUrl, { headers: { cookie } })).json()).offset;
    while (offset < bytes.length) {
      const response = await fetch(`${chunkUrl}?offset=${offset}`, { method: 'POST', headers, body: new Uint8Array(bytes.subarray(offset, offset + 4 * 1024 * 1024)) });
      assert.equal(response.status, 200);
      offset = (await response.json()).offset;
    }
    const complete = await fetch(`${chunkUrl}/complete`, { method: 'POST', headers: jsonHeaders, body: '{}' });
    assert.equal(complete.status, 200);
    const saved = (await complete.json()).attachment;
    const retried = await fetch(`${chunkUrl}/complete`, { method: 'POST', headers: jsonHeaders, body: '{}' });
    assert.deepEqual((await retried.json()).attachment, saved);
    return saved;
  }
  const saved = await upload(endpoint, body, 'large.bin', 'application/octet-stream');
  assert.equal(saved.size, body.length);
  const accepted = await fetch(`${base}/api/sessions/${session.id}/messages`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ prompt: '', attachmentIds: [saved.id] }) });
  assert.equal(accepted.status, 202);
  assert.deepEqual((await accepted.json()).run.attachments, [saved]);
  const fileUrl = `${base}/api/attachments/${saved.id}`;
  assert.equal((await fetch(fileUrl)).status, 401);
  const download = await fetch(fileUrl, { headers: { cookie } });
  assert.equal(download.headers.get('content-length'), String(body.length));
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), body);
  const head = await fetch(fileUrl, { method: 'HEAD', headers: { cookie } });
  assert.equal(head.headers.get('content-length'), String(body.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(`${base}/api/sessions/no-session/attachment-uploads`, { method: 'POST', headers: jsonHeaders, body: metadata })).status, 404);
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ prompt: 'x'.repeat(140_000) }) })).status, 413);
  const requestId = crypto.randomUUID();
  const autoFile = await upload(`${base}/api/auto-prompts/${requestId}/attachment-uploads`, Buffer.alloc(11 * 1024 * 1024, 65), 'large.txt', 'text/plain');
  const job = await fetch(`${base}/api/auto-prompts`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ requestId, provider: 'codex', prompt: '', attachmentIds: [autoFile.id] }) });
  assert.equal(job.status, 202);
  assert.deepEqual(autoInput?.attachmentIds, [autoFile.id]);
  assert.equal(autoInput?.attachments, undefined);
  const longDownload = await fetch(fileUrl, { headers: { cookie } });
  const reader = longDownload.body!.getReader();
  assert.equal((await reader.read()).done, false);
  auth.logout(cookie.split('=')[1]);
  await assert.rejects(async () => { while (!(await reader.read()).done) {} }, /terminated|aborted|closed/i);

});
