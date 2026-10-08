import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import http2 from 'node:http2';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { proxyToNode } from '../../../server/link/proxy.js';

/** A joined computer that answers every request with `answer`, and the web side that passes requests to it. */
async function link(t: test.TestContext, answer: (headers: http2.IncomingHttpHeaders, stream: http2.ServerHttp2Stream) => void) {
  const node = http2.createServer();
  node.on('stream', (stream, headers) => answer(headers, stream));
  await new Promise<void>(resolve => node.listen(0, '127.0.0.1', resolve));
  const session = http2.connect(`http://127.0.0.1:${(node.address() as { port: number }).port}`);
  const web = createServer((req, res) => { void proxyToNode(req, res, session, req.url!); });
  await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    session.destroy(); web.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => web.close(() => resolve())), new Promise<void>(resolve => node.close(() => resolve()))]);
  });
  return `http://127.0.0.1:${(web.address() as { port: number }).port}`;
}

test('a joined computer’s media is played inline by byte range, and only from the media route', async t => {
  const seen: Array<string | undefined> = [];
  const base = await link(t, (headers, stream) => {
    seen.push(headers.range as string | undefined);
    stream.respond({ ':status': 206, 'content-type': 'video/mp4', 'content-length': 4, 'content-range': 'bytes 2-5/10', 'accept-ranges': 'bytes', 'content-disposition': 'inline' });
    stream.end('2345');
  });
  const played = await fetch(`${base}/api/workspace/media?cwd=%2Fw&path=clip.mp4`, { headers: { range: 'bytes=2-5', cookie: 'kept=here' } });
  assert.equal(played.status, 206);
  assert.equal(played.headers.get('content-type'), 'video/mp4');
  assert.equal(played.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(played.headers.get('accept-ranges'), 'bytes');
  assert.equal(played.headers.get('content-length'), '4');
  assert.equal(played.headers.get('content-disposition'), 'inline');
  assert.equal(played.headers.get('x-content-type-options'), 'nosniff');
  assert.match(played.headers.get('content-security-policy') ?? '', /^sandbox;/);
  assert.equal(await played.text(), '2345');
  assert.deepEqual(seen, ['bytes=2-5'], 'the range reaches the other computer');

  const elsewhere = await fetch(`${base}/api/attachments/11111111-1111-4111-8111-111111111111`);
  assert.equal(elsewhere.status, 502, 'video is not an answer type of any other route');
  await elsewhere.body?.cancel();
});

test('an answer the media route cannot play keeps today’s rules: a page is refused, a file is downloaded', async t => {
  let type = 'text/html';
  const base = await link(t, (_headers, stream) => { stream.respond({ ':status': 200, 'content-type': type }); stream.end('<script>1</script>'); });
  const page = await fetch(`${base}/api/workspace/media?cwd=%2Fw&path=clip.mp4`);
  assert.equal(page.status, 502);
  await page.body?.cancel();
  type = 'application/octet-stream';
  const file = await fetch(`${base}/api/workspace/media?cwd=%2Fw&path=clip.mp4`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition') ?? '', /^attachment;/);
  await file.body?.cancel();
});

test('a refusal from the other computer keeps its range header so a player knows the length', async t => {
  const base = await link(t, (_headers, stream) => {
    stream.respond({ ':status': 416, 'content-type': 'application/json; charset=utf-8', 'content-range': 'bytes */10' });
    stream.end(JSON.stringify({ error: 'Requested range is outside the file.' }));
  });
  const refused = await fetch(`${base}/api/workspace/media?cwd=%2Fw&path=clip.mp4`, { headers: { range: 'bytes=10-' } });
  assert.equal(refused.status, 416);
  assert.equal(refused.headers.get('content-range'), 'bytes */10');
  assert.deepEqual(await refused.json(), { error: 'Requested range is outside the file.' });
});

test('joined media plays past the 64 MiB answer cap', async t => {
  const chunk = Buffer.alloc(64 * 1024, 7);
  const count = 1041; // 65 MiB and one chunk, generated and read without holding it whole.
  const base = await link(t, (_headers, stream) => {
    stream.respond({ ':status': 200, 'content-type': 'audio/mpeg', 'content-length': chunk.length * count });
    void pipeline(Readable.from((async function* () { for (let i = 0; i < count; i++) yield chunk; })()), stream).catch(() => {});
  });
  const played = await fetch(`${base}/api/workspace/media?cwd=%2Fw&path=long.mp3`);
  assert.equal(played.status, 200);
  let size = 0;
  const reader = played.body!.getReader();
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; }
  assert.equal(size, chunk.length * count);
});

test('the remote message proxy preserves only the authority-reducing corrective marker without local capability credentials', async t => {
  let seen: http2.IncomingHttpHeaders | undefined;
  const base = await link(t, (headers, stream) => { seen = headers; stream.respond({ ':status': 200, 'content-type': 'application/json' }); stream.end('{}'); });
  await fetch(`${base}/api/sessions/codex:worker/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-heartbeat-corrective': '1', 'x-tower-run-capability': 'a'.repeat(64) }, body: JSON.stringify({ prompt: 'Continue' }) });
  assert.equal(seen!['x-tower-heartbeat-corrective'], '1'); assert.equal(seen!['x-tower-run-capability'], undefined);
});
