import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3Client, endpointUrl, listPage, signV4, unsafeKey } from '../../../server/backup/s3.js';
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

test('a listing that is not a whole ListBucketResult is never taken as complete', async t => {
  let body = '';
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new S3Client({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bucket: 'bucket', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret' });
  const whole = '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>tower/a</Key><Size>1</Size></Contents></ListBucketResult>';
  body = whole;
  assert.deepEqual(await client.scan('tower/'), { items: [{ key: 'tower/a', size: 1, modifiedAt: '' }], complete: true });
  // A namespace on the root and a comment after it are well-formed.
  body = '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><IsTruncated>false</IsTruncated><Contents><Key>tower/a</Key><Size>1</Size></Contents></ListBucketResult>\n<!-- served by a proxy -->\n';
  assert.deepEqual(await client.scan('tower/'), { items: [{ key: 'tower/a', size: 1, modifiedAt: '' }], complete: true });
  // An entry written with a space before its end is an entry like any other, never skipped.
  body = '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>tower/a</Key></Contents><Contents ><Key>tower/old</Key></Contents></ListBucketResult>';
  assert.deepEqual((await client.scan('tower/')).items.map(item => item.key), ['tower/a', 'tower/old']);
  assert.equal((await client.scan('tower/')).complete, true);
  for (const broken of [
    '<ListBucketResult><Contents><Key>tower/a</Key></Contents>',
    '<ListBucketResult><Contents><Key>tower/a</Key></Contents></ListBucketResult>',
    '<ListBucketResult><IsTruncated>maybe</IsTruncated></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Size>1</Size></Contents></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>tower/a</Key></ListBucketResult>',
    '<Error><Code>Odd</Code></Error>',
    // An entry the parser would skip: empty, written with a space, or broken off.
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>tower/a</Key></Contents><Contents/></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>tower/a</Key></Contents><Contents</ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key></Key></Contents></ListBucketResult>',
    '<ListBucketResult><Contents><Key>tower/a</Key><IsTruncated>false</IsTruncated></Contents></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
  ]) {
    body = broken;
    assert.equal((await client.scan('tower/')).complete, false, broken);
  }
});

test('only a listing understood whole is complete: other names, CDATA, broken or nested parts are not', () => {
  const page = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/" xmlns:s="urn:x">${inner}</ListBucketResult>`;
  for (const [what, xml] of [
    ['a prefixed entry', page('<IsTruncated>false</IsTruncated><Contents><Key>tower/a</Key></Contents><s:Contents><s:Key>tower/old</s:Key></s:Contents>')],
    ['a prefixed document', '<s:ListBucketResult xmlns:s="http://s3.amazonaws.com/doc/2006-03-01/"><s:IsTruncated>false</s:IsTruncated><s:Contents><s:Key>tower/old</s:Key></s:Contents></s:ListBucketResult>'],
    ['a CDATA key', page('<IsTruncated>false</IsTruncated><Contents><Key><![CDATA[tower/a]]></Key></Contents>')],
    ['an unterminated prefixed entry', page('<IsTruncated>false</IsTruncated><Contents><Key>tower/a</Key></Contents><s:Contents')],
    ['IsTruncated nested in another element', page('<Name><IsTruncated>false</IsTruncated></Name><Contents><Key>tower/a</Key></Contents>')],
    ['two IsTruncated', page('<IsTruncated>false</IsTruncated><IsTruncated>true</IsTruncated>')],
    ['an entry with two keys', page('<IsTruncated>false</IsTruncated><Contents><Key>tower/a</Key><Key>tower/b</Key></Contents>')],
    ['a doctype', `<!DOCTYPE x>${page('<IsTruncated>false</IsTruncated>')}`],
    ['a processing instruction', page('<?pi x?><IsTruncated>false</IsTruncated>')],
    ['a stray <', page('<IsTruncated>false</IsTruncated><Contents><Key>tower/a < b</Key></Contents>')],
    ['an unknown entity', page('<IsTruncated>false</IsTruncated><Contents><Key>tower/&nbsp;</Key></Contents>')],
    ['a mismatched end', page('<IsTruncated>false</IsTruncated><Contents><Key>tower/a</Size></Contents>')],
    ['text after the root', `${page('<IsTruncated>false</IsTruncated>')}trailing`],
    ['another root', `${page('<IsTruncated>false</IsTruncated>')}<ListBucketResult/>`],
  ] as const) assert.equal(listPage(xml).whole, false, what);

  // Well-formed in other ways: a space before an end tag's close, entities, a comment after the root.
  const spaced = listPage(`${page('<IsTruncated>false</IsTruncated><Contents ><Key>tower/a &amp; b</Key ></Contents ><Contents><Key>tower/&#233;</Key><Size>3</Size></Contents>')}\n<!-- proxy -->\n`);
  assert.deepEqual(spaced, { items: [{ key: 'tower/a & b', size: 0, modifiedAt: '' }, { key: 'tower/é', size: 3, modifiedAt: '' }], whole: true, truncated: false });
});

test('the AWS and R2 example listings are complete, across continuation pages', async t => {
  const aws = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>bucket</Name>
    <Prefix>tower/</Prefix>
    <KeyCount>2</KeyCount>
    <MaxKeys>2</MaxKeys>
    <IsTruncated>true</IsTruncated>
    <NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
    <Contents>
        <Key>tower/a.towerbackup</Key>
        <LastModified>2026-09-30T00:00:00.000Z</LastModified>
        <ETag>&quot;fba9dede5f27731c9771645a39863328&quot;</ETag>
        <Size>434234</Size>
        <StorageClass>STANDARD</StorageClass>
        <Owner><ID>75aa57f09aa0c8caeab4f8c24e99d10f8e7faeebf76c078efc7c6caea54ba06a</ID><DisplayName>owner</DisplayName></Owner>
    </Contents>
    <Contents>
        <Key>tower/b.towerbackup</Key>
        <LastModified>2026-09-30T00:00:01.000Z</LastModified>
        <ETag>"599bab3ed2c697f1d26842727561fd94"</ETag>
        <Size>1</Size>
        <StorageClass>STANDARD</StorageClass>
    </Contents>
    <CommonPrefixes><Prefix>tower/x/</Prefix></CommonPrefixes>
</ListBucketResult>`;
  // Cloudflare R2's answer: one line, the same elements in its own order.
  const r2 = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><Contents><Key>tower/c.towerbackup</Key><Size>3</Size><LastModified>2026-09-30T00:00:02.000Z</LastModified><ETag>"abc"</ETag><StorageClass>STANDARD</StorageClass></Contents><IsTruncated>false</IsTruncated><MaxKeys>1000</MaxKeys><KeyCount>1</KeyCount><ContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</ContinuationToken><Prefix>tower/</Prefix></ListBucketResult>';
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(new URL(req.url!, 'http://x').searchParams.has('continuation-token') ? r2 : aws); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new S3Client({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bucket: 'bucket', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret' });
  const listing = await client.scan('tower/');
  assert.equal(listing.complete, true);
  assert.deepEqual(listing.items.map(item => [item.key, item.size, item.modifiedAt]), [
    ['tower/a.towerbackup', 434234, '2026-09-30T00:00:00.000Z'], ['tower/b.towerbackup', 1, '2026-09-30T00:00:01.000Z'], ['tower/c.towerbackup', 3, '2026-09-30T00:00:02.000Z']]);
  assert.deepEqual((await client.list('tower/')).map(item => item.key), ['tower/a.towerbackup', 'tower/b.towerbackup', 'tower/c.towerbackup']);
});

test('names a listing has only in their place: one elsewhere makes the page not whole, and a page not whole is read for showing only', () => {
  const page = (inner: string) => `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>tower/a</Key></Contents>${inner}</ListBucketResult>`;
  for (const [what, xml] of [
    ['an entry inside another element', page('<CommonPrefixes><Contents><Key>tower/old</Key></Contents></CommonPrefixes>')],
    ['a result inside the result', page('<Name><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult></Name>')],
    ['a key below an entry’s child', page('<Contents><Owner><Key>tower/old</Key></Owner><Key>tower/b</Key></Contents>')],
    ['a key outside an entry', page('<Key>tower/old</Key>')],
    ['IsTruncated inside an entry', page('<Contents><Key>tower/b</Key><IsTruncated>true</IsTruncated></Contents>')],
  ] as const) assert.equal(listPage(xml).whole, false, what);
  // Not whole: keys in comments are not entries, a key is listed once, and an out-of-range character stays as written.
  const loose = listPage('<ListBucketResult><Contents><Key>tower/a</Key></Contents><Contents><Key>tower/a</Key></Contents><!-- <Contents><Key>tower/ghost</Key></Contents> --><Contents><Key>tower/b&#1114112;</Key></Contents><Name><![CDATA[x]]></Name></ListBucketResult>');
  assert.equal(loose.whole, false);
  assert.deepEqual(loose.items.map(item => item.key), ['tower/a', 'tower/b&#1114112;']);
});
