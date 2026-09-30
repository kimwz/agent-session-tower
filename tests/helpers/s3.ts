import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A bucket in memory that checks each request is signed by the expected key. */
export async function fakeBucket(t: { after(fn: () => unknown): void }, options: { denyList?: boolean; pageSize?: number } = {}) {
  const objects = new Map<string, { body: Buffer; at: string }>();
  const seen: string[] = [];
  const read = async (req: IncomingMessage) => { const parts: Buffer[] = []; for await (const part of req) parts.push(part as Buffer); return Buffer.concat(parts); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://local');
    seen.push(`${req.method} ${url.pathname}${url.search}`);
    if (!String(req.headers.authorization).startsWith('AWS4-HMAC-SHA256 Credential=AKID/')) { res.writeHead(403); res.end('<Error><Code>AccessDenied</Code><Message>bad key</Message></Error>'); return; }
    if (options.denyList && req.method === 'GET' && url.searchParams.has('list-type')) { res.writeHead(403); res.end('<Error><Code>AccessDenied</Code><Message>list not allowed</Message></Error>'); return; }
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    if (bucket !== 'bucket') { res.writeHead(404); res.end('<Error><Code>NoSuchBucket</Code></Error>'); return; }
    if (req.method === 'PUT') { objects.set(key, { body: await read(req), at: new Date(Date.parse('2026-09-30T00:00:00Z') + objects.size * 1000).toISOString() }); res.writeHead(200); res.end(); return; }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && key) { const item = objects.get(key); if (!item) { res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>'); return; } res.writeHead(200, { 'content-length': item.body.length }); res.end(item.body); return; }
    const prefix = url.searchParams.get('prefix') ?? '';
    const all = [...objects].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : 1);
    const from = Number(url.searchParams.get('continuation-token') ?? 0);
    const list = all.slice(from, from + (options.pageSize ?? all.length));
    const more = from + list.length < all.length;
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + list.length}</NextContinuationToken>` : ''}${list.map(([name, item]) => `<Contents><Key>${name.replace(/&/g, '&amp;')}</Key><Size>${item.body.length}</Size><LastModified>${item.at}</LastModified></Contents>`).join('')}</ListBucketResult>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, objects, seen };
}
