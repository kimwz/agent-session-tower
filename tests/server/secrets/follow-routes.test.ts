import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import { handleSecretLink, ownerSecretControl, WORKER_UPDATE_PENDING } from '../../../server/link/secret-routes.js';
import type { RunnerCapability } from '../../../server/runs/runner-protocol.js';

/** One link request from controller `controllerId`, answered by the node-side handler with a fixture worker. */
async function linkRequest(path: string, method: string, body: unknown, worker: { capabilities: RunnerCapability[]; calls: [string, unknown[]][] }, follows: (id: string) => Promise<boolean>, headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers }) as unknown as Http2ServerRequest;
  let status = 0; let text = '';
  const res = { writeHead(code: number) { status = code; }, end(value: string) { text = value; } } as unknown as Http2ServerResponse;
  await handleSecretLink(req, res, 'controller-route', { supports: capability => worker.capabilities.includes(capability), secretCall: async (operation, args = []) => {
    worker.calls.push([operation, args]);
    if (operation === 'peers') return [{ device: { id: 'controller-device' }, routeId: 'controller-route', direction: 'controller', enabled: true }];
    if (operation === 'poll') return { requests: [] };
    return { vault: 'open', trusted: true };
  } }, { follows });
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}

test('a computer aligns secret trust only with the host it follows, and only on a worker that serves it', async () => {
  const worker = { capabilities: ['secretMachines'] as RunnerCapability[], calls: [] as [string, unknown[]][] };
  const device = { id: 'host-device' };
  const followed = await linkRequest('/secret-align', 'POST', { device }, worker, async id => id === 'controller-route');
  assert.equal(followed.status, 200);
  assert.deepEqual(worker.calls, [['align', [{ routeId: 'controller-route', direction: 'controller', device }]]], 'no existing trust is needed for it');
  worker.calls.length = 0;
  assert.equal((await linkRequest('/secret-align', 'POST', {}, worker, async () => false)).status, 403, 'another controller');
  assert.equal((await linkRequest('/secret-align', 'GET', undefined, worker, async () => true)).status, 403);
  assert.equal((await linkRequest('/secret-align', 'POST', {}, { ...worker, capabilities: [] }, async () => true)).status, 403, 'an older worker');
  assert.deepEqual(worker.calls, []);
});

test('a relay may say its host serves the catalog or is locked; anything else it says is dropped', async () => {
  const worker = { capabilities: [] as RunnerCapability[], calls: [] as [string, unknown[]][] };
  await linkRequest('/secret-relay', 'GET', undefined, worker, async () => true, { 'x-tower-secret-features': 'available, catalog,locked,list' });
  assert.deepEqual(worker.calls.find(([operation]) => operation === 'poll'), ['poll', ['controller-route', ['available', 'catalog', 'locked']]]);
});

test('with a worker before machine sharing, the page’s "all my machines" is its GLOBAL, and sharing with single computers waits for its update', async () => {
  const sent: [string, unknown][] = [];
  const older = { supports: (capability: RunnerCapability) => capability !== 'secretMachines', secretCall: async (_operation: string, args: unknown[] = []) => {
    sent.push([args[0] as string, args[1]]);
    return { status: { initialized: true, locked: false }, peers: [], secrets: [{ id: 'k', name: 'K', groupId: 'g', kind: 'scalar', version: 1, reference: 'r', sharing: { revision: 2, global: true, folders: [] } }, { id: 'l', name: 'L', groupId: 'g', kind: 'scalar', version: 1, reference: 'r', legacy: { global: [], folders: [], limited: false } }] };
  } };
  const view = await ownerSecretControl(undefined, older, 'settings', {}) as { secrets: { sharing?: unknown; legacy?: unknown }[] };
  assert.deepEqual(view.secrets.map(item => item.sharing), [{ revision: 2, allMachines: true, machines: [], folders: [] }, undefined]);
  assert.deepEqual(view.secrets[1]!.legacy, { global: [], folders: [], limited: false }, 'a legacy summary is left as it is');
  await ownerSecretControl(undefined, older, 'sharing', { secretId: 'k', revision: 2, allMachines: false, machines: [], folders: [] });
  assert.deepEqual(sent.at(-1), ['sharing', { secretId: 'k', revision: 2, global: false, folders: [], kept: [] }]);
  await ownerSecretControl(undefined, older, 'create', { name: 'N', kind: 'scalar', value: 'v', sharing: { allMachines: true, machines: [], folders: [] } });
  assert.deepEqual((sent.at(-1)![1] as { sharing: unknown }).sharing, { global: true, folders: [] });
  const count = sent.length;
  await assert.rejects(ownerSecretControl(undefined, older, 'sharing', { secretId: 'k', revision: 2, allMachines: false, machines: ['node-vault'], folders: [] }), { code: WORKER_UPDATE_PENDING });
  assert.equal(sent.length, count, 'nothing sent');
});
