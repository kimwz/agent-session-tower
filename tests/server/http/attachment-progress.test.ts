import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { attachmentUploadRoute, errorStatus, uploadAppendPath, uploadProgressPath } from '../../../server/http/requests.js';
import type { AttachmentUploads } from '../../../server/stores/attachment-uploads.js';

const id = '11111111-1111-4111-8111-111111111111';
test('append is the only raw-body exception while all progress posts share four slots', async () => {
  assert.equal(uploadAppendPath(`/api/attachment-uploads/${id}`), true);
  assert.equal(uploadAppendPath(`/api/attachment-uploads/${id}/complete`), false);
  assert.equal(uploadProgressPath(`/api/attachment-uploads/${id}/complete`), true);
  assert.equal(uploadProgressPath(`/api/nodes/${'a'.repeat(32)}/attachment-uploads/${id}/cancel`), true);
  assert.equal(uploadProgressPath(`/api/attachment-uploads/${id}/complete/other`), false);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered = 0; let allEntered!: () => void;
  const ready = new Promise<void>(resolve => { allEntered = resolve; });
  const uploads = {
    status: async () => { entered++; if (entered === 4) allEntered(); await blocked; return { offset: 0, target: { kind: 'chat' as const, sessionId: 'canonical' } }; },
    complete: async () => ({ id, name: 'empty', mimeType: 'text/plain', size: 0 }),
    cancel: async () => {}, append: async () => ({ offset: 0 }),
  } as unknown as AttachmentUploads;
  let mutations = 0;
  const call = (suffix: string) => {
    const req = Readable.from([Buffer.from('{}')]) as IncomingMessage; req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
    const res = { writeHead() { return this; }, end() {} } as unknown as ServerResponse;
    return attachmentUploadRoute(req, res, new URL(`http://fixture/api/attachment-uploads/${id}${suffix}`), uploads, 'local', async target => target, () => true, () => { mutations++; });
  };
  const first = [call('/complete'), call('/cancel'), call('/complete'), call('/cancel')];
  await ready;
  await assert.rejects(call('/complete'), error => errorStatus(error) === 429);
  release();
  assert.deepEqual(await Promise.all(first), [true, true, true, true]);
  assert.equal(mutations, 0, 'progress consumes concurrent slots, not mutation requests');
  assert.equal(await call('/complete'), true, 'slots are released after completion');
});
