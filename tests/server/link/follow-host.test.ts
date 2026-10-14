import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControllerLinks } from '../../../server/link/controller.js';
import { NodeLinks } from '../../../server/link/node.js';
import { FollowedHostStore } from '../../../server/link/follow.js';
import { ManagedSettingsReceiver, ManagedSettingsSync, canonicalJson, managedRevision } from '../../../server/link/managed-settings.js';
import { loadLinkIdentity } from '../../../server/link/identity.js';
import { linkRequest } from '../../../server/link/transport.js';
import { followedHostOrigin } from '../../../server/runs/origin.js';
import { until } from '../../helpers/until.ts';

/** A Tower with both link ends, the follow store and the managed-settings ends, as server/index.ts wires them. */
async function computer(t: TestContext, name: string, options: { features?: string[]; refreshMs?: number; syncMs?: number } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), `tower-follow-${name}-`));
  const identity = await loadLinkIdentity(stateDir);
  const follow = new FollowedHostStore(stateDir);
  await follow.start();
  const receiver = new ManagedSettingsReceiver({ stateDir, follow, folders: async () => [{ cwd: '/work/app', remoteUrl: 'github.com/kimwz/app' }] });
  await receiver.start();
  let sync: ManagedSettingsSync | undefined;
  const controller = new ControllerLinks({ stateDir, identity, version: '1.137.0', hostname: () => name, refreshMs: options.refreshMs, managed: id => sync?.status(id) });
  sync = new ManagedSettingsSync({ controller, syncMs: options.syncMs ?? 60_000 });
  const node = new NodeLinks({ stateDir, identity, version: '1.137.0', hostname: () => name, follow, refreshMs: options.refreshMs,
    features: () => options.features ?? ['work', 'followHost', 'managedSettings'],
    handle: async (req, res, principal) => {
      if (await receiver.handle(req, res, principal)) return;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    } } as ConstructorParameters<typeof NodeLinks>[0]);
  await controller.start();
  await node.start();
  sync.start();
  const self = {
    name, stateDir, identity, follow, receiver, controller, node, sync,
    async listen() {
      await controller.setHub({ enabled: true, port: 0, bind: '127.0.0.1' });
      await controller.setHub({ custom: [`ws://127.0.0.1:${controller.hub().port}/tower-link`] });
    },
  };
  t.after(async () => { sync?.close(); await node.close(); await controller.close(); await rm(stateDir, { recursive: true, force: true }); });
  return self;
}

async function join2(a: Awaited<ReturnType<typeof computer>>, b: Awaited<ReturnType<typeof computer>>) {
  await a.listen();
  await b.node.join((await a.controller.invite()).code);
  return until(() => a.controller.list().find(node => node.name === b.name && node.status === 'connected'), 20_000);
}

test('the follow store keeps one controller, written owner-only, and reads anything else as following nobody', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-follow-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FollowedHostStore(dir);
  await store.start();
  assert.equal(store.hostId(), undefined);
  await store.set('a'.repeat(32));
  assert.equal(store.hostId(), 'a'.repeat(32));
  assert.equal((await stat(join(dir, 'link', 'followed-host.json'))).mode & 0o777, 0o600);
  const other = new FollowedHostStore(dir);
  assert.equal(await other.reload(), 'a'.repeat(32));
  await writeFile(join(dir, 'link', 'followed-host.json'), JSON.stringify({ hostId: 'NOT A CONTROLLER' }), { mode: 0o600 });
  assert.equal(await other.reload(), undefined);
  await assert.rejects(store.set('../x'));
  await store.set(undefined);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'link', 'followed-host.json'), 'utf8')), {});
});

test('only work the followed controller started counts as the followed host\'s', () => {
  const host = 'b'.repeat(32);
  assert.equal(followedHostOrigin({ controllerId: host }, host), true);
  assert.equal(followedHostOrigin({ controllerId: 'c'.repeat(32) }, host), false);
  assert.equal(followedHostOrigin({}, host), false);
  assert.equal(followedHostOrigin(undefined, host), false);
  assert.equal(followedHostOrigin({ controllerId: host }, undefined), false);
});

test('a computer joined now follows its controller; the owner turns it off and on; removing the controller ends it', async t => {
  const a = await computer(t, 'host-a');
  const b = await computer(t, 'node-b');
  const joined = await join2(a, b);
  assert.equal(joined.followHost, true);
  await until(() => b.follow.hostId() === a.identity.id ? true : undefined, 10_000);
  await until(() => a.controller.list().find(node => node.id === joined.id)?.following ? true : undefined, 10_000);
  assert.equal(b.node.list()[0]!.followed, true);
  await a.controller.setFollowHost(joined.id, false);
  assert.equal(b.follow.hostId(), undefined);
  assert.equal(a.controller.list()[0]!.followHost, false);
  assert.equal(a.controller.list()[0]!.following, false);
  await a.controller.setFollowHost(joined.id, true);
  assert.equal(b.follow.hostId(), a.identity.id);
  await b.node.remove(a.identity.id);
  assert.equal(b.follow.hostId(), undefined);
});

test('a second controller does not take a computer by itself; the owner\'s switch there does', async t => {
  const a = await computer(t, 'host-a');
  const c = await computer(t, 'host-c', { refreshMs: 200 });
  const b = await computer(t, 'node-b');
  await join2(a, b);
  await until(() => b.follow.hostId() === a.identity.id ? true : undefined, 10_000);
  const fromC = await join2(c, b);
  // C wants it too (joined now), but B already follows A: C's refresh never asks.
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(b.follow.hostId(), a.identity.id);
  assert.equal(c.controller.list().find(node => node.id === fromC.id)?.following, false);
  await c.controller.setFollowHost(fromC.id, true);
  assert.equal(b.follow.hostId(), c.identity.id);
});

test('an older computer without the feature is never asked to follow', async t => {
  const a = await computer(t, 'host-a');
  const b = await computer(t, 'node-b', { features: ['work'] });
  const joined = await join2(a, b);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(b.follow.hostId(), undefined);
  assert.equal(a.controller.list().find(node => node.id === joined.id)?.following, false);
});

test('settings reach a following computer section by section; a failing section keeps its value and is reported', async t => {
  const a = await computer(t, 'host-a');
  const b = await computer(t, 'node-b');
  const applied: Array<{ section: string; value: unknown; hostId: string }> = [];
  let models: unknown = { roles: { 'reviewer.codex': 'x' } };
  a.sync.register('models', async () => models);
  a.sync.register('skills', async () => ({ skills: [] }));
  a.sync.register('permissions', async () => { throw new Error('worker unavailable'); });
  b.receiver.register('models', async (value, context) => { applied.push({ section: 'models', value, hostId: context.hostId }); });
  let diskFull = true;
  b.receiver.register('skills', async () => { if (diskFull) throw new Error('disk full'); });
  const joined = await join2(a, b);
  await until(() => a.sync.status(joined.id)?.applied ? true : undefined, 10_000);
  const status = a.sync.status(joined.id)!;
  assert.deepEqual(applied, [{ section: 'models', value: models, hostId: a.identity.id }]);
  assert.deepEqual(status.applied!.errors, { skills: 'disk full' });
  assert.equal(status.applied!.revision, managedRevision({ models, skills: { skills: [] } }));
  assert.deepEqual(a.controller.list()[0]!.managed?.applied?.revision, status.applied!.revision);
  assert.equal((await stat(join(b.stateDir, 'managed', 'applied.json'))).mode & 0o777, 0o600);
  // A section that failed is sent again; once all applied, unchanged settings are not, and a change is.
  diskFull = false;
  await a.sync.schedule(joined.id);
  assert.equal(applied.length, 2);
  assert.equal(a.sync.status(joined.id)!.applied!.errors, undefined);
  await a.sync.schedule(joined.id);
  assert.equal(applied.length, 2);
  models = { roles: { 'reviewer.codex': 'y' } };
  await a.sync.schedule(joined.id);
  assert.equal(applied.length, 3);
  assert.deepEqual(applied[2]!.value, models);
});

test('only the followed controller is answered on the managed routes', async t => {
  const a = await computer(t, 'host-a');
  const b = await computer(t, 'node-b');
  const joined = await join2(a, b);
  await until(() => a.controller.following(joined.id) ? true : undefined, 10_000);
  assert.deepEqual(await a.sync.refreshFolders(joined.id), [{ cwd: '/work/app', remoteUrl: 'github.com/kimwz/app' }]);
  await a.controller.setFollowHost(joined.id, false);
  const answer = await linkRequest(a.controller.session(joined.id)!, 'PUT', '/api/managed/settings', { revision: 'r', sections: {} });
  assert.equal(answer.status, 403);
  const folders = await linkRequest(a.controller.session(joined.id)!, 'GET', '/api/managed/folders');
  assert.equal(folders.status, 403);
});

test('canonical JSON ignores key order, so the revision follows content only', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] }), '{"a":[{"d":2}],"b":1}');
  assert.equal(managedRevision({ models: { x: 1, y: 2 } }), managedRevision({ models: { y: 2, x: 1 } }));
});

test('a computer that still follows after the owner turned it off (a missed change) is told again on the next refresh', async t => {
  const a = await computer(t, 'host-a', { refreshMs: 200 });
  const b = await computer(t, 'node-b');
  const joined = await join2(a, b);
  await until(() => b.follow.hostId() === a.identity.id ? true : undefined, 10_000);
  await a.controller.setFollowHost(joined.id, false);
  // As if the "off" never reached it.
  await b.follow.set(a.identity.id);
  await until(() => b.follow.hostId() === undefined ? true : undefined, 10_000);
});

test('a payload from a Tower this computer stopped following while it waited is not applied', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-follow-apply-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const follow = new FollowedHostStore(dir);
  await follow.set('a'.repeat(32));
  const receiver = new ManagedSettingsReceiver({ stateDir: dir, follow, folders: async () => [] });
  let release: (() => void) | undefined;
  const applied: string[] = [];
  receiver.register('models', async value => { applied.push(String(value)); await new Promise<void>(resolve => { release = resolve; }); });
  const first = receiver.apply({ revision: '1', sections: { models: 'from-a' } }, 'a'.repeat(32));
  const second = receiver.apply({ revision: '2', sections: { models: 'from-a-again' } }, 'a'.repeat(32));
  await until(() => release ? true : undefined, 2000);
  await follow.set('c'.repeat(32));
  release!();
  assert.equal((await first)?.revision, '1');
  assert.equal(await second, undefined);
  assert.deepEqual(applied, ['from-a']);
});

test('a URL with broken escapes is no repository rather than an error', async () => {
  const { normalizeRemoteUrl } = await import('../../../server/repositories/remote-url.js');
  assert.equal(normalizeRemoteUrl('https://git.example.com/team/percent%.git'), undefined);
});

test('the followed Tower is left the pushes for the work it sent only while it keeps syncing', async () => {
  const { announcingHost } = await import('../../../server/link/managed-settings.js');
  const host = 'a'.repeat(32), now = Date.parse('2026-10-15T00:30:00Z');
  assert.equal(announcingHost(host, { revision: 'r', appliedAt: '2026-10-15T00:25:00Z' }, now), host);
  assert.equal(announcingHost(host, { revision: 'r', appliedAt: '2026-10-15T00:05:00Z' }, now), undefined, 'an older or silent host: announced here');
  assert.equal(announcingHost(host, undefined, now), undefined, 'never synced: announced here');
  assert.equal(announcingHost(undefined, { revision: 'r', appliedAt: '2026-10-15T00:25:00Z' }, now), undefined);
});
