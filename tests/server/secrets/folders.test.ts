import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { SecretPeer } from '../../../shared/secrets.js';
import { canonicalFolders, realFolder, SECRET_SHARING_FEATURE, type FolderSources } from '../../../server/secrets/folders.js';
import { folderSources, handleSecretLink } from '../../../server/link/secret-routes.js';
import type { RemoteNodes } from '../../../server/link/nodes.js';

const NODE_A = 'a'.repeat(32), NODE_B = 'b'.repeat(32), OLD = 'c'.repeat(32), UNTRUSTED = 'd'.repeat(32);
const DEVICE = '00000000-0000-4000-8000-000000000000';
const peer = (routeId: string, id: string, patch: Partial<SecretPeer> = {}): SecretPeer => ({ device: { id, name: routeId, signingKey: 'public', encryptionKey: 'public', fingerprint: 'public' }, routeId, direction: 'node', enabled: true, ...patch });
const PEERS = [peer(NODE_A, 'device-of-a'), peer(NODE_B, 'device-of-b'), peer(OLD, 'device-of-old'),
  peer(UNTRUSTED, 'device-disabled', { enabled: false }), peer('e'.repeat(32), 'device-controller', { direction: 'controller' })];

async function folders(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-folders-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project); await symlink(project, join(root, 'project-link')); await writeFile(join(root, 'file.txt'), 'not a folder');
  const asked: [string, string][] = [];
  const sources: FolderSources = { deviceId: async () => DEVICE, peers: async () => PEERS,
    features: node => node === OLD ? ['read', 'secrets'] : [NODE_A, NODE_B, UNTRUSTED].includes(node) ? [SECRET_SHARING_FEATURE] : undefined,
    ask: async (node, path) => { asked.push([node, path]); return path; } };
  return { root, project, sources, asked };
}

test('folders of this computer become real paths of existing folders', async t => {
  const f = await folders(t);
  assert.deepEqual(await canonicalFolders([{ cwd: join(f.root, 'project-link') }, { cwd: f.project }], f.sources), [{ hostId: DEVICE, root: f.project }], 'a link resolves to its folder, once');
  await assert.rejects(canonicalFolders([{ cwd: join(f.root, 'file.txt') }], f.sources), { kind: 'invalid', message: /폴더가 아닙니다/ });
  await assert.rejects(canonicalFolders([{ cwd: join(f.root, 'missing') }], f.sources), { kind: 'invalid', message: /폴더를 찾을 수 없습니다/ });
  await assert.rejects(canonicalFolders([{ cwd: 'relative/project' }], f.sources), { kind: 'invalid', message: /절대 경로/ });
  await assert.rejects(realFolder(undefined), { kind: 'invalid' });
  assert.deepEqual(f.asked, [], 'no joined computer is asked about this computer’s folders');
});

test('the same folder name on different computers stays apart, each under the vault ID trusted on its link', async t => {
  const f = await folders(t);
  const result = await canonicalFolders([{ cwd: f.project }, { cwd: `@${NODE_A}/${f.project}` }, { cwd: `@${NODE_B}/${f.project}` }], f.sources);
  assert.deepEqual(result, [{ hostId: DEVICE, root: f.project }, { hostId: 'device-of-a', root: f.project }, { hostId: 'device-of-b', root: f.project }]);
  assert.deepEqual(f.asked, [[NODE_A, f.project], [NODE_B, f.project]], 'each joined computer resolves its own path');
  await assert.rejects(canonicalFolders([{ cwd: `@${NODE_A}/relative` }], f.sources), { kind: 'invalid', message: /절대 경로/ });
});

test('a joined computer not trusted for secrets, an older one and a disconnected one are refused before it is asked', async t => {
  const f = await folders(t);
  for (const node of [UNTRUSTED, 'e'.repeat(32), 'f'.repeat(32)]) await assert.rejects(canonicalFolders([{ cwd: `@${node}//project` }], f.sources), { kind: 'invalid', message: /먼저 .*신뢰하세요/ });
  await assert.rejects(canonicalFolders([{ cwd: `@${OLD}//project` }], f.sources), { kind: 'invalid', message: /합류 컴퓨터 업데이트가 필요합니다/ });
  await assert.rejects(canonicalFolders([{ cwd: `@${NODE_A}//project` }], { ...f.sources, features: () => undefined }), { kind: 'unavailable' });
  assert.deepEqual(f.asked, []);
  await assert.rejects(canonicalFolders([{ cwd: f.project, extra: true }], f.sources), { kind: 'invalid' });
  await assert.rejects(canonicalFolders(Array.from({ length: 101 }, () => ({ cwd: f.project })), f.sources), { kind: 'invalid' });
  assert.deepEqual(await canonicalFolders([{ hostId: 'device-removed', root: '/kept' }], f.sources), [{ hostId: 'device-removed', root: '/kept' }], 'a kept folder passes for the service to check');
});

/** One link request answered by the node-side handler, with a worker that trusts the controller unless told not to. */
async function nodeRoute(path: string, options: { trusted?: boolean; excluded?: (path: string) => Promise<boolean> } = {}) {
  const req = { method: 'GET', url: `/secret-folder?path=${encodeURIComponent(path)}`, headers: {} } as unknown as Http2ServerRequest;
  let status = 0; let body = '';
  const res = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as unknown as Http2ServerResponse;
  const calls: string[] = [];
  await handleSecretLink(req, res, 'controller-route', { supports: () => true, secretCall: async operation => {
    calls.push(operation); return options.trusted === false ? [] : [{ ...peer('controller-route', 'controller-device'), direction: 'controller' }];
  } }, { excluded: options.excluded });
  return { status, body: JSON.parse(body) as { root?: string; error?: string }, calls };
}

test('the joined computer answers only the real path of an existing folder it shares, to a controller it trusts', async t => {
  const f = await folders(t);
  const linked = await nodeRoute(join(f.root, 'project-link'));
  assert.equal(linked.status, 200); assert.equal(linked.body.root, f.project); assert.deepEqual(linked.calls, ['peers']);
  assert.equal((await nodeRoute(join(f.root, 'file.txt'))).status, 400);
  assert.equal((await nodeRoute(join(f.root, 'missing'))).status, 400);
  assert.equal((await nodeRoute(f.project, { trusted: false })).status, 403);
  const excluded = await nodeRoute(f.project, { excluded: async path => path === f.project });
  assert.equal(excluded.status, 404); assert.equal(excluded.body.root, undefined);
});

test('the controller asks a joined computer over its link and turns each answer into a Korean refusal', async t => {
  const answers = new Map<string, [number, unknown]>([['/ok', [200, { root: '/real/ok' }]], ['/file', [400, { error: 'x' }]], ['/hidden', [404, { error: 'x' }]], ['/untrusted', [403, { error: 'x' }]], ['/broken', [500, { error: 'x' }]], ['/relative', [200, { root: 'real' }]]]);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'https://node.invalid').searchParams.get('path') ?? '';
    const [status, body] = answers.get(path) ?? [404, {}]; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  t.after(() => { session.destroy(); server.close(); });
  const nodes = { session: (id: string) => id === NODE_A ? session : undefined, list: () => [{ id: NODE_A, status: 'connected', features: [SECRET_SHARING_FEATURE] }, { id: NODE_B, status: 'offline', features: [SECRET_SHARING_FEATURE] }] } as unknown as RemoteNodes;
  const sources = folderSources(nodes, { supports: () => true, secretCall: async operation => { if (operation === 'peers') return PEERS; throw new Error('Vault locked'); } });
  assert.deepEqual(sources.features(NODE_A), [SECRET_SHARING_FEATURE]); assert.equal(sources.features(NODE_B), undefined, 'a disconnected computer has no features to go by');
  assert.equal(await sources.ask(NODE_A, '/ok'), '/real/ok');
  for (const path of ['/file', '/hidden']) await assert.rejects(sources.ask(NODE_A, path), { kind: 'invalid', message: /찾을 수 없거나 폴더가 아닙니다/ });
  await assert.rejects(sources.ask(NODE_A, '/untrusted'), { kind: 'invalid', message: /신뢰하지 않았거나/ });
  for (const path of ['/broken', '/relative']) await assert.rejects(sources.ask(NODE_A, path), { kind: 'unavailable' });
  await assert.rejects(sources.ask(NODE_B, '/ok'), { kind: 'unavailable' });
  await assert.rejects(sources.deviceId(), { kind: 'locked' });
});
