import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { AttachmentStore } from '../../../server/stores/attachments.js';
import { MAX_IMAGE_ATTACHMENT_BYTES } from '../../../shared/attachments.js';

function client(stateDir: string, capabilities: string[]) {
  const manager = new DurableRunManager({ stateDir });
  const calls: unknown[][] = [];
  Object.assign(manager, { snapshot: { capabilities, sessions: [], runs: [], nativeIds: {} }, call: async (...args: unknown[]) => { calls.push(args); return {}; } });
  return { manager, calls };
}

async function* megabytes(count: number) { for (let index = 0; index < count; index++) yield Buffer.alloc(1024 * 1024); }

test('legacy worker chat references retain their supported sizes while unsupported originals never reach RPC', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-legacy-reference-capability-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { manager, calls } = client(stateDir, []);
  const store = new AttachmentStore(stateDir); await store.start();
  const sessionId = 'codex:legacy';
  const small = await store.upload(sessionId, 'small.txt', 'text/plain', (async function* () { yield Buffer.from('original'); })());
  await manager.enqueue(sessionId, '', { attachmentIds: [small.id] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1] && (calls[0][1] as unknown[])[2], { attachmentIds: [small.id] });
  const large = await store.upload(sessionId, 'large.bin', 'application/octet-stream', megabytes(11));
  await assert.rejects(manager.enqueue(sessionId, '', { attachmentIds: [large.id] }), { kind: 'unavailable', disposition: 'not-admitted' });
  const parts = [];
  for (let number = 0; number < 3; number++) parts.push(await store.upload(sessionId, `part-${number}.bin`, 'application/octet-stream', megabytes(8)));
  await assert.rejects(manager.enqueue(sessionId, '', { attachmentIds: parts.map(part => part.id) }), { kind: 'unavailable', disposition: 'not-admitted' });
  await assert.rejects(manager.enqueue(sessionId, '', { attachmentIds: parts.slice(0, 2).map(part => part.id), attachments: [{ name: 'inline.bin', mimeType: 'application/octet-stream', data: Buffer.alloc(5 * 1024 * 1024).toString('base64') }] }), { kind: 'unavailable', disposition: 'not-admitted' });
  const image = Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image); image.write('IHDR', 12);
  const raster = await store.upload(sessionId, 'image.png', 'image/png', (async function* () { yield image; })());
  await assert.rejects(manager.enqueue(sessionId, '', { attachmentIds: [raster.id] }), { kind: 'unavailable', disposition: 'not-admitted' });
  await assert.rejects(manager.enqueue(sessionId, '', { attachmentIds: [small.id] }, { autoPromptId: randomUUID() }), { kind: 'unavailable', disposition: 'not-admitted' });
  await assert.rejects(manager.submitAutoPrompt({ requestId: randomUUID(), provider: 'codex', prompt: '', attachmentIds: [small.id] }), { kind: 'unavailable', disposition: 'not-admitted' });
  assert.equal(calls.length, 1);
});

test('an updated worker receives references without web-side original store access', async () => {
  const { manager, calls } = client(join(tmpdir(), `nonexistent-tower-original-${randomUUID()}`), ['attachmentReferences']);
  const attachmentIds = [randomUUID()];
  await manager.enqueue('codex:original', '', { attachmentIds });
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0][1] as unknown[])[2], { attachmentIds });
});
