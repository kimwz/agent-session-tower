import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ControllerLinks } from '../../../server/link/controller.js';
import { NodeLinks } from '../../../server/link/node.js';
import { loadLinkIdentity } from '../../../server/link/identity.js';
import type { UpdateStatus } from '../../../shared/link.js';
import { decodeJoinCode, encodeJoinCode } from '../../../server/link/join-code.js';
import { until } from '../../helpers/until.js';

// The existing product link transports and private state, on loopback; no external network or new provider harness.
test('controller consumes the typed prerequisite report, durably bounds requests and asks the target after preparation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-consumer-chain-'));
  const controllerDir = join(root, 'controller'); const nodeDir = join(root, 'node');
  const identity = await loadLinkIdentity(controllerDir);
  let clock = Date.now();
  let controller = new ControllerLinks({ stateDir: controllerDir, identity, version: '1.3.0', hostname: () => 'controller', refreshMs: 25, updatePollMs: 25, now: () => clock });
  let running = '1.0.0'; let update: UpdateStatus | undefined;
  const asked: string[] = [];
  const node = new NodeLinks({ stateDir: nodeDir, identity: await loadLinkIdentity(nodeDir), version: '1.0.0', hostname: () => 'node', features: () => ['status', 'update'], update: {
    report: async () => ({ versions: { web: running }, service: true, ...(update ? { update } : {}) }),
    request: async version => {
      const target = String(version); asked.push(target);
      const at = new Date(clock + asked.length).toISOString();
      if (target === '1.3.0' && running === '1.0.0') update = { version: target, previous: running, stage: 'failed', code: 'check-failed', startedAt: at, updatedAt: at, storage: { code: 'prerequisite-required', prepare: '1.2.0', domains: ['retention'] } };
      else { running = target; update = { version: target, previous: '1.0.0', stage: 'done', startedAt: at, updatedAt: at }; }
      return { status: 202, body: { update } };
    },
  }, handle: (_req, res) => { res.writeHead(404); res.end(); } });
  await controller.start(); await node.start();
  t.after(async () => { await node.close(); await controller.close(); await rm(root, { recursive: true, force: true }); });
  await controller.setHub({ enabled: true, port: 0, bind: '127.0.0.1' });
  await controller.setHub({ custom: [`ws://127.0.0.1:${controller.hub().port}/tower-link`] });
  const code = decodeJoinCode((await controller.invite()).code);
  await node.join(encodeJoinCode({ ...code, addresses: [`ws://127.0.0.1:${controller.hub().port}/tower-link`] }));
  await until(() => running === '1.3.0', 10000);
  assert.deepEqual(asked, ['1.3.0', '1.2.0', '1.3.0']);
  await until(() => controller.list()[0]?.updateChain?.state === 'done');
  const state = controller.list()[0]!.updateChain!;
  assert.equal(state.prerequisite, '1.2.0');
  assert.deepEqual(state.attempts, { '1.3.0': 2, '1.2.0': 1 });
  // Persisted consumer state carries the learned release rather than dropping it at the shared DTO boundary.
  assert.ok((await readFile(join(controllerDir, 'link', 'controller.json'), 'utf8')).includes('1.2.0'));
  clock += 24 * 60 * 60 * 1000;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(asked.length, 3);
});
