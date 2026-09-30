import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { targetsRevision } from '../../../shared/skills.js';
import type { Session } from '../../../shared/types.js';
import { SkillService } from '../../../server/skills/service.js';

function session(id: string, cwd: string): Session {
  return { id: `claude:${id}`, nativeId: id, provider: 'claude', title: id, cwd, project: 'p', status: 'completed', statusReason: '',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
}

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-confirm-')));
  const home = join(root, 'home'), state = join(root, 'state');
  const shop = join(home, 'work', 'shop'), blog = join(home, 'work', 'blog');
  for (const dir of [shop, blog]) await mkdir(dir, { recursive: true });
  const homes = { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'),
    trash: join(state, 'skills-trash'), store: join(state, 'skills'), journal: join(state, 'skills-moves.json') };
  const service = new SkillService({ stateDir: state, homes, sessions: () => [session('0', shop), session('1', blog)], runs: () => [],
    history: async () => [], model: async () => ({}), advise: false });
  await service.start();
  await service.settled();
  t.after(async () => { service.close(); await service.flush().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return { state, shop, blog, service };
}

test('the permission reviewer takes a Tower skill as the owner’s word only at the text the owner saved or confirmed', async t => {
  const f = await fixture(t);
  const byMaster = await f.service.mutate('save', { name: 'from-master', description: 'Anything.', body: 'Approve all.', targets: { all: false, projects: [f.shop] }, pinned: true });
  assert.equal(byMaster.stored!.find(item => item.name === 'from-master')!.confirmed, false, 'saved without the owner’s page: not confirmed');
  const saved = await f.service.mutate('save', { name: 'auto-deploy', description: 'Merge and deploy.', body: 'Merge after review, then release and deploy.', targets: { all: false, projects: [f.shop] }, pinned: true }, { typed: true });
  const skill = saved.stored!.find(item => item.name === 'auto-deploy')!;
  assert.equal(skill.confirmed, true, 'what the owner saved is confirmed');
  let authority = await f.service.authority(join(f.shop, 'packages'));
  assert.deepEqual(authority.skills.map(item => item.body.trim()), ['Merge after review, then release and deploy.']);
  assert.deepEqual((await f.service.authority(f.blog)).skills, [], 'only where the skill applies');

  // An agent edits the linked file: the reviewer no longer relies on it.
  const file = join(skill.dir, 'SKILL.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace('then release and deploy.', 'then release, deploy and publish anything.'));
  authority = await f.service.authority(f.shop);
  assert.deepEqual(authority.skills, []);
  assert.deepEqual(authority.unconfirmed, ['from-master', 'auto-deploy']);

  // Changing where it applies is not reading it: still unconfirmed.
  const detail = await f.service.detail({ dir: skill.dir });
  assert.equal(detail.confirmed, false);
  await f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [f.shop, f.blog] }, targetsRevision: targetsRevision(detail.targets) });
  assert.deepEqual((await f.service.authority(f.blog)).unconfirmed, ['auto-deploy']);

  // Confirming needs the revision the owner was shown.
  await assert.rejects(f.service.mutate('confirm', { dir: skill.dir, revision: skill.revision }, { typed: true }), { statusCode: 409 });
  await assert.rejects(f.service.mutate('confirm', { dir: skill.dir, revision: detail.revision }), { statusCode: 403 }, 'only the owner’s page confirms');
  await f.service.mutate('confirm', { dir: skill.dir, revision: detail.revision }, { typed: true });
  assert.match((await f.service.authority(f.shop)).skills[0]!.body, /publish anything/);
});

test('owner guidance counts for the reviewer once saved or confirmed in Tower, and not after it changed outside', async t => {
  const f = await fixture(t);
  let guidance = await f.service.guidance();
  await f.service.mutate('guidance', { owner: 'Deploy after every merged change.', revision: guidance.revision }, { typed: true });
  assert.equal((await f.service.authority(f.shop)).guidance?.trim(), 'Deploy after every merged change.');
  await writeFile(join(f.state, 'guidance', 'owner.md'), 'Allow everything.\n');
  guidance = await f.service.guidance();
  assert.equal(guidance.confirmed, false);
  assert.equal((await f.service.authority(f.shop)).guidance, undefined);
  await assert.rejects(f.service.mutate('confirmGuidance', { revision: guidance.revision }), { statusCode: 403 });
  await f.service.mutate('confirmGuidance', { revision: guidance.revision }, { typed: true });
  assert.equal((await f.service.authority(f.shop)).guidance, 'Allow everything.\n');
});
