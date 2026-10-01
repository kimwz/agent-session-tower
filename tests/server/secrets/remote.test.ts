import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';
import { connect, createServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { SecretRelay } from '../../../server/secrets/relay.js';
import type { SecretContext, SecretDevice, SecretPeer } from '../../../shared/secrets.js';
import { RemoteSecretBroker, type RemoteSecretBrokerOptions, type RemoteSecretKeys, type RemoteSecretRequest } from '../../../server/secrets/remote.js';

function identity(): { device: SecretDevice; keys: () => RemoteSecretKeys } {
  const signing = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519');
  const keys = { signingPrivateKey: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), encryptionPrivateKey: encryption.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  // Fixture keys are stored sealed, independently of public link identity, just as the Vault owns them.
  const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(keys)), cipher.final()]), tag = cipher.getAuthTag();
  return { device: { id: randomUUID(), name: 'fixture', signingKey: signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(), encryptionKey: encryption.publicKey.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: randomUUID() },
    keys: () => { const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag); return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString()); } };
}
function fixtures(extra: Partial<RemoteSecretBrokerOptions> = {}) {
  const a = identity(), b = identity();
  let calls = 0;
  const claims = new Map<string, string>(), finished: unknown[] = [];
  const aPeers: SecretPeer[] = [{ device: b.device, direction: 'node', routeId: 'node-b', enabled: true }];
  const bPeers: SecretPeer[] = [{ device: a.device, direction: 'controller', routeId: 'controller-a', enabled: true }];
  const aOptions: RemoteSecretBrokerOptions = { device: () => a.device, deviceKeys: a.keys, peers: () => aPeers,
    begin: (_ctx, id, digest) => { if (claims.has(id)) return false; claims.set(id, digest); return true; },
    finish: (_ctx, _id, _digest, result) => { finished.push(result); },
    handle: () => { calls++; return { bytes: Buffer.from('synthetic-secret-canary'), fields: { TOKEN: 'synthetic-secret-canary' } }; }, ...extra };
  const source = new RemoteSecretBroker(aOptions), target = new RemoteSecretBroker({ device: () => b.device, deviceKeys: b.keys, peers: () => bPeers,
    begin: () => true, handle: () => undefined, timeoutMs: 1000 });
  const ctx: SecretContext = { hostId: b.device.id, sessionId: 'session-b', taskId: randomUUID(), runId: 'run-b', root: '/fixture/project', projectId: 'project' };
  return { a, b, aOptions, source, target, ctx, aPeers, bPeers, claims, finished, calls: () => calls };
}
function canonical(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return JSON.stringify(value);
}
function resign(request: RemoteSecretRequest, privateKey: string): RemoteSecretRequest {
  const { signature: _signature, ...body } = request;
  return { ...body, signature: sign(null, Buffer.from(canonical(body)), privateKey).toString('base64url') };
}

test('signed request and sealed signed response deliver Buffer exactly once without plaintext relay or ledger', async () => {
  const f = fixtures();
  try {
    const pending = f.target.request(f.a.device.id, f.ctx, 'resolve', { ref: 'secret:token', operation: 'pipe', fields: ['TOKEN'] });
    const [request] = f.target.poll('controller-a'); assert.ok(request);
    assert.equal(f.target.poll('wrong-route').length, 0);
    const response = await f.source.answer('node-b', request);
    assert.equal(JSON.stringify(response).includes('synthetic-secret-canary'), false);
    assert.equal(JSON.stringify(f.finished).includes('synthetic-secret-canary'), false);
    assert.throws(() => f.target.deliver('wrong-controller', response));
    f.target.deliver('controller-a', response);
    assert.deepEqual(await pending, { bytes: Buffer.from('synthetic-secret-canary'), fields: { TOKEN: 'synthetic-secret-canary' } });
    assert.throws(() => f.target.deliver('controller-a', response));
    await assert.rejects(f.source.answer('node-b', request)); assert.equal(f.calls(), 1);
    assert.equal(f.target.pending(), 0); assert.equal(f.source.inFlight(), 0);
  } finally { f.target.close(); f.source.close(); }
});

test('public link identity clone cannot forge requests, decode responses or substitute a wrong peer', async () => {
  const f = fixtures(), clone = identity();
  try {
    const pending = f.target.request(f.a.device.id, f.ctx, 'list');
    const [request] = f.target.poll('controller-a'); assert.ok(request);
    await assert.rejects(f.source.answer('node-b', resign(request, clone.keys().signingPrivateKey)));
    await assert.rejects(f.source.answer('wrong-node', request));
    const response = await f.source.answer('node-b', request);
    const forged = { ...response, from: clone.device.id }; assert.throws(() => f.target.deliver('controller-a', forged));
    const changed = { ...response, ciphertext: response.ciphertext.slice(0, -1) + (response.ciphertext.endsWith('A') ? 'B' : 'A') };
    assert.throws(() => f.target.deliver('controller-a', changed));
    f.target.deliver('controller-a', response); await pending;
  } finally { f.target.close(); }
});

test('signed context and task binding cannot be altered and source domain remains authoritative', async () => {
  let seen: SecretContext | undefined;
  const f = fixtures({ handle: (ctx, request) => { seen = ctx; const payload = request.payload as { fields: string[] }; assert.deepEqual(payload.fields, ['TOKEN']); throw new Error('private source policy reason'); } });
  try {
    const pending = f.target.request(f.a.device.id, f.ctx, 'resolve', { fields: ['TOKEN'] });
    const [request] = f.target.poll('controller-a'); assert.ok(request);
    await assert.rejects(f.source.answer('node-b', { ...request, context: { ...request.context, taskId: randomUUID() } }));
    await assert.rejects(f.source.answer('node-b', resign({ ...request, context: { ...request.context, hostId: f.a.device.id } }, f.b.keys().signingPrivateKey)));
    const response = await f.source.answer('node-b', request); assert.deepEqual(seen, f.ctx);
    assert.equal(JSON.stringify(response).includes('private source policy reason'), false);
    const rejected = assert.rejects(pending, /SECRET_REMOTE_UNAVAILABLE/); f.target.deliver('controller-a', response); await rejected;
  } finally { f.target.close(); }
});

test('durable claims reject replay after broker restart and same-id changed content', async () => {
  const f = fixtures();
  try {
    const pending = f.target.request(f.a.device.id, f.ctx, 'list');
    const [request] = f.target.poll('controller-a'); assert.ok(request);
    const response = await f.source.answer('node-b', request);
    const restarted = new RemoteSecretBroker(f.aOptions);
    await assert.rejects(restarted.answer('node-b', request));
    await assert.rejects(restarted.answer('node-b', resign({ ...request, payload: { altered: true } }, f.b.keys().signingPrivateKey)));
    await assert.rejects(restarted.answer('node-b', resign({ ...request, id: randomUUID() }, f.b.keys().signingPrivateKey)));
    assert.equal(f.calls(), 1); f.target.deliver('controller-a', response); await pending;
  } finally { f.target.close(); }
});

test('invalid size, freshness, shape and signature fail before effect', async () => {
  const f = fixtures();
  try {
    const pending = f.target.request(f.a.device.id, f.ctx, 'list');
    const rejected = assert.rejects(pending, /SECRET_REMOTE_OFFLINE/);
    const [request] = f.target.poll('controller-a'); assert.ok(request);
    for (const mutation of [ { expiresAt: request.createdAt - 1 }, { expiresAt: request.createdAt + 60_000 }, { createdAt: Date.now() + 10_000 }, { nonce: 'bad' }, { signature: 'bad' }, { extra: true }, { payload: 'a'.repeat(70_000) } ]) {
      await assert.rejects(f.source.answer('node-b', { ...request, ...mutation }));
    }
    assert.equal(f.calls(), 0); f.target.close(); await rejected;
  } finally { f.target.close(); }
});

test('trust revoked after request and locked source deny without cancelling provider or task', async () => {
  const f = fixtures({ handle: () => { throw new Error('locked'); } });
  try {
    const pending = f.target.request(f.a.device.id, f.ctx, 'close');
    const [request] = f.target.poll('controller-a'); assert.ok(request);
    f.aPeers[0]!.enabled = false; await assert.rejects(f.source.answer('node-b', request));
    f.aPeers[0]!.enabled = true;
    const response = await f.source.answer('node-b', request);
    f.bPeers[0]!.enabled = false; assert.throws(() => f.target.deliver('controller-a', response));
    f.bPeers[0]!.enabled = true;
    const rejected = assert.rejects(pending, /SECRET_REMOTE_UNAVAILABLE/); f.target.deliver('controller-a', response); await rejected;
  } finally { f.target.close(); }
});

test('offline timeout only clears broker pending requests', async () => {
  const f = fixtures();
  const target = new RemoteSecretBroker({ device: () => f.b.device, deviceKeys: f.b.keys, peers: () => f.bPeers, begin: () => true, handle: () => undefined, timeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(target.request(f.a.device.id, f.ctx, 'list'), /SECRET_REMOTE_OFFLINE/); assert.equal(target.pending(), 0); }
  finally { clearTimeout(keepAlive); target.close(); }
});

test('copied public identity cannot decrypt a sealed response without the independent encryption private key', async () => {
  const f = fixtures(), clone = identity();
  let recipientKeys = f.b.keys();
  const target = new RemoteSecretBroker({ device: () => f.b.device, deviceKeys: () => recipientKeys, peers: () => f.bPeers, begin: () => true, handle: () => null });
  try {
    const pending = target.request(f.a.device.id, f.ctx, 'resolve', { ref: 'secret:token' });
    const [request] = target.poll('controller-a'); assert.ok(request);
    const response = await f.source.answer('node-b', request);
    recipientKeys = { ...recipientKeys, encryptionPrivateKey: clone.keys().encryptionPrivateKey };
    assert.throws(() => target.deliver('controller-a', response), /SECRET_REMOTE_DENIED/);
    assert.equal(target.pending(), 1);
    recipientKeys = f.b.keys(); target.deliver('controller-a', response); await pending;
  } finally { target.close(); }
});

test('revocation during source resolution prevents delivery and an uncertain operation never executes again', async () => {
  let entered = 0;
  const f = fixtures({ handle: () => { entered++; f.aPeers[0]!.enabled = false; return Buffer.from('synthetic-secret-canary'); } });
  try {
    const pending = f.target.request(f.a.device.id, f.ctx, 'resolve');
    const rejected = assert.rejects(pending, /SECRET_REMOTE_OFFLINE/);
    const [request] = f.target.poll('controller-a'); assert.ok(request);
    await assert.rejects(f.source.answer('node-b', request));
    f.aPeers[0]!.enabled = true;
    await assert.rejects(f.source.answer('node-b', request)); assert.equal(entered, 1);
    f.target.close(); await rejected;
  } finally { f.target.close(); }
});

test('opaque relay pumps only approved nodes and concurrent ticks never duplicate a node operation', { timeout: 5000 }, async () => {
  const f = fixtures();
  let gets = 0, posts = 0, answerCalls = 0;
  let release!: () => void, entered!: () => void;
  const sourceEntered = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer();
  server.on('stream', (stream, headers) => {
    if (headers[':method'] === 'GET') {
      gets++; stream.respond({ ':status': 200 }); stream.end(JSON.stringify({ requests: f.target.poll('controller-a') }));
    } else {
      const chunks: Buffer[] = [];
      stream.on('data', chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
      stream.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(JSON.stringify(body).includes('synthetic-secret-canary'), false);
        f.target.deliver('controller-a', body.response); posts++; stream.respond({ ':status': 200 }); stream.end('{}');
      });
    }
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const session = connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const relay = new SecretRelay({ nodes: { list: () => [{ id: 'node-b', status: 'connected' }, { id: 'untrusted', status: 'connected' }], session: id => { assert.equal(id, 'node-b'); return session; } }, peers: () => f.aPeers,
    workerAnswer: async (id, request) => { answerCalls++; entered(); await gate; return f.source.answer(id, request); }, onError: () => assert.fail('fixture relay failed') });
  try {
    const pending = f.target.request(f.a.device.id, f.ctx, 'resolve');
    const pump = relay.pump();
    await sourceEntered;
    assert.equal(answerCalls, 1); assert.equal(relay.inFlight(), 1);
    await relay.pump(); assert.equal(gets, 1);
    release(); await pump; await pending; assert.equal(posts, 1); assert.equal(relay.inFlight(), 0);
    relay.close(); await relay.pump(); assert.equal(gets, 1);
  } finally {
    release(); relay.close(); f.target.close(); session.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('user-selected field names cannot collide with the binary wire marker', async () => {
  const f = fixtures({ handle: () => ({ fields: { $secretBytes: 'plain-field-value' } }) });
  try {
    const pending = f.target.request(f.a.device.id, f.ctx, 'resolve', { fields: ['$secretBytes'] });
    const [request] = f.target.poll('controller-a'); assert.ok(request);
    f.target.deliver('controller-a', await f.source.answer('node-b', request));
    assert.deepEqual(await pending, { fields: { $secretBytes: 'plain-field-value' } });
  } finally { f.target.close(); }
});
