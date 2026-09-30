import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3Client, endpointUrl, signV4, unsafeKey } from '../../../server/backup/s3.js';
import { fakeBucket } from '../../helpers/s3.js';

test('requests are signed as AWS Signature Version 4 describes (the S3 GET object example)', () => {
  const headers = signV4({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { Range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', now: new Date('2013-05-24T00:00:00Z') });
  assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('only HTTPS endpoints are used, apart from this computer', () => {
  assert.equal(endpointUrl('https://acct.r2.cloudflarestorage.com').host, 'acct.r2.cloudflarestorage.com');
  assert.equal(endpointUrl('http://127.0.0.1:9000').port, '9000');
  assert.throws(() => endpointUrl('http://example.com'), /https/);
  assert.throws(() => endpointUrl('https://user:pass@example.com'), /주소만/);
});

test('objects are written, listed by prefix, read and removed', async t => {
  const bucket = await fakeBucket(t);
  const client = new S3Client({ endpoint: bucket.endpoint, bucket: 'bucket', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret' });
  await client.put('tower/a & b.towerbackup', Buffer.from('one'));
  await client.put('other/c.towerbackup', Buffer.from('two'));
  assert.deepEqual((await client.list('tower/')).map(item => [item.key, item.size]), [['tower/a & b.towerbackup', 3]]);
  assert.equal((await client.get('tower/a & b.towerbackup', 100)).toString(), 'one');
  await assert.rejects(client.get('tower/a & b.towerbackup', 2), /너무 큽니다/);
  await client.delete('tower/a & b.towerbackup');
  assert.deepEqual(await client.list('tower/'), []);
  const refused = new S3Client({ endpoint: bucket.endpoint, bucket: 'bucket', region: 'auto', accessKeyId: 'OTHER', secretAccessKey: 'secret' });
  await assert.rejects(refused.put('x', Buffer.from('')), /403 AccessDenied: bad key/);
});

test('a query is sent exactly as it was signed, and keys that a URL would rewrite are refused', async t => {
  const bucket = await fakeBucket(t);
  const client = new S3Client({ endpoint: bucket.endpoint, bucket: 'bucket', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret' });
  await client.list('my backups/~x');
  assert.ok(bucket.seen.includes('GET /bucket?list-type=2&prefix=my%20backups%2F~x'), bucket.seen.join(' '));
  assert.equal(unsafeKey('tower/../x'), true);
  assert.equal(unsafeKey('./x'), true);
  assert.equal(unsafeKey('a//b'), true);
  assert.equal(unsafeKey('tower/'), false);
  assert.equal(unsafeKey(''), false);
});

test('listing follows continuation pages, and a download larger than allowed is stopped even without its length', async t => {
  const bucket = await fakeBucket(t, { pageSize: 2 });
  const client = new S3Client({ endpoint: bucket.endpoint, bucket: 'bucket', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret' });
  for (let i = 0; i < 5; i++) bucket.objects.set(`tower/${i}.towerbackup`, { body: Buffer.from('x'), at: '2026-09-30T00:00:00Z' });
  assert.deepEqual((await client.list('tower/')).map(item => item.key), [0, 1, 2, 3, 4].map(i => `tower/${i}.towerbackup`));
  assert.equal(bucket.seen.filter(line => line.includes('list-type')).length, 3);
  const server = createServer((_req, res) => { res.writeHead(200, { 'transfer-encoding': 'chunked' }); for (let i = 0; i < 64; i++) res.write(Buffer.alloc(16 * 1024)); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const chunked = new S3Client({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bucket: 'bucket', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret' });
  await assert.rejects(chunked.get('big.towerbackup', 32 * 1024), /너무 큽니다/);
});
