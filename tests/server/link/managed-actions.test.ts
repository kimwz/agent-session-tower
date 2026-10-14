import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControllerLinks } from '../../../server/link/controller.js';
import { NodeLinks } from '../../../server/link/node.js';
import { FollowedHostStore } from '../../../server/link/follow.js';
import { ManagedSettingsReceiver, ManagedSettingsSync } from '../../../server/link/managed-settings.js';
import { loadLinkIdentity } from '../../../server/link/identity.js';
import { linkRequest } from '../../../server/link/transport.js';
import { cloneAction } from '../../../server/repositories/clone.js';
import type { GitRunner } from '../../../server/repositories/git.js';
import { localRemotes } from '../../helpers/git-remotes.js';
import { until } from '../../helpers/until.ts';

/** A Tower with both link ends and the managed-settings ends, the clone action registered as server/index.ts does. */
async function computer(t: TestContext, name: string, clone?: { workspace: string; git: GitRunner; registered: string[] }) {
  const stateDir = await mkdtemp(join(tmpdir(), `tower-managed-actions-${name}-`));
  const identity = await loadLinkIdentity(stateDir);
  const follow = new FollowedHostStore(stateDir);
  await follow.start();
  const receiver = new ManagedSettingsReceiver({ stateDir, follow, folders: async () => clone?.registered.map(cwd => ({ cwd })) ?? [] });
  await receiver.start();
  if (clone) receiver.action('clone', cloneAction({ register: async cwd => { clone.registered.push(cwd); }, workspace: clone.workspace, git: clone.git }));
  let sync: ManagedSettingsSync | undefined;
  const controller = new ControllerLinks({ stateDir, identity, version: '1.137.0', hostname: () => name, managed: id => sync?.status(id) });
  sync = new ManagedSettingsSync({ controller });
  const node = new NodeLinks({ stateDir, identity, version: '1.137.0', hostname: () => name, follow,
    features: () => ['work', 'followHost', 'managedSettings'],
    handle: async (req, res, principal) => {
      if (await receiver.handle(req, res, principal)) return;
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
    } } as ConstructorParameters<typeof NodeLinks>[0]);
  await controller.start();
  await node.start();
  sync.start();
  t.after(async () => { sync?.close(); await node.close(); await controller.close(); await rm(stateDir, { recursive: true, force: true }); });
  return {
    name, identity, follow, controller, node, sync,
    async join(other: { node: NodeLinks; name: string }) {
      await controller.setHub({ enabled: true, port: 0, bind: '127.0.0.1' });
      await controller.setHub({ custom: [`ws://127.0.0.1:${controller.hub().port}/tower-link`] });
      await other.node.join((await controller.invite()).code);
      return until(() => controller.list().find(item => item.name === other.name && item.status === 'connected'), 20_000);
    },
  };
}

test('the followed host clones a repository on the computer over the link; any other controller is refused', async t => {
  const { workspace, git } = await localRemotes(t, ['app']);
  const registered: string[] = [];
  const host = await computer(t, 'host-a');
  const other = await computer(t, 'host-c');
  const node = await computer(t, 'node-b', { workspace, git, registered });
  const joined = await host.join(node);
  await until(() => node.follow.hostId() === host.identity.id ? true : undefined, 10_000);
  await until(() => host.controller.list().find(item => item.id === joined.id)?.following ? true : undefined, 10_000);

  const answer = await host.sync.request(joined.id, 'clone', { url: 'https://github.com/kimwz/app' }, 60_000);
  assert.deepEqual(answer, { cwd: join(workspace, 'app'), remoteUrl: 'github.com/kimwz/app' });
  assert.deepEqual(registered, [join(workspace, 'app')]);
  assert.deepEqual(await host.sync.refreshFolders(joined.id), [{ cwd: join(workspace, 'app') }], 'its folder list follows');

  // A refusal there comes back as it was decided.
  await assert.rejects(host.sync.request(joined.id, 'clone', { url: '/etc' }, 60_000), (error: Error & { kind?: string }) => error.kind === 'invalid' && /저장소 주소가 올바르지 않습니다/.test(error.message));

  // Another controller of the same computer, which it does not follow, cannot ask.
  const fromOther = await other.join(node);
  const refused = await linkRequest(other.controller.session(fromOther.id)!, 'POST', '/api/managed/clone', { url: 'https://github.com/kimwz/app' });
  assert.equal(refused.status, 403);
  await assert.rejects(other.sync.request(fromOther.id, 'clone', { url: 'https://github.com/kimwz/app' }, 60_000), /이 Tower의 설정을 따를 때만/);
  // Nor can the host once the owner turned following off.
  await host.controller.setFollowHost(joined.id, false);
  await assert.rejects(host.sync.request(joined.id, 'clone', { url: 'https://github.com/kimwz/app' }, 60_000), /이 Tower의 설정을 따를 때만/);
  assert.equal(registered.length, 1);
});
