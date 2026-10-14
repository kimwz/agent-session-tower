import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SECRET_OPERATIONS, type SecretPeer, type SecretTask } from '../../../shared/secrets.js';
import { catalog, decide, readSharing, servedHosts, storedSharing, type PolicySecret, type PolicyState } from '../../../server/secrets/policy.js';
import { kindOf } from '../../../shared/errors.js';
import { editPayload, stored, vaultTemplate, type StoredPayload } from '../../helpers/secrets.js';

const NOW = 1_000_000;
const HOST = '11111111-1111-4111-8111-111111111111', NODE = '22222222-2222-4222-8222-222222222222', OTHER = '33333333-3333-4333-8333-333333333333';
const peer = (id: string, direction: SecretPeer['direction'] = 'node'): SecretPeer => ({ device: { id, name: id, signingKey: '', encryptionKey: '', fingerprint: '' }, routeId: `route-${id}`, direction, enabled: true });
const secret = (id: string, sharing?: PolicySecret['sharing']): PolicySecret => ({ metadata: { id, name: id, groupId: 'tower', kind: 'scalar', version: 1, reference: `tower-secret://${HOST}/${id}@1` }, ...(sharing ? { sharing } : {}) });
const task = (patch: Partial<SecretTask> = {}): SecretTask => ({ id: 'task', hostId: HOST, sessionId: 'session', root: '/work/repo', status: 'open', createdAt: NOW - 10, excluded: [], connected: [], ...patch });
const state = (secrets: PolicySecret[]): PolicyState => ({ deviceId: HOST, servedHosts: servedHosts(HOST, [peer(NODE), peer(OTHER)]), projects: [], groups: [{ id: 'tower', name: 'Tower', scope: 'global' }], rules: [], secrets, tasks: [] });
const bases = (policy: PolicyState, subject: SecretTask, item: PolicySecret) => decide(policy, subject, item, 'env', NOW)?.basis;

test('sharing saved by 1.136 and earlier ({ global }) decides exactly as before: GLOBAL is all machines', () => {
  for (const global of [true, false]) {
    const legacy = secret('legacy', { revision: 4, global, folders: [{ hostId: NODE, root: '/node/repo' }] });
    assert.deepEqual(readSharing(legacy.sharing!), { revision: 4, allMachines: global, machines: [], folders: [{ hostId: NODE, root: '/node/repo' }] });
    const policy = state([legacy]);
    for (const [hostId, root] of [[HOST, '/work/repo'], [NODE, '/elsewhere'], [OTHER, '/x']] as const) assert.deepEqual(bases(policy, task({ hostId, root }), legacy), global ? ['global'] : undefined, `${global} ${hostId}`);
    assert.deepEqual(bases(policy, task({ hostId: NODE, root: '/node/repo' }), legacy), global ? ['global', 'folder'] : ['folder']);
    assert.equal(bases(policy, task({ hostId: 'not-served' }), legacy), undefined);
  }
});

test('a computer shared as a whole uses the secret in all its folders, and no other computer does', () => {
  const machine = secret('machine', storedSharing({ revision: 1, allMachines: false, machines: [NODE], folders: [] })); const policy = state([machine]);
  for (const root of ['/node/repo', '/node/other', '/']) assert.deepEqual(bases(policy, task({ hostId: NODE, root }), machine), ['machine'], root);
  for (const hostId of [HOST, OTHER, 'unknown']) assert.equal(bases(policy, task({ hostId }), machine), undefined, hostId);
  for (const operation of SECRET_OPERATIONS) assert.ok(decide(policy, task({ hostId: NODE }), machine, operation, NOW), operation);
  const folders = secret('folders', storedSharing({ revision: 1, allMachines: false, machines: [], folders: [{ hostId: NODE, root: '/node/repo' }] }));
  assert.deepEqual(bases(state([folders]), task({ hostId: NODE, root: '/node/repo' }), folders), ['folder'], 'folder sharing is unchanged');
  assert.equal(bases(state([folders]), task({ hostId: NODE, root: '/node/repo/sub' }), folders), undefined);
});

test('the saved form keeps `global` equal to all machines, so a build rolled back to allows the same or less, never more', () => {
  for (const sharing of [{ revision: 1, allMachines: true, machines: [], folders: [] }, { revision: 2, allMachines: false, machines: [NODE], folders: [] }]) {
    const saved = storedSharing(sharing);
    assert.equal(saved.global, sharing.allMachines);
    // What a build before machine sharing decides: GLOBAL and folders only.
    const older = (subject: SecretTask) => (saved.global && state([]).servedHosts.includes(subject.hostId)) || saved.folders.some(folder => folder.hostId === subject.hostId && folder.root === subject.root);
    for (const subject of [task(), task({ hostId: NODE }), task({ hostId: OTHER })]) if (older(subject)) assert.ok(bases(state([secret('s', saved)]), subject, secret('s', saved)), 'never more than this build');
    assert.equal(older(task({ hostId: NODE })), sharing.allMachines, 'a computer shared alone is not shared there');
  }
});

test('the catalog names every secret with its reference and whether this task may use it, never a value or field', () => {
  const shared = secret('shared', storedSharing({ revision: 1, allMachines: false, machines: [NODE], folders: [] }));
  const unshared = { ...secret('unshared', storedSharing({ revision: 1, allMachines: false, machines: [], folders: [] })), fieldNames: ['A'], metadata: { ...secret('unshared').metadata, kind: 'env' as const, reference: `tower-secret://${HOST}/unshared@3`, fields: ['A'] } };
  const expired = { ...secret('expired'), metadata: { ...secret('expired').metadata, expiresAt: NOW } };
  assert.deepEqual(catalog(state([shared, unshared, expired]), task({ hostId: NODE }), NOW), [
    { id: 'shared', name: 'shared', kind: 'scalar', reference: `tower-secret://${HOST}/shared@1`, status: 'available' },
    { id: 'unshared', name: 'unshared', kind: 'env', reference: `tower-secret://${HOST}/unshared@3`, status: 'not-shared' }]);
});

const template = vaultTemplate('fixture-machine-sharing-password');
before(() => template.ready());
after(() => template.dispose());
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-machine-sharing-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDir = join(directory, 'state'); await mkdir(stateDir);
  const service = await template.open(stateDir);
  const node = { ...service.device(), id: randomUUID() };
  return { stateDir, service, host: service.device().id, node, trust: () => service.trustPeer({ device: node, routeId: 'node-link', direction: 'node', enabled: true }) };
}
const refusal = (kind: string) => (error: Error) => kindOf(error) === kind;

test('machine sharing is validated, revisioned and kept for a computer no longer trusted, like folders', async t => {
  const f = await fixture(t);
  const created = await f.service.create({ name: 'key', kind: 'scalar', value: 'v', sharing: { allMachines: false, machines: [f.host], folders: [] } });
  assert.deepEqual(f.service.settings().secrets[0]!.sharing, { revision: 1, allMachines: false, machines: [f.host], folders: [] });
  await assert.rejects(f.service.setSharing(created.id, 1, { allMachines: false, machines: [f.node.id], folders: [] }), refusal('invalid'), 'an untrusted computer');
  await f.trust();
  const saved = await f.service.setSharing(created.id, 1, { allMachines: false, machines: [f.node.id, f.node.id], folders: [] });
  assert.deepEqual(saved, { revision: 2, allMachines: false, machines: [f.node.id], folders: [] });
  await assert.rejects(f.service.setSharing(created.id, 1, { allMachines: true, folders: [] }), refusal('conflict'), 'a stale revision is refused');
  await f.service.removePeer(f.node.id);
  assert.deepEqual((await f.service.setSharing(created.id, 2, { allMachines: false, machines: [f.node.id], folders: [] })).machines, [f.node.id], 'kept until the owner removes it');
  await assert.rejects(f.service.setSharing(created.id, 3, { allMachines: false, machines: [f.node.id, randomUUID()], folders: [] }), refusal('invalid'));
  await assert.rejects(f.service.create({ name: 'pasted', kind: 'scalar', value: 't', temporary: true, sharing: { allMachines: false, machines: [f.host], folders: [] } }, await f.service.ensureTask('session', '/p')), refusal('invalid'));
  const payload = await f.service.vault.decryptImport((await f.service.exportEncryptedVault())!, 'fixture-machine-sharing-password') as StoredPayload;
  assert.deepEqual(payload.secrets[0]!.sharing, { revision: 3, allMachines: false, machines: [f.node.id], folders: [], global: false });
  assert.deepEqual(stored(f.service).secrets[0]!.sharing, { revision: 3, allMachines: false, machines: [f.node.id], folders: [], global: false }, 'the plaintext index too');
});

test('a vault saved by 1.136 opens with its GLOBAL keys shared with all machines, and saves them in both forms', async t => {
  const f = await fixture(t); await f.trust();
  const id = randomUUID();
  await editPayload(f.service, payload => { payload.secrets.push({ metadata: { id, name: 'old', groupId: (payload.towerGroupId as string | undefined) ?? 'tower', kind: 'scalar', version: 1, reference: `tower-secret://${f.host}/${id}@1` }, value: 'old-value', sharing: { revision: 5, global: true, folders: [] } }); });
  assert.deepEqual(f.service.settings().secrets.find(item => item.id === id)?.sharing, { revision: 5, allMachines: true, machines: [], folders: [] });
  const nodeTask = { hostId: f.node.id, sessionId: 'node-session', root: '/node/repo', taskId: randomUUID(), runId: 'node-run' };
  assert.deepEqual(f.service.availableFor(nodeTask).map(item => [item.name, item.basis]), [['old', ['global']]]);
  await f.service.setSharing(id, 5, { allMachines: false, machines: [f.node.id], folders: [] });
  assert.deepEqual(f.service.availableFor(nodeTask).map(item => [item.name, item.basis]), [['old', ['machine']]]);
  assert.deepEqual(f.service.available({ sessionId: 'here', root: '/work' }), [], 'not on this computer');
  assert.equal(f.service.machineShared(f.node.id), 1); assert.equal(f.service.machineShared(randomUUID()), 0);
});

test('automatic trust keeps a removal by the owner, replaces a vault made again on the same link, and saves only on change', async t => {
  const f = await fixture(t);
  const route = { routeId: 'node-link', direction: 'node' as const };
  assert.equal(await f.service.alignPeer({ device: f.node, ...route, enabled: true }), true);
  const journal = await readFile(join(f.stateDir, 'secrets', 'vault.json'));
  assert.equal(await f.service.alignPeer({ device: f.node, ...route, enabled: true }), true);
  assert.deepEqual(await readFile(join(f.stateDir, 'secrets', 'vault.json')), journal, 'nothing changed, nothing written');
  const remade = { ...f.node, id: randomUUID() };
  assert.equal(await f.service.alignPeer({ device: remade, ...route, enabled: true }), true);
  assert.deepEqual(f.service.peers().map(item => item.device.id), [remade.id], 'one vault per link route');
  await assert.rejects(f.service.alignPeer({ device: { ...remade, signingKey: 'other' }, ...route, enabled: true }), /Peer key changed/);
  await f.service.removePeer(remade.id);
  assert.equal(f.service.untrustedRoute(route), true);
  assert.equal(await f.service.alignPeer({ device: remade, ...route, enabled: true }), false, 'the owner removed it: not trusted again by itself');
  assert.deepEqual(f.service.peers(), []);
  await f.service.trustPeer({ device: remade, ...route, enabled: true });
  assert.equal(f.service.untrustedRoute(route), false, 'trusting it by hand lifts the removal');
});

test('a clone’s folder joins the sharing of secrets shared with a folder of the same repository once, and stays out once removed', async t => {
  const f = await fixture(t);
  const secret = await f.service.create({ name: 'repo-token', kind: 'scalar', value: 'v', sharing: { allMachines: false, folders: [{ hostId: f.host, root: '/work/repo' }] } });
  assert.deepEqual(f.service.sharedFolders(), [{ secretId: secret.id, root: '/work/repo' }]);
  assert.equal(await f.service.autoShareFolders(f.node.id, [{ secretId: secret.id, root: '/node/repo' }]), 0, 'only for a trusted node');
  await f.trust();
  assert.equal(await f.service.autoShareFolders(f.node.id, [{ secretId: secret.id, root: '/node/repo' }, { secretId: 'missing', root: '/node/repo' }, { secretId: secret.id, root: 'relative' }]), 1);
  assert.deepEqual(f.service.settings().secrets[0]!.sharing, { revision: 2, allMachines: false, machines: [], folders: [{ hostId: f.host, root: '/work/repo' }, { hostId: f.node.id, root: '/node/repo' }] });
  assert.equal(await f.service.autoShareFolders(f.node.id, [{ secretId: secret.id, root: '/node/repo' }]), 0, 'once');
  await f.service.setSharing(secret.id, 2, { allMachines: false, folders: [{ hostId: f.host, root: '/work/repo' }] });
  assert.equal(await f.service.autoShareFolders(f.node.id, [{ secretId: secret.id, root: '/node/repo' }]), 0, 'a folder the owner removed is not added back');
  assert.deepEqual(f.service.settings().secrets[0]!.sharing?.folders, [{ hostId: f.host, root: '/work/repo' }]);
});
