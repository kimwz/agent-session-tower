import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import { SecretService } from '../../../server/secrets/service.js';
import { FollowingSecrets } from '../../../server/link/secret-follow.js';
import { SECRET_MACHINES_FEATURE } from '../../../server/secrets/folders.js';
import type { SecretMetadata, SecretRunResult } from '../../../shared/secrets.js';
import type { NodeSummary } from '../../../shared/link.js';
import { FixtureRuns, vaultTemplate } from '../../helpers/secrets.js';

const CANARY = 'FOLLOW_HOST_SECRET_CANARY_517';
const HOST_ROUTE = 'a'.repeat(32), NODE_ROUTE = 'b'.repeat(32);
const host = vaultTemplate('fixture-follow-host-password');
before(() => host.ready());
after(() => host.dispose());

/** A worker of the computer that follows the host: a fresh service on its state, reading which host it follows. */
async function nodeWorker(stateDir: string, runs: FixtureRuns, follow: { host?: string }) {
  const service = new SecretService({ stateDir }); await service.start();
  return { service, runtime: new SecretRuntime({ stateDir, service, runs, followed: async () => follow.host }) };
}

/**
 * Host A (a vault with secrets) and computer B that follows it, B starting with no vault. A's side of the automatic
 * trust runs as the web does (FollowingSecrets), its link to B answered by B's runtime as B's web would.
 */
async function pair(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-follow-host-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const stateA = join(root, 'state-a'), stateB = join(root, 'state-b'), project = join(root, 'project-b'); await Promise.all([stateA, stateB, project].map(path => mkdir(path)));
  const a = await host.open(stateA); const source = new SecretRuntime({ stateDir: stateA, service: a, runs: new FixtureRuns() });
  const runsB = new FixtureRuns(); const capB = runsB.add(project); const follow: { host?: string } = { host: HOST_ROUTE };
  let node = await nodeWorker(stateB, runsB, follow);
  t.after(() => { source.close(); node.runtime.close(); });
  // What A's worker serves its web, as worker.ts dispatches it.
  const worker = { supports: () => true, secretCall: async (operation: string, args: unknown[] = []) => {
    if (operation === 'align') return source.align(args[0]);
    if (operation === 'peers') return source.peers();
    if (operation === 'shared-folders') return source.sharedFolders();
    if (operation === 'auto-share') return source.autoShare(args[0]);
    throw new Error(`unexpected ${operation}`);
  } };
  const summary: NodeSummary = { id: NODE_ROUTE, name: 'office-tower-1', fingerprint: 'f', status: 'connected', features: [SECRET_MACHINES_FEATURE], pairedAt: new Date().toISOString(), followHost: true, following: true };
  const links: { path: string; body: unknown }[] = [];
  const following = new FollowingSecrets({ controller: { list: () => [summary], following: () => true, on: () => undefined }, worker,
    link: async (_id, path, body) => { links.push({ path, body }); return { status: 200, json: await node.runtime.align({ routeId: HOST_ROUTE, direction: 'controller', ...body as object }) }; },
    canonical: async (_id, path) => path });
  /** A's relay polling B, as a host that serves the catalog does, answering until `pending` settles. */
  async function relay<T>(pending: Promise<T>, features = ['available', 'catalog']): Promise<T> {
    let done = false; const observed = pending.then(value => { done = true; return value; }, error => { done = true; throw error; }); observed.catch(() => undefined);
    for (let count = 0; !done && count < 400; count++) {
      for (const request of node.runtime.poll(HOST_ROUTE, features).requests) node.runtime.deliver(HOST_ROUTE, await source.answer(NODE_ROUTE, request));
      if (!done) await new Promise(resolve => setTimeout(resolve, 5));
    }
    if (!done) throw new Error('Fixture relay did not settle within its bounded poll window');
    return observed;
  }
  const run = (operationId: string, reference: string) => relay(node.runtime.tool(capB, 'secrets_run', { operationId, command: process.execPath, args: ['-e', "console.log(process.env.TOKEN ? 'token-present' : 'token-missing')"], env: { TOKEN: reference } })) as Promise<SecretRunResult>;
  return { a, source, get node() { return node; }, restart: async () => { node.runtime.close(); node = await nodeWorker(stateB, runsB, follow); return node; }, capB, follow, following, links, relay, run, project };
}

test('a clean computer that joins and follows: vault made by itself, trust aligned, an "all my machines" secret works, also after a restart', { timeout: 30000 }, async t => {
  const f = await pair(t);
  const all = await f.a.create({ name: 'ALL_MACHINES', kind: 'scalar', value: CANARY, sharing: { allMachines: true, folders: [] } });
  assert.equal(await f.node.runtime.machineVault(), 'open', 'its worker made the vault at start');
  await f.following.align(NODE_ROUTE);
  assert.equal(f.following.status(NODE_ROUTE)?.state, 'connected'); assert.equal(f.following.status(NODE_ROUTE)?.available, 1);
  assert.deepEqual(f.node.service.peers().map(peer => [peer.device.id, peer.routeId, peer.direction]), [[f.a.device().id, HOST_ROUTE, 'controller']]);
  assert.deepEqual(f.a.peers().map(peer => [peer.device.id, peer.routeId, peer.direction]), [[f.node.service.device().id, NODE_ROUTE, 'node']]);
  const used = await f.run('first-use', all.reference);
  assert.equal(used.exitCode, 0); assert.match(used.stdout, /token-present/); assert.equal(JSON.stringify(used).includes(CANARY), false);
  await f.following.align(NODE_ROUTE);
  assert.equal(f.links.length, 2, 'checked again, changing nothing');

  const restarted = await f.restart();
  assert.equal(restarted.service.status().locked, true);
  assert.equal(await restarted.runtime.machineVault(), 'open', 'no password after a restart');
  const again = await f.run('after-restart', all.reference);
  assert.equal(again.exitCode, 0); assert.match(again.stdout, /token-present/);
});

test('trust made while the host was locked completes once it opens; a computer the owner untrusted is not trusted again', { timeout: 30000 }, async t => {
  const f = await pair(t); await f.node.runtime.machineVault();
  const carry = f.a.handoff()!; await f.a.lock();
  await f.following.align(NODE_ROUTE);
  assert.equal(f.following.status(NODE_ROUTE)?.state, 'host-locked');
  assert.deepEqual(f.node.service.peers(), [], 'nothing to trust without the host’s device');
  await f.source.adopt(carry);
  f.following.alignAll(); await f.following.align(NODE_ROUTE);
  assert.equal(f.following.status(NODE_ROUTE)?.state, 'connected', 'nothing manual');

  await f.source.control('untrust', { id: f.node.service.device().id });
  await f.following.align(NODE_ROUTE);
  assert.equal(f.following.status(NODE_ROUTE)?.state, 'untrusted');
  assert.deepEqual(f.a.peers(), [], 'the owner’s removal stays');
  assert.equal(f.links.at(-1)!.body && Object.keys(f.links.at(-1)!.body as object).length, 0, 'nor is the host offered to the computer');
  // The owner trusts it again by hand: automatic trust works again.
  await f.source.control('trust', { device: f.node.service.device(), routeId: NODE_ROUTE, direction: 'node' });
  await f.following.align(NODE_ROUTE);
  assert.equal(f.following.status(NODE_ROUTE)?.state, 'connected');
  // The computer's owner removes the host there: that side stays removed too.
  await f.node.runtime.control('untrust', { id: f.a.device().id });
  await f.following.align(NODE_ROUTE);
  assert.equal(f.following.status(NODE_ROUTE)?.state, 'untrusted'); assert.deepEqual(f.node.service.peers(), []);
});

test('a computer that does not follow the host answers no trust request, and its vault never opens by itself', { timeout: 20000 }, async t => {
  const f = await pair(t); f.follow.host = undefined;
  assert.equal(await f.node.runtime.machineVault(), 'off');
  assert.equal(f.node.service.status().initialized, false);
  await assert.rejects(f.node.runtime.align({ routeId: HOST_ROUTE, direction: 'controller' }), { kind: 'forbidden' });
  f.follow.host = 'c'.repeat(32);
  await assert.rejects(f.node.runtime.align({ routeId: HOST_ROUTE, direction: 'controller' }), { kind: 'forbidden' }, 'nor one from another controller');
});

test('unshared host secrets are listed by name, refused with the reason, pushed once, and work after sharing with a new operation ID', { timeout: 40000 }, async t => {
  const f = await pair(t); await f.node.runtime.machineVault(); await f.following.align(NODE_ROUTE);
  const token = await f.a.create({ name: 'GITHUB_TOKEN', kind: 'scalar', value: CANARY });
  const listed = await f.relay(f.node.runtime.tool(f.capB, 'secrets_list', {})) as { secrets: (SecretMetadata & { status?: string })[]; unavailableSources: unknown[]; notice?: string };
  assert.deepEqual(listed.unavailableSources, [], 'a host that shares nothing with this folder is not unavailable');
  assert.deepEqual(listed.secrets, [{ id: token.id, name: 'GITHUB_TOKEN', kind: 'scalar', reference: token.reference, status: 'not-shared', sourceHostId: f.a.device().id }]);
  assert.match(listed.notice!, /not-shared/); assert.equal(JSON.stringify(listed).includes(CANARY), false);

  // The first request of a project nothing is shared with is refused before any task starts on the host.
  const refused = await f.run('use-1', token.reference);
  assert.equal(refused.exitCode, null); assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /SECRET_NOT_SHARED/); assert.match(refused.stderr, /새 operationId/);
  assert.deepEqual(f.source.shares().map(notice => [notice.kind, notice.nodeId, notice.hostId, notice.secretId, notice.secretName]), [['not-shared', NODE_ROUTE, f.node.service.device().id, token.id, 'GITHUB_TOKEN']]);
  // Refused again, and inside a task the host already has: the reason holds, and the owner is not told twice.
  const other = await f.a.create({ name: 'SHARED_HERE', kind: 'scalar', value: 'other', sharing: { allMachines: false, machines: [f.node.service.device().id], folders: [] } });
  assert.ok(other);
  const inTask = await f.run('use-2', token.reference);
  assert.match(inTask.stderr, /SECRET_NOT_SHARED/);
  assert.equal(f.source.shares().length, 1, 'one push per secret and computer per ten minutes');

  // The owner taps "share with this machine".
  const revision = f.a.settings().secrets.find(item => item.id === token.id)!.sharing!.revision;
  await f.a.setSharing(token.id, revision, { allMachines: false, machines: [f.node.service.device().id], folders: [] });
  const shared = await f.run('use-3', token.reference);
  assert.equal(shared.exitCode, 0); assert.match(shared.stdout, /token-present/);
  assert.deepEqual(await f.run('use-1', token.reference), refused, 'the same operation ID keeps its recorded result');
});

test('a host without the catalog, and a computer that does not follow, keep today’s lists and answers', { timeout: 30000 }, async t => {
  const f = await pair(t); await f.node.runtime.machineVault(); await f.following.align(NODE_ROUTE);
  const shared = await f.a.create({ name: 'SHARED', kind: 'scalar', value: CANARY, sharing: { allMachines: true, folders: [] } });
  const hidden = await f.a.create({ name: 'HIDDEN', kind: 'scalar', value: CANARY });
  // An older host's relay confirms only reads: no catalog, no reasons.
  const older = await f.relay(f.node.runtime.tool(f.capB, 'secrets_list', {}), ['available']) as { secrets: SecretMetadata[]; notice?: string };
  assert.deepEqual(older.secrets.map(item => item.name), ['SHARED']); assert.equal(older.notice, undefined);
  const denied = await f.relay(f.node.runtime.tool(f.capB, 'secrets_run', { operationId: 'older-host', command: process.execPath, args: ['-e', ''], env: { TOKEN: hidden.reference } }), ['available']) as SecretRunResult;
  assert.doesNotMatch(denied.stderr, /SECRET_NOT_SHARED/, 'the generic refusal, as before');
  // A computer that stopped following lists as before, even from a host that serves the catalog.
  f.follow.host = undefined;
  const notFollowing = await f.relay(f.node.runtime.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[]; notice?: string };
  assert.deepEqual(notFollowing.secrets.map(item => item.name), ['SHARED']); assert.equal(notFollowing.notice, undefined);
  assert.ok(shared);
});

test('a clone’s folder is added to the secrets of the same repository once, and not again after the owner removes it', { timeout: 30000 }, async t => {
  const f = await pair(t); await f.node.runtime.machineVault();
  const hostFolder = join(f.project, '..', 'host-repo');
  const repo = await f.a.create({ name: 'REPO_TOKEN', kind: 'scalar', value: CANARY, sharing: { allMachines: false, folders: [{ hostId: f.a.device().id, root: hostFolder }] } });
  const following = new FollowingSecrets({ controller: { list: () => [{ id: NODE_ROUTE, name: 'n', fingerprint: 'f', status: 'connected', features: [SECRET_MACHINES_FEATURE], pairedAt: '', followHost: true }], following: () => true, on: () => undefined },
    worker: { supports: () => true, secretCall: async (operation: string, args: unknown[] = []) => operation === 'peers' ? f.source.peers() : operation === 'shared-folders' ? f.source.sharedFolders() : operation === 'auto-share' ? f.source.autoShare(args[0]) : f.source.align(args[0]) },
    link: async (_id, _path, body) => ({ status: 200, json: await f.node.runtime.align({ routeId: HOST_ROUTE, direction: 'controller', ...body as object }) }),
    canonical: async (_id, path) => `/real${path}`, repository: async root => root === hostFolder ? 'github.com/kimwz/repo' : undefined });
  const folders = [{ cwd: '/clones/repo', remoteUrl: 'github.com/kimwz/repo' }, { cwd: '/clones/other', remoteUrl: 'github.com/kimwz/other' }, { cwd: '/scratch' }];
  await following.shareFolders(NODE_ROUTE, folders);
  assert.deepEqual(f.a.settings().secrets[0]!.sharing?.folders, [{ hostId: f.a.device().id, root: hostFolder }], 'not before the computer is trusted');
  await following.align(NODE_ROUTE);
  await following.shareFolders(NODE_ROUTE, folders);
  const node = f.node.service.device().id;
  assert.deepEqual(f.a.settings().secrets[0]!.sharing?.folders, [{ hostId: f.a.device().id, root: hostFolder }, { hostId: node, root: '/real/clones/repo' }]);
  await following.shareFolders(NODE_ROUTE, folders);
  assert.equal(f.a.settings().secrets[0]!.sharing?.revision, 2, 'once');
  await f.a.setSharing(repo.id, 2, { allMachines: false, folders: [{ hostId: f.a.device().id, root: hostFolder }] });
  await following.shareFolders(NODE_ROUTE, folders);
  assert.deepEqual(f.a.settings().secrets[0]!.sharing?.folders, [{ hostId: f.a.device().id, root: hostFolder }], 'the owner’s removal stays');
});
