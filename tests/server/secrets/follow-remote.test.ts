import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { connect, createServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { RemoteSecretBroker, type RemoteSecretBrokerOptions } from '../../../server/secrets/remote.js';
import { SecretRelay } from '../../../server/link/secret-relay.js';
import { notShared } from '../../../server/secrets/policy.js';
import type { SecretContext, SecretDevice, SecretPeer } from '../../../shared/secrets.js';

function identity() {
  const signing = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519');
  const keys = { signingPrivateKey: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), encryptionPrivateKey: encryption.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const device: SecretDevice = { id: randomUUID(), name: 'fixture', signingKey: signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(), encryptionKey: encryption.publicKey.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: 'f' };
  return { device, keys: () => keys };
}
/** Host A answering computer B over route `controller-a` / `node-b`; B follows A when `followed` says so. */
function fixtures(host: Partial<RemoteSecretBrokerOptions> = {}, followed: () => string | undefined = () => 'controller-a') {
  const a = identity(), b = identity(); const refused: string[] = [];
  const aPeers: SecretPeer[] = [{ device: b.device, direction: 'node', routeId: 'node-b', enabled: true }];
  const bPeers: SecretPeer[] = [{ device: a.device, direction: 'controller', routeId: 'controller-a', enabled: true }];
  const source = new RemoteSecretBroker({ device: () => a.device, deviceKeys: a.keys, peers: () => aPeers, begin: () => true, handle: () => [], refused: (_context, request, code) => { refused.push(`${request.operation}:${code}`); }, ...host });
  const node = new RemoteSecretBroker({ device: () => b.device, deviceKeys: b.keys, peers: () => bPeers, begin: () => true, handle: () => undefined, timeoutMs: 1000, followed });
  const ctx: SecretContext = { hostId: b.device.id, sessionId: 'session-b', taskId: randomUUID(), runId: 'run-b', root: '/fixture/project' };
  /** One relay round: A's relay polls B with `features` and answers what it got. */
  const round = async (features: string[]) => { for (const request of node.poll('controller-a', features)) { try { node.deliver('controller-a', await source.answer('node-b', request)); } catch { /* unanswered, as today */ } } };
  return { a, b, source, node, ctx, refused, round };
}
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

test('the followed host tells why it refuses only to a computer that asked for reasons; others get today’s answers', async () => {
  const f = fixtures({ begin: () => { throw notShared('Remote task denied'); } });
  try {
    // The host confirmed the catalog: the computer asks for reasons, and a first use where nothing is shared is answered.
    f.node.poll('controller-a', ['available', 'catalog']);
    const asked = f.node.request(f.a.device.id, f.ctx, 'resolve', { reference: 'tower-secret://x/y@1', operation: 'env' });
    const [request] = f.node.poll('controller-a', ['available', 'catalog']);
    assert.deepEqual((request!.payload as { $secretObject: [string, unknown][] }).$secretObject.find(([key]) => key === 'reasons'), ['reasons', true]);
    f.node.deliver('controller-a', await f.source.answer('node-b', request!));
    await assert.rejects(asked, code('SECRET_NOT_SHARED'));
    assert.deepEqual(f.refused, ['resolve:SECRET_NOT_SHARED']);
    // A host whose relay does not confirm the catalog is asked as before, and leaves the first use unanswered as before.
    f.node.poll('controller-a', ['available']);
    const plain = f.node.request(f.a.device.id, f.ctx, 'resolve', { reference: 'tower-secret://x/y@1', operation: 'env' }); plain.catch(() => undefined);
    const [old] = f.node.poll('controller-a', ['available']);
    assert.equal((old!.payload as { $secretObject: [string, unknown][] }).$secretObject.some(([key]) => key === 'reasons'), false);
    await assert.rejects(f.source.answer('node-b', old!));
    assert.deepEqual(f.refused, ['resolve:SECRET_NOT_SHARED'], 'no owner notice for a computer that did not ask');
  } finally { f.node.close(); }
});

test('a refusal inside the task is told only with reasons; without them it stays SECRET_REMOTE_UNAVAILABLE', async () => {
  const f = fixtures({ handle: () => { throw notShared(); } });
  try {
    f.node.poll('controller-a', ['catalog']);
    const asked = f.node.request(f.a.device.id, f.ctx, 'resolve', {}); const told = assert.rejects(asked, code('SECRET_NOT_SHARED'));
    await f.round(['catalog']); await told;
    const notFollowing = fixtures({ handle: () => { throw notShared(); } }, () => undefined);
    notFollowing.node.poll('controller-a', ['catalog']);
    const plain = notFollowing.node.request(notFollowing.a.device.id, notFollowing.ctx, 'resolve', {}); const generic = assert.rejects(plain, code('SECRET_REMOTE_UNAVAILABLE'));
    await notFollowing.round(['catalog']); await generic;
    assert.deepEqual(notFollowing.refused, [], 'a computer that does not follow never asks for reasons');
    notFollowing.node.close();
  } finally { f.node.close(); }
});

test('the catalog is a read sent only to a host that confirmed it; it claims nothing there', async () => {
  let claims = 0;
  const f = fixtures({ begin: () => { claims++; return true; }, handle: (_context, request) => request.operation === 'catalog' ? [{ id: 'x' }] : [] });
  try {
    await assert.rejects(f.node.request(f.a.device.id, f.ctx, 'catalog'), code('SECRET_REMOTE_UNSUPPORTED'));
    f.node.poll('controller-a', ['available']);
    await assert.rejects(f.node.request(f.a.device.id, f.ctx, 'catalog'), code('SECRET_REMOTE_UNSUPPORTED'), 'an older host');
    f.node.poll('controller-a', ['available', 'catalog']);
    const read = f.node.request(f.a.device.id, f.ctx, 'catalog');
    await f.round(['available', 'catalog']);
    assert.deepEqual(await read, [{ id: 'x' }]); assert.equal(claims, 0);
  } finally { f.node.close(); }
});

test('the followed host’s locked vault and lost link refuse at once with their reason; any other controller waits as before', async () => {
  const f = fixtures();
  try {
    const waiting = f.node.request(f.a.device.id, f.ctx, 'resolve', {}); const locked = assert.rejects(waiting, code('SECRET_HOST_LOCKED'));
    assert.deepEqual(f.node.poll('controller-a', ['locked']), []);
    await locked;
    assert.equal(f.node.lockedRefusals('controller-a'), 1); assert.equal(f.node.lockedRefusals('controller-a'), 0, 'read once');
    await assert.rejects(f.node.request(f.a.device.id, f.ctx, 'list'), code('SECRET_HOST_LOCKED'), 'while it says so');
    assert.equal(f.node.declines(f.a.device.id, 'available'), false, 'a locked host is not an older build');
    f.node.poll('controller-a', ['available', 'catalog']);
    const answered = f.node.request(f.a.device.id, f.ctx, 'list'); await f.round(['available', 'catalog']); assert.deepEqual(await answered, []);
    f.node.forget('controller-a');
    await assert.rejects(f.node.request(f.a.device.id, f.ctx, 'list'), code('SECRET_HOST_OFFLINE'));
    f.node.poll('controller-a', ['available', 'catalog']);
    const back = f.node.request(f.a.device.id, f.ctx, 'list'); await f.round(['available', 'catalog']); assert.deepEqual(await back, []);

    const other = fixtures({}, () => undefined);
    const queued = other.node.request(other.a.device.id, other.ctx, 'list'); queued.catch(() => undefined);
    other.node.forget('controller-a');
    assert.equal(other.node.pending(), 1, 'a controller this computer does not follow is waited for as before');
    other.node.close();
  } finally { f.node.close(); }
});

test('a locked host’s relay tells the computers that follow it, and hears how many requests they refused', { timeout: 5000 }, async () => {
  const server = createServer(); const seen: (string | undefined)[] = [];
  server.on('stream', (stream, headers) => {
    seen.push(headers['x-tower-secret-features'] as string | undefined);
    stream.respond({ ':status': 200 }); stream.end(JSON.stringify({ requests: [], refused: 2 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const locked: [string, number][] = [];
  let following = ['node-b'];
  const relay = new SecretRelay({ nodes: { list: () => [{ id: 'node-b', status: 'connected' }, { id: 'node-c', status: 'connected' }], session: () => session }, peers: () => [],
    workerAnswer: async () => { throw new Error('a locked worker answers nothing'); }, lockedNodes: async () => following, onLocked: (id, count) => locked.push([id, count]) });
  try {
    await relay.pump();
    assert.deepEqual(seen, ['locked']); assert.deepEqual(locked, [['node-b', 2]]);
    following = []; await relay.pump();
    assert.equal(seen.length, 1, 'nothing to tell once it is open or nobody follows');
  } finally { relay.close(); session.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
