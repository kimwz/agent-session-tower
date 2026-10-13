import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { RemoteNodes } from '../../../server/link/nodes.js';
import type { SecretPeer, SecretTarget } from '../../../shared/secrets.js';
import { handleSecretLink, ownerSecretControl, WORKER_UPDATE_PENDING } from '../../../server/link/secret-routes.js';
import { SECRET_EXCLUSIONS_FEATURE, SECRET_SHARING_FEATURE } from '../../../server/secrets/folders.js';

const NODE = 'f'.repeat(32);
const taskId = '9b979f3e-c6eb-4acf-b5b7-388cd7b2197b';
const target: SecretTarget = { hostId: 'node-device', sessionId: 'codex:fixture-remote', taskId, root: '/fixture/remote' };
const subject = { hostId: 'node-device', sessionId: target.sessionId, root: target.root, taskId, usage: [] };
const peer = (direction: 'node' | 'controller', routeId = NODE): SecretPeer => ({ device: { id: 'node-device', name: 'Fixture node', signingKey: 'public', encryptionKey: 'public', fingerprint: 'public' }, routeId, direction, enabled: true });
type Call = { operation: string; args: unknown[] };
/** A worker that serves per-secret sharing unless told otherwise, recording each call; `answer` decides what it returns. */
const worker = (answer: (call: Call) => unknown, supports = true) => {
  const calls: Call[] = [];
  return { calls, supports: () => supports, secretCall: async (operation: string, args: unknown[] = []) => { const call = { operation, args }; calls.push(call); return answer(call); } };
};

async function incoming(body: unknown, approved = true, denyTask = false) {
  const calls: { operation: string; args?: unknown[] }[] = [];
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Http2ServerRequest;
  Object.assign(req, { method: 'POST', url: '/secret-connection-notice', headers: {} });
  let status = 0; let answer = '';
  const res = { writeHead(code: number) { status = code; }, end(value: string) { answer = value; } } as unknown as Http2ServerResponse;
  const handled = await handleSecretLink(req, res, NODE, { supports: () => true, secretCall: async (operation, args) => {
    calls.push({ operation, args });
    if (operation === 'peers') return approved ? [peer('controller')] : [];
    if (denyTask) throw Object.assign(new Error('fixture stale task'), { statusCode: 403 });
    return { notified: true };
  } });
  return { handled, calls, status, answer };
}

test('the paired connection notice accepts only fixed target metadata from an approved controller', async () => {
  const good = await incoming({ sessionId: target.sessionId, taskId });
  assert.equal(good.handled, true); assert.equal(good.status, 200);
  assert.deepEqual(good.calls.at(-1), { operation: 'connection-notice', args: [target.sessionId, taskId] });
  const denied = await incoming({ sessionId: target.sessionId, taskId }, false);
  assert.equal(denied.status, 403); assert.equal(denied.calls.length, 1);
  for (const body of [{ sessionId: target.sessionId, taskId, text: 'OWNER_INPUT_MUST_NOT_BECOME_INSTRUCTIONS' }, { sessionId: target.sessionId, taskId: 'invalid' }]) {
    const invalid = await incoming(body);
    assert.notEqual(invalid.status, 200); assert.equal(invalid.calls.length, 1);
    assert.doesNotMatch(invalid.answer, /OWNER_INPUT_MUST_NOT_BECOME_INSTRUCTIONS/);
  }
  assert.equal((await incoming({ sessionId: target.sessionId, taskId }, true, true)).status, 403);
  // The keys a controller connected, whose stop in this session ends with the notice.
  const lifting = await incoming({ sessionId: target.sessionId, taskId, secretIds: ['source-key'] });
  assert.equal(lifting.status, 200); assert.deepEqual(lifting.calls.at(-1), { operation: 'connection-notice', args: [target.sessionId, taskId, ['source-key']] });
});

test('invalid chat input fails before a joined computer is asked to start a task', async () => {
  const fake = worker(() => { throw new Error('must not reach the worker'); });
  for (const input of [{ nodeId: NODE, sessionId: target.sessionId, name: 'x', kind: 'scalar', value: 'v' }, { nodeId: NODE, sessionId: target.sessionId, name: 'x', kind: 'scalar', value: 'v', connect: true }]) {
    await assert.rejects(ownerSecretControl(undefined, fake, 'create', input), { kind: 'invalid' });
  }
  await assert.rejects(ownerSecretControl(undefined, fake, 'session-connect', { nodeId: NODE, sessionId: target.sessionId, secretIds: [] }), { kind: 'invalid' });
  assert.deepEqual(fake.calls, []);
});

/** A joined computer over a real HTTP/2 link that records what it was asked. */
async function node(t: TestContext, options: { features?: string[]; subject?: unknown; subjectStatus?: number } = {}) {
  const events: string[] = []; const notices: unknown[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'https://node.invalid').pathname;
    if (path === '/secret-target') { events.push(`target:${new URL(req.url!, 'https://node.invalid').searchParams.get('create')}`); res.end(JSON.stringify(target)); return; }
    if (path === '/secret-session') { events.push('subject'); res.writeHead(options.subjectStatus ?? 200); res.end(JSON.stringify(options.subject ?? subject)); return; }
    if (path === '/secret-connection-notice') {
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => { events.push('notice'); notices.push(JSON.parse(raw)); res.end(JSON.stringify({ notified: true })); }); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  t.after(() => { session.destroy(); server.close(); });
  const nodes = { session: () => session, list: () => [{ id: NODE, status: 'connected', features: options.features ?? [SECRET_SHARING_FEATURE] }] } as unknown as RemoteNodes;
  return { nodes, events, notices };
}

test('a remote chat value is committed, announced once with fixed metadata, then viewed from the joined computer’s report', async t => {
  const link = await node(t);
  const fake = worker(({ operation, args }) => {
    if (operation === 'peers') return [peer('node')];
    if (args[0] === 'session') { link.events.push('view'); throw new Error('fixture view failed after commit'); }
    assert.equal((args[1] as Record<string, unknown>).target, undefined); assert.deepEqual(args[2], target);
    link.events.push('commit'); return { connectedTarget: target };
  });
  await assert.rejects(ownerSecretControl(link.nodes, fake, 'create', { nodeId: NODE, sessionId: target.sessionId, name: 'FAKE', kind: 'scalar', connect: 'session', temporary: true, target: { taskId: 'spoofed' }, value: 'FAKE_OWNER_VALUE' }), /view failed/);
  assert.deepEqual(link.events, ['target:true', 'commit', 'notice', 'subject', 'view']);
  assert.deepEqual(link.notices, [{ sessionId: target.sessionId, taskId }]);
  assert.doesNotMatch(JSON.stringify(link.notices), /FAKE_OWNER_VALUE|spoofed/);
});

test('remote connections are announced, disconnections and other changes are not, and a refused change announces nothing', async t => {
  const link = await node(t);
  const fake = worker(({ operation, args }) => {
    if (operation === 'peers') return [peer('node')];
    if (args[0] === 'session') { assert.deepEqual(args[2], subject); return { view: true }; }
    if (args[0] === 'unlock') return { status: { initialized: true, locked: false } };
    return { connectedTarget: target };
  });
  assert.deepEqual(await ownerSecretControl(link.nodes, fake, 'session-connect', { nodeId: NODE, sessionId: target.sessionId, secretIds: ['fake'] }), { view: true });
  assert.equal(link.notices.length, 1);
  assert.deepEqual(await ownerSecretControl(link.nodes, fake, 'session-disconnect', { nodeId: NODE, sessionId: target.sessionId, secretIds: ['fake'] }), { view: true });
  await ownerSecretControl(link.nodes, fake, 'unlock', { nodeId: NODE, sessionId: target.sessionId, password: 'fixture' });
  assert.equal(link.notices.length, 1);
  assert.deepEqual(link.events, ['target:true', 'notice', 'subject', 'target:true', 'subject']);
  assert.deepEqual(link.notices, [{ sessionId: target.sessionId, taskId }], 'a computer that does not report exclusions gets the notice it knows');
  // One that reports them also lifts its own stop on the keys connected; a new value has none to lift.
  const lifting = await node(t, { features: [SECRET_SHARING_FEATURE, SECRET_EXCLUSIONS_FEATURE] });
  await ownerSecretControl(lifting.nodes, fake, 'session-connect', { nodeId: NODE, sessionId: target.sessionId, secretIds: ['fake'] });
  await ownerSecretControl(lifting.nodes, fake, 'create', { nodeId: NODE, sessionId: target.sessionId, name: 'NEW', kind: 'scalar', value: 'v', connect: 'session', temporary: true });
  assert.deepEqual(lifting.notices, [{ sessionId: target.sessionId, taskId, secretIds: ['fake'] }, { sessionId: target.sessionId, taskId }]);
  const refused = worker(({ operation }) => { if (operation === 'peers') return [peer('node')]; throw new Error('fixture mutation refused'); });
  await assert.rejects(ownerSecretControl(link.nodes, refused, 'session-connect', { nodeId: NODE, sessionId: target.sessionId, secretIds: ['fake'] }), /mutation refused/);
  assert.equal(link.notices.length, 1);
});

test('viewing a joined computer’s session never starts a task there, and asks only a computer that answers views', async t => {
  const link = await node(t);
  const fake = worker(({ operation, args }) => operation === 'peers' ? [peer('node')] : { view: args[2] });
  assert.deepEqual(await ownerSecretControl(link.nodes, fake, 'session', { nodeId: NODE, sessionId: target.sessionId, taskId: 'forged' }), { view: subject });
  assert.deepEqual(fake.calls.at(-1), { operation: 'control', args: ['session', { sessionId: target.sessionId, nodeId: NODE }, subject] });
  assert.deepEqual(link.events, ['subject'], 'no /secret-target, so nothing is started');
  const older = await node(t, { features: ['secrets'] });
  assert.deepEqual(await ownerSecretControl(older.nodes, fake, 'session', { nodeId: NODE, sessionId: target.sessionId }), { view: { error: 'worker-update-pending' } });
  assert.deepEqual(older.events, [], 'an older joined computer is not asked');
  for (const [answer, error] of [[{ subjectStatus: 404 }, 'session-closed'], [{ subjectStatus: 403 }, 'source-unavailable'], [{ subject: { ...subject, hostId: 'another-device' } }, 'source-unavailable']] as const) {
    const other = await node(t, answer);
    assert.deepEqual(await ownerSecretControl(other.nodes, fake, 'session', { nodeId: NODE, sessionId: target.sessionId }), { view: { error } });
  }
  const untrusted = worker(({ operation, args }) => operation === 'peers' ? [] : { view: args[2] });
  assert.deepEqual(await ownerSecretControl(link.nodes, untrusted, 'session', { nodeId: NODE, sessionId: target.sessionId }), { view: { error: 'not-eligible' } });
});

test('nothing new reaches an execution worker that predates per-secret sharing', async () => {
  const old = worker(({ args }) => ({ status: { initialized: true, locked: args[0] === 'lock' }, projects: [], groups: [], secrets: [{ id: 'old' }], rules: [] }), false);
  for (const action of ['sharing', 'create', 'session-connect', 'session-disconnect', 'session-reallow', 'update', 'remove', 'trust', 'untrust', 'password', 'import', 'initialize', 'preview']) {
    await assert.rejects(ownerSecretControl(undefined, old, action, { sessionId: 'codex:local', secretIds: ['x'], name: 'x', kind: 'scalar', value: 'v' }), (error: Error & { code?: string; kind?: string }) => error.code === WORKER_UPDATE_PENDING && error.kind === 'unavailable');
  }
  assert.equal(old.calls.length, 0);
  // The owner can still lock or unlock during the handoff; the answer carries only the older worker's status.
  assert.deepEqual(await ownerSecretControl(undefined, old, 'lock', { sessionId: 'codex:local' }), { status: { initialized: true, locked: true }, peers: [], secrets: [], workerUpdatePending: true });
  assert.deepEqual(await ownerSecretControl(undefined, old, 'unlock', { password: 'fixture-password', sessionId: 'codex:local' }), { status: { initialized: true, locked: false }, peers: [], secrets: [], workerUpdatePending: true });
  assert.deepEqual(old.calls.map(call => call.args), [['lock', {}], ['unlock', { password: 'fixture-password' }]]);
  // Settings and sessions read only the vault's status, from the older worker's overview, so lock and unlock are offered.
  assert.deepEqual(await ownerSecretControl(undefined, old, 'settings', {}), { status: { initialized: true, locked: false }, peers: [], secrets: [], workerUpdatePending: true });
  assert.deepEqual(await ownerSecretControl(undefined, old, 'session', { sessionId: 'codex:local', nodeId: NODE }), { status: { initialized: true, locked: false }, available: [], connectable: [], usage: [], unavailableSources: [], updatePendingSources: [], error: WORKER_UPDATE_PENDING, permanent: false });
  assert.deepEqual(old.calls.slice(2).map(call => call.args), [['overview', {}], ['overview', {}]]);
  const silent = worker(() => { throw new Error('fixture overview failed'); }, false);
  await assert.rejects(ownerSecretControl(undefined, silent, 'settings', {}), (error: Error & { code?: string }) => error.code === WORKER_UPDATE_PENDING);
});

test('a relay poll passes on only the features this worker knows, and a joined computer answers a view only with a new worker', async () => {
  const ask = async (path: string, headers: Record<string, string>, supports = true) => {
    const calls: { operation: string; args?: unknown[] }[] = []; let status = 0;
    const req = { method: 'GET', url: path, headers } as unknown as Http2ServerRequest;
    const res = { writeHead(code: number) { status = code; }, end() {} } as unknown as Http2ServerResponse;
    await handleSecretLink(req, res, NODE, { supports: () => supports, secretCall: async (operation, args) => { calls.push({ operation, args }); return operation === 'peers' ? [peer('controller')] : {}; } });
    return { calls: calls.slice(1), status };
  };
  assert.deepEqual((await ask('/secret-relay', { 'x-tower-secret-features': 'available, list,unknown' })).calls, [{ operation: 'poll', args: [NODE, ['available']] }]);
  assert.deepEqual((await ask('/secret-relay', {})).calls, [{ operation: 'poll', args: [NODE, []] }]);
  assert.deepEqual((await ask(`/secret-session?sessionId=${encodeURIComponent(target.sessionId)}`, {})).calls, [{ operation: 'session-subject', args: [target.sessionId, false] }]);
  assert.deepEqual((await ask(`/secret-session?sessionId=${encodeURIComponent(target.sessionId)}&exclusions=1`, {})).calls, [{ operation: 'session-subject', args: [target.sessionId, true] }], 'only a controller that reads exclusions gets them');
  const older = await ask(`/secret-session?sessionId=${encodeURIComponent(target.sessionId)}`, {}, false);
  assert.equal(older.status, 503); assert.deepEqual(older.calls, []);
});
