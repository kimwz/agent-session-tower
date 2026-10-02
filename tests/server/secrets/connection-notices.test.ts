import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { RemoteNodes } from '../../../server/link/nodes.js';
import type { SecretPeer, SecretTarget } from '../../../shared/secrets.js';
import { handleSecretLink, ownerSecretControl } from '../../../server/secrets/link-routes.js';

const taskId = '9b979f3e-c6eb-4acf-b5b7-388cd7b2197b';
const target: SecretTarget = { hostId: 'node-device', sessionId: 'codex:fixture-remote', taskId, root: '/fixture/remote' };
const peer = (direction: 'node' | 'controller'): SecretPeer => ({ device: { id: 'node-device', name: 'Fixture node', signingKey: 'public', encryptionKey: 'public', fingerprint: 'public' }, routeId: 'fixture-link', direction, enabled: true });

async function incoming(body: unknown, approved = true, denyTask = false) {
  const calls: { operation: string; args?: unknown[] }[] = [];
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Http2ServerRequest;
  Object.assign(req, { method: 'POST', url: '/secret-connection-notice' });
  let status = 0; let answer = '';
  const res = { writeHead(code: number) { status = code; }, end(value: string) { answer = value; } } as unknown as Http2ServerResponse;
  const handled = await handleSecretLink(req, res, 'fixture-link', { secretCall: async (operation, args) => {
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
});

test('remote explicit assignment sends one notice after commit and before a failed overview', async t => {
  const events: string[] = [];
  const notices: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/secret-target')) { res.end(JSON.stringify(target)); return; }
    if (req.url === '/secret-connection-notice') {
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
        events.push('notice'); notices.push(JSON.parse(raw)); res.end(JSON.stringify({ notified: true }));
      }); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  t.after(() => { session.destroy(); server.close(); });
  const nodes = { session: () => session } as unknown as RemoteNodes;
  const worker = { secretCall: async (operation: string, args: unknown[] = []) => {
    if (operation === 'peers') return [peer('node')];
    if (args[0] === 'overview') { events.push('overview'); throw new Error('fixture overview failed after commit'); }
    assert.equal(args[3], true);
    assert.equal((args[1] as Record<string, unknown>).target, undefined);
    events.push('commit'); return { connectedTarget: target };
  } };
  await assert.rejects(ownerSecretControl(nodes, worker, 'create', { nodeId: 'fixture-link', sessionId: target.sessionId, connect: true, notifySession: true, target: { taskId: 'spoofed' }, value: 'FAKE_OWNER_VALUE' }), /overview failed/);
  assert.deepEqual(events, ['commit', 'notice', 'overview']);
  assert.deepEqual(notices, [{ sessionId: target.sessionId, taskId }]);
  assert.doesNotMatch(JSON.stringify(notices), /FAKE_OWNER_VALUE|spoofed/);
  events.length = 0;
  const quietWorker = { secretCall: async (operation: string, args: unknown[] = []) => {
    if (operation === 'peers') return [peer('node')];
    assert.equal(args[3], false); events.push('quiet-mutation'); return { status: { locked: false } };
  } };
  await ownerSecretControl(nodes, quietWorker, 'unlock', { nodeId: 'fixture-link', sessionId: target.sessionId, notifySession: true });
  assert.deepEqual(events, ['quiet-mutation']); assert.equal(notices.length, 1);
});
