import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBrotliDecompress, createGunzip, brotliDecompressSync, gunzipSync } from 'node:zlib';
import { acceptedEncoding, compressedEventStream, sendBody, StaticCompression } from '../../../server/http/compression.js';
import { SseClient } from '../../../server/http/sse-client.js';
import { createMonitorServer } from '../../../server/http/server.js';
import type { Session, Snapshot } from '../../../shared/types.js';

function get(url: string, headers: Record<string, string> = {}): Promise<{ response: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    request(url, { headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ response, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

function decode(body: Buffer, encoding: string | undefined): string {
  return (encoding === 'br' ? brotliDecompressSync(body) : encoding === 'gzip' ? gunzipSync(body) : body).toString();
}

test('the accepted encoding prefers brotli, falls back to gzip and honours refusals', () => {
  assert.equal(acceptedEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(acceptedEncoding('gzip, deflate'), 'gzip');
  assert.equal(acceptedEncoding('br;q=0, gzip;q=0.5'), 'gzip');
  assert.equal(acceptedEncoding(['deflate', 'BR']), 'br');
  assert.equal(acceptedEncoding('br;q=0.0, gzip; q=0'), undefined);
  assert.equal(acceptedEncoding('identity, *'), undefined);
  assert.equal(acceptedEncoding(undefined), undefined);
});

test('bodies are compressed only when accepted and large enough, and decode to the same bytes', async t => {
  const large = JSON.stringify({ items: Array.from({ length: 200 }, (_, index) => ({ index, text: 'session title '.repeat(4) })) });
  const server = createServer((req, res) => sendBody(req, res, req.url === '/small' ? '{"ok":true}' : large));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [accept, expected] of [['br, gzip', 'br'], ['gzip', 'gzip'], ['', undefined]] as const) {
    const { response, body } = await get(`${base}/large`, accept ? { 'Accept-Encoding': accept } : {});
    assert.equal(response.headers['content-encoding'], expected);
    assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.equal(decode(body, expected), large);
    if (expected) assert.ok(body.length < large.length / 4);
  }
  const small = await get(`${base}/small`, { 'Accept-Encoding': 'br' });
  assert.equal(small.response.headers['content-encoding'], undefined);
  assert.equal(small.body.toString(), '{"ok":true}');
});

test('build-hashed assets are compressed once and other files every time', async () => {
  const compression = new StaticCompression();
  const content = Buffer.from('export const value = "asset";\n'.repeat(100));
  const first = await compression.body('/assets/index-abc.js', content, 'br');
  const second = await compression.body('/assets/index-abc.js', content, 'br');
  assert.equal(first.encoding, 'br');
  assert.equal(second.body, first.body);
  assert.equal(brotliDecompressSync(first.body).toString(), content.toString());
  const page = await compression.body('/sessions/x', content, 'gzip');
  assert.equal(gunzipSync(page.body).toString(), content.toString());
  assert.notEqual((await compression.body('/sessions/y', content, 'gzip')).body, page.body);
  assert.deepEqual(await compression.body('/assets/index-abc.js', content, undefined), { body: content });
  assert.deepEqual(await compression.body('/assets/tiny.js', Buffer.from('x'), 'br'), { body: Buffer.from('x') });
});

for (const encoding of ['br', 'gzip'] as const) {
  test(`a ${encoding} event stream delivers every frame as soon as it is written`, async t => {
    let stream: SseClient | undefined;
    let closed = 0;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': encoding });
      stream = new SseClient(compressedEventStream(res, encoding), () => { closed += 1; });
      stream.snapshot('event: snapshot\ndata: first\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const response = await new Promise<IncomingMessage>((resolve, reject) => request(`http://127.0.0.1:${(server.address() as { port: number }).port}/`, resolve).on('error', reject).end());
    assert.equal(response.headers['content-encoding'], encoding);
    const decoder = encoding === 'br' ? createBrotliDecompress() : createGunzip();
    response.pipe(decoder);
    let text = '';
    const waiters: Array<() => void> = [];
    decoder.on('data', chunk => { text += chunk.toString(); for (const wake of waiters.splice(0)) wake(); });
    const until = async (expected: string) => { while (!text.includes(expected)) await new Promise<void>(resolve => waiters.push(resolve)); };
    await until('data: first\n\n');
    stream!.update('event: patch\ndata: second\n\n', () => 'unused');
    await until('data: second\n\n');
    stream!.heartbeat();
    await until('event: heartbeat');
    stream!.end();
    await new Promise<void>(resolve => decoder.on('end', resolve));
    assert.equal(text, 'event: snapshot\ndata: first\n\nevent: patch\ndata: second\n\nevent: heartbeat\ndata: 1\n\n');
    assert.equal(closed, 1);
  });
}

test('a compressed event stream reports a blocked socket and keeps only the newest snapshot until it drains', async t => {
  let stream: SseClient | undefined;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' });
    res.flushHeaders();
    stream = new SseClient(compressedEventStream(res, 'gzip'), () => {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const response = await new Promise<IncomingMessage>((resolve, reject) => request(`http://127.0.0.1:${(server.address() as { port: number }).port}/`, resolve).on('error', reject).end());
  response.pause();
  // Incompressible frames fill the paused socket, the compressor behind it and finally the stream.
  const noise = () => randomBytes(1 << 19).toString('base64');
  for (let index = 0; index < 64 && !(stream as unknown as { blocked: boolean }).blocked; index += 1) stream!.snapshot(`data: ${noise()}\n\n`);
  assert.equal((stream as unknown as { blocked: boolean }).blocked, true);
  stream!.update('event: patch\ndata: lost\n\n', () => 'event: snapshot\ndata: newest\n\n');
  const decoder = createGunzip();
  let tail = '';
  decoder.on('data', chunk => { tail = (tail + chunk.toString()).slice(-200); });
  response.pipe(decoder);
  response.resume();
  while (!tail.includes('data: newest')) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(!tail.includes('data: lost'));
  stream!.end();
});

test('the web server compresses the snapshot, its event stream and caches build-hashed assets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-compression-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Tower</title>');
  await writeFile(join(dir, 'assets', 'index-abc.js'), 'console.log("tower");\n'.repeat(200));
  const now = new Date().toISOString();
  const sessions: Session[] = Array.from({ length: 50 }, (_, index) => ({
    id: `codex:${index}`, nativeId: String(index), provider: 'codex', title: `Session ${index}`, cwd: '/tmp/project', project: 'project',
    status: 'completed', statusReason: 'Turn complete', createdAt: now, updatedAt: now, lastMessage: 'Done', messageCount: 2, isSubagent: false, resumable: true,
  }));
  const snapshot: Snapshot = { sessions, runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: now };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: {
    snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = JSON.parse((await get(`${base}/api/bootstrap`)).body.toString()) as { token: string };
  const headers = { 'X-Agent-Monitor-Token': token, 'Accept-Encoding': 'gzip, deflate, br' };

  const snap = await get(`${base}/api/snapshot`, headers);
  assert.equal(snap.response.statusCode, 200);
  assert.equal(snap.response.headers['content-encoding'], 'br');
  assert.equal((JSON.parse(decode(snap.body, 'br')) as Snapshot).sessions.length, 50);
  const plain = await get(`${base}/api/snapshot`, { 'X-Agent-Monitor-Token': token });
  assert.equal(plain.response.headers['content-encoding'], undefined);
  assert.equal((JSON.parse(plain.body.toString()) as Snapshot).sessions.length, 50);

  const asset = await get(`${base}/assets/index-abc.js`, headers);
  assert.equal(asset.response.headers['content-encoding'], 'br');
  assert.equal(asset.response.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.match(decode(asset.body, 'br'), /console\.log\("tower"\)/);
  assert.equal((await get(`${base}/`, headers)).response.headers['cache-control'], 'no-store');

  const events = await new Promise<IncomingMessage>((resolve, reject) => request(`${base}/api/events?patch=1`, { headers }, resolve).on('error', reject).end());
  assert.equal(events.headers['content-encoding'], 'br');
  assert.equal(events.headers['cache-control'], 'no-store, no-transform');
  const decoder = createBrotliDecompress();
  events.pipe(decoder);
  let text = '';
  for await (const chunk of decoder) { text += chunk.toString(); if (text.includes('event: snapshot') && text.endsWith('\n\n')) break; }
  events.destroy();
  const data = text.split('\n').find(line => line.startsWith('data: '))!;
  assert.equal((JSON.parse(data.slice(6)) as Snapshot).sessions.length, 50);
});
