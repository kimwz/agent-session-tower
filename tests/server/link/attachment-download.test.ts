import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import http2 from 'node:http2';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { proxyToNode } from '../../../server/link/proxy.js';

test('joined original downloads exceed 64 MiB while ordinary responses keep their cap', async t => {
  const chunk = Buffer.alloc(64 * 1024, 71);
  const count = 1041; // 65 MiB + one chunk; generate and consume it without a whole-file buffer.
  const expected = createHash('sha256');
  for (let i = 0; i < count; i++) expected.update(chunk);
  const digest = expected.digest('hex');
  const node = http2.createServer();
  node.on('stream', stream => {
    stream.respond({ ':status': 200, 'content-type': 'application/octet-stream', 'content-length': chunk.length * count });
    void pipeline(Readable.from((async function* () { for (let i = 0; i < count; i++) yield chunk; })()), stream).catch(() => {});
  });
  await new Promise<void>(resolve => node.listen(0, '127.0.0.1', resolve));
  const session = http2.connect(`http://127.0.0.1:${(node.address() as { port: number }).port}`);
  const web = createServer((req, res) => { void proxyToNode(req, res, session, req.url!); });
  await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    session.destroy(); web.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => web.close(() => resolve())), new Promise<void>(resolve => node.close(() => resolve()))]);
  });
  const base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
  const download = await fetch(`${base}/api/attachments/11111111-1111-4111-8111-111111111111`);
  assert.equal(download.status, 200);
  let size = 0; const actual = createHash('sha256');
  const reader = download.body!.getReader();
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; actual.update(next.value); }
  assert.equal(size, chunk.length * count);
  assert.equal(actual.digest('hex'), digest);
  const ordinary = await fetch(`${base}/api/other`);
  const bounded = ordinary.body!.getReader();
  await assert.rejects(async () => { while (!(await bounded.read()).done) {} }, /terminated|aborted|closed/i);
});
