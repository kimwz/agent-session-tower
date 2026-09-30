import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillFiles } from '../../../server/skills/files.js';
import { SkillService } from '../../../server/skills/service.js';
import type { Session } from '../../../shared/types.js';

async function computer(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-skill-restore-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), state = join(root, 'state');
  const paths = { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'),
    trash: join(state, 'skills-trash'), store: join(state, 'skills'), journal: join(state, 'skills-moves.json') };
  await mkdir(paths.claudeHome, { recursive: true }); await mkdir(paths.codexHome, { recursive: true });
  return { ...paths, root, state, files: new SkillFiles(paths) };
}
const session = (cwd: string): Session => ({ id: 'claude:s', nativeId: 's', provider: 'claude', title: 't', cwd, project: 'p', status: 'completed', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true });
async function service(f: Awaited<ReturnType<typeof computer>>, cwds: string[]) {
  const skills = new SkillService({ stateDir: f.state, homes: f, sessions: () => cwds.map(session), runs: () => [], history: async () => [], model: async () => ({}), advise: false });
  await skills.start();
  return skills;
}
const exists = (path: string) => lstat(path).then(() => true, () => false);

test('a restore puts skills back exactly as they were: where they apply, pins and the guidance', async t => {
  const f = await computer(t);
  const project = join(f.home, 'work', 'shop');
  await mkdir(project, { recursive: true });
  const skills = await service(f, [project]);
  await skills.mutate('save', { scope: 'global', name: 'review', description: 'Review code.', body: 'Steps', pinned: true });
  await skills.mutate('save', { scope: 'global', name: 'scoped', description: 'Only the shop.', body: 'Shop steps', targets: { all: false, projects: [project] } });
  let guidance = (await skills.overview()).guidance!;
  await skills.mutate('guidance', { owner: 'Answer in Korean.', revision: guidance.revision });
  const backup = JSON.parse(JSON.stringify(await skills.backup()));
  assert.equal(backup.bundle.skills.length, 2);

  // Afterwards: applied everywhere, unpinned, edited, the guidance changed, and one more skill made.
  const stored = (await skills.overview()).stored!;
  const scoped = stored.find(skill => skill.name === 'scoped')!, review = stored.find(skill => skill.name === 'review')!;
  await skills.mutate('assign', { dir: scoped.dir, targets: { all: true } });
  await skills.mutate('pin', { dir: review.dir, pinned: false });
  await skills.mutate('save', { dir: review.dir, revision: review.revision, scope: 'global', name: 'review', description: 'Review code.', body: 'Changed steps' });
  guidance = (await skills.overview()).guidance!;
  await skills.mutate('guidance', { owner: 'Something else.', revision: guidance.revision });
  await skills.mutate('save', { scope: 'global', name: 'later', description: 'Made later.', body: 'Steps' });
  assert.equal(await exists(join(f.agentsHome, 'skills', 'scoped')), true);

  const result = await skills.restore(backup);
  assert.deepEqual(result.restored.sort(), ['review', 'scoped']);
  assert.deepEqual(result.skipped, []);
  const after = await skills.overview({ cwd: project });
  const byName = new Map(after.stored!.map(skill => [skill.name, skill]));
  assert.equal(byName.get('review')!.pinned, true);
  assert.match(await readFile(join(byName.get('review')!.dir, 'SKILL.md'), 'utf8'), /\nSteps\n/);
  assert.deepEqual(byName.get('scoped')!.targets, { all: false, projects: [project] });
  assert.equal(await exists(join(f.agentsHome, 'skills', 'scoped')), false, 'no longer linked everywhere');
  assert.equal(await exists(join(project, '.agents', 'skills', 'scoped')), true);
  assert.ok(byName.has('later'), 'a skill the backup does not have stays');
  assert.equal(after.guidance!.owner, 'Answer in Korean.\n');

  // An empty guidance in the backup empties it here too.
  await skills.restore({ ...backup, guidance: '' });
  assert.equal((await skills.overview()).guidance!.owner, '');
});

test('on another computer, skills of a project that is not there are left out and reported', async t => {
  const a = await computer(t), b = await computer(t);
  const project = join(a.home, 'work', 'shop');
  await mkdir(project, { recursive: true });
  const from = await service(a, [project]);
  await from.mutate('save', { scope: 'project', projectCwd: project, cwd: project, name: 'deploy', description: 'Deploy.', body: 'Steps' });
  await from.mutate('save', { scope: 'global', name: 'scoped', description: 'Only the shop.', body: 'Steps', targets: { all: false, projects: [project] } });
  await from.mutate('save', { scope: 'global', name: 'everywhere', description: 'All.', body: 'Steps' });
  const backup = JSON.parse(JSON.stringify(await from.backup()));
  // The other computer has no such project folder.
  await rm(project, { recursive: true, force: true });
  const to = await service(b, []);
  const result = await to.restore(backup);
  assert.deepEqual(result.restored.sort(), ['everywhere', 'scoped']);
  assert.deepEqual(result.skipped.map(item => item.name).sort(), ['deploy (shop)', 'scoped']);
  assert.match(result.skipped.find(item => item.name === 'deploy (shop)')!.reason, /프로젝트 폴더가 이 컴퓨터에 없습니다/);
  assert.match(result.skipped.find(item => item.name === 'scoped')!.reason, /1개가 이 컴퓨터에 없어/);
  assert.equal(await exists(join(b.agentsHome, 'skills', 'everywhere')), true);
});

test('a guidance file that cannot be read stops the backup instead of recording it as empty', async t => {
  const f = await computer(t);
  const skills = await service(f, []);
  const guidance = (await skills.overview()).guidance!;
  await skills.mutate('guidance', { owner: 'Answer in Korean.', revision: guidance.revision });
  const { OWNER_GUIDANCE_FILE } = await import('../../../server/agent-guidance/install.js');
  const { chmod } = await import('node:fs/promises');
  await chmod(join(f.state, OWNER_GUIDANCE_FILE), 0o000);
  t.after(() => chmod(join(f.state, OWNER_GUIDANCE_FILE), 0o600).catch(() => {}));
  if (process.getuid?.() === 0) { t.skip('root reads any file'); return; }
  await assert.rejects(skills.backup(), /지침 파일을 읽지 못해/);
});
