import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillBundle } from '../../../shared/skills.js';
import { targetsRevision } from '../../../shared/skills.js';
import type { Session } from '../../../shared/types.js';
import { skillsCapability } from '../../../server/runs/durable-runner.js';
import { SkillService } from '../../../server/skills/service.js';

function session(id: string, cwd: string): Session {
  return { id: `claude:${id}`, nativeId: id, provider: 'claude', title: id, cwd, project: 'p', status: 'completed', statusReason: '',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
}

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-targets-')));
  const home = join(root, 'home'), state = join(root, 'state');
  const shop = join(home, 'work', 'shop'), blog = join(home, 'work', 'blog'), docs = join(home, 'work', 'docs');
  for (const dir of [shop, blog, docs]) await mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-q', shop]);
  const homes = { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'),
    trash: join(state, 'skills-trash'), store: join(state, 'skills'), journal: join(state, 'skills-moves.json') };
  const services: SkillService[] = [];
  const start = async () => {
    const service = new SkillService({ stateDir: state, homes, sessions: () => [shop, blog, docs].map((cwd, index) => session(String(index), cwd)), runs: () => [],
      history: async () => [], model: async () => ({}), advise: false });
    await service.start();
    await service.settled();
    services.push(service);
    return service;
  };
  t.after(async () => { for (const service of services) { service.close(); await service.flush().catch(() => {}); } await rm(root, { recursive: true, force: true }); });
  const linked = async (folder: string, name: string) => {
    const places = [join(folder, '.agents', 'skills', name), join(folder, '.claude', 'skills', name)];
    const found = await Promise.all(places.map(place => lstat(place).then(info => info.isSymbolicLink(), () => false)));
    return found.every(Boolean) ? true : found.some(Boolean) ? 'partly' : false;
  };
  const global = async (name: string) => {
    const found = await Promise.all([join(homes.agentsHome, 'skills', name), join(homes.claudeHome, 'skills', name)].map(place => lstat(place).then(info => info.isSymbolicLink(), () => false)));
    return found.every(Boolean) ? true : found.some(Boolean) ? 'partly' : false;
  };
  return { root, home, state, homes, shop, blog, docs, start, linked, global, service: await start() };
}

const save = (service: SkillService, name: string, targets: { all: boolean; projects: string[] }, pinned = true) =>
  service.mutate('save', { name, description: `Use ${name}.`, body: 'Steps', targets, pinned });

test('one Tower skill applies to the projects chosen for it: linked there, named to turns there, nowhere else', async t => {
  const f = await fixture(t);
  const overview = await save(f.service, 'deploy', { all: false, projects: [f.shop, f.blog] });
  const skill = overview.stored!.find(item => item.name === 'deploy')!;
  assert.equal(skill.dir, join(f.state, 'skills', 'global', 'deploy'), 'kept in Tower’s folder');
  assert.deepEqual(skill.targets, { all: false, projects: [f.shop, f.blog] });
  assert.equal(await f.linked(f.shop, 'deploy'), true);
  assert.equal(await f.linked(f.blog, 'deploy'), true);
  assert.equal(await f.linked(f.docs, 'deploy'), false);
  assert.equal(await f.global('deploy'), false, 'not linked for every project');
  assert.equal(await readlink(join(f.shop, '.claude', 'skills', 'deploy')), skill.dir);
  assert.match(await readFile(join(f.shop, '.git', 'info', 'exclude'), 'utf8'), /^\/\.claude\/skills\/deploy$/m, 'the links stay out of git status');
  assert.match((await f.service.turnNotes(session('a', join(f.shop, 'packages', 'app'))))!, /- deploy: Use deploy\./, 'named inside the project too');
  assert.match((await f.service.turnNotes(session('b', f.blog)))!, /deploy/);
  assert.equal(await f.service.turnNotes(session('c', f.docs)), undefined);
  await f.service.mutate('pin', { dir: skill.dir, pinned: false });
  assert.equal(await f.service.turnNotes(session('d', f.shop)), undefined, 'an unpinned skill is linked but not named');
});

test('changing a skill’s projects moves its links, and a change made elsewhere meanwhile is never overwritten', async t => {
  const f = await fixture(t);
  const skill = (await save(f.service, 'deploy', { all: false, projects: [f.shop] })).stored![0]!;
  const revision = targetsRevision(skill.targets);
  await f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [f.blog] }, targetsRevision: revision });
  assert.equal(await f.linked(f.shop, 'deploy'), false);
  assert.equal(await f.linked(f.blog, 'deploy'), true);
  await assert.rejects(f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [f.docs] }, targetsRevision: revision }), { statusCode: 409 });
  assert.equal(await f.linked(f.docs, 'deploy'), false, 'nothing changed');
  const all = await f.service.mutate('assign', { dir: skill.dir, targets: { all: true } });
  assert.equal(await f.global('deploy'), true);
  assert.equal(await f.global('deploy'), true);
  assert.equal(await f.linked(f.blog, 'deploy'), false);
  assert.deepEqual(all.stored![0]!.targets, { all: true, projects: [] });
  assert.match((await f.service.turnNotes(session('a', f.docs)))!, /deploy/);
  const none = await f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [] } });
  assert.equal(await f.global('deploy'), false);
  assert.equal(await f.service.turnNotes(session('b', f.docs)), undefined);
  assert.equal(none.stored!.length, 1, 'a skill applying nowhere is still Tower’s');
  await assert.rejects(f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: ['/etc'] } }), { statusCode: 404 }, 'only projects Tower knows');
});

test('a project with another skill of that name, or a skills folder that is a link, is refused before anything changes', async t => {
  const f = await fixture(t);
  const theirs = join(f.docs, '.claude', 'skills', 'deploy');
  await mkdir(theirs, { recursive: true });
  await writeFile(join(theirs, 'SKILL.md'), '---\nname: deploy\ndescription: theirs\n---\n');
  const skill = (await save(f.service, 'deploy', { all: false, projects: [f.shop] })).stored![0]!;
  await assert.rejects(f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [f.blog, f.docs] } }), { statusCode: 409 });
  assert.equal(await f.linked(f.blog, 'deploy'), false, 'the other project was not linked either');
  assert.equal(await f.linked(f.shop, 'deploy'), true, 'the skill still applies where it did');
  assert.ok((await lstat(theirs)).isDirectory(), 'the other skill is untouched');
  // A skills folder that leads elsewhere is never written into or cleaned.
  const outside = join(f.root, 'outside');
  await mkdir(join(outside, 'skills'), { recursive: true });
  await symlink(skill.dir, join(outside, 'skills', 'deploy'));
  await symlink(outside, join(f.blog, '.agents'));
  await assert.rejects(f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [f.blog] } }), { statusCode: 409 });
  await rm(join(f.blog, '.agents'));
  // The project's .claude turned into a link since: unassigning cleans its own folders only.
  await rm(join(f.shop, '.claude'), { recursive: true });
  await symlink(outside, join(f.shop, '.claude'));
  await f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [] } });
  assert.equal(await lstat(join(f.shop, '.agents', 'skills', 'deploy')).catch(() => undefined), undefined);
  assert.ok((await lstat(join(outside, 'skills', 'deploy'))).isSymbolicLink(), 'a link outside the project’s own folders stays');
});

test('skills kept in Tower before projects per skill apply where they did, and deleting one removes every link', async t => {
  const f = await fixture(t);
  // Made by an older Tower: a global and a project skill, with no targets recorded.
  const old = await f.service.mutate('save', { scope: 'global', name: 'review', description: 'Review.', body: 'Steps', pinned: true });
  await f.service.mutate('save', { scope: 'project', projectCwd: f.shop, cwd: f.shop, name: 'shop-deploy', description: 'Deploy.', body: 'Steps', pinned: true });
  assert.ok(old.stored!.find(item => item.name === 'review'));
  const file = join(f.state, 'skills.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.targets = [];
  await writeFile(file, JSON.stringify(saved));
  const again = await f.start();
  const stored = (await again.overview()).stored!;
  assert.deepEqual(stored.find(item => item.name === 'review')!.targets, { all: true, projects: [] });
  assert.deepEqual(stored.find(item => item.name === 'shop-deploy')!.targets, { all: false, projects: [f.shop] });
  assert.match((await again.turnNotes(session('a', f.shop)))!, /shop-deploy/);
  assert.doesNotMatch((await again.turnNotes(session('b', f.blog)))!, /shop-deploy/);
  // The project skill can apply to more projects now, and a delete takes every link with it.
  const shopDeploy = stored.find(item => item.name === 'shop-deploy')!;
  await again.mutate('assign', { dir: shopDeploy.dir, targets: { all: false, projects: [f.shop, f.blog] } });
  assert.equal(await f.linked(f.blog, 'shop-deploy'), true);
  await again.mutate('delete', { dir: shopDeploy.dir });
  assert.equal(await f.linked(f.shop, 'shop-deploy'), false);
  assert.equal(await f.linked(f.blog, 'shop-deploy'), false);
  assert.equal((await again.overview()).stored!.some(item => item.name === 'shop-deploy'), false);
});

test('after a crash the links follow the recorded projects, and a creation that never finished applies nowhere', async t => {
  const f = await fixture(t);
  const skill = (await save(f.service, 'deploy', { all: false, projects: [f.shop] })).stored![0]!;
  // Stopped half way from shop to blog: the record already names blog, the shop link is still there.
  const file = join(f.state, 'skills.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.targets = [{ dir: skill.dir, all: false, projects: [f.blog], linked: [f.shop, f.blog], globalLinked: false },
    { dir: join(f.state, 'skills', 'global', 'never-made'), all: false, projects: [f.docs], linked: [f.docs], globalLinked: false }];
  await writeFile(file, JSON.stringify(saved));
  const again = await f.start();
  assert.equal(await f.linked(f.shop, 'deploy'), false);
  assert.equal(await f.linked(f.blog, 'deploy'), true);
  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(state.targets.map((item: { dir: string; linked: string[] }) => [item.dir, item.linked]), [[skill.dir, [f.blog]]]);
  // The link repair keeps within the recorded projects.
  await again.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [] } });
  await again.mutate('link', { dir: skill.dir });
  assert.equal(await f.global('deploy'), false, 'linking a Tower skill never makes it global');
});

test('a backup carries each skill’s projects; a replaced skill keeps where it applies here', async t => {
  const f = await fixture(t);
  const skill = (await save(f.service, 'deploy', { all: false, projects: [f.shop, f.blog] })).stored![0]!;
  const bundle = await f.service.exportBundle({ dirs: [skill.dir] });
  assert.deepEqual(bundle.skills[0]!.targets, { all: false, projects: [{ cwd: f.shop, title: 'shop' }, { cwd: f.blog, title: 'blog' }] });
  const renamed = bundle.skills[0]!.files.map(file => file.path === 'SKILL.md' ? { ...file, base64: Buffer.from(Buffer.from(file.base64, 'base64').toString('utf8').replace(/^name: .*$/m, 'name: deploy-copy')).toString('base64') } : file);
  const moved: SkillBundle = { ...bundle, skills: [{ ...bundle.skills[0]!, name: 'deploy-copy', files: renamed, targets: { all: false, projects: [{ cwd: f.blog, title: 'blog' }, { cwd: '/nowhere/else', title: 'else' }] } }] };
  const plan = await f.service.importPlan(moved);
  assert.deepEqual(plan.items[0]!.targets, { all: false, projects: [f.blog] });
  assert.equal(plan.items[0]!.unknownProjects, 1);
  const imported = await f.service.mutate('import', { bundle: moved, choices: [{ index: 0, action: 'add' }] });
  assert.ok(imported.stored!.some(item => item.name === 'deploy-copy'));
  assert.equal(await f.linked(f.blog, 'deploy-copy'), true);
  assert.equal(await f.global('deploy-copy'), false, 'not global because it was stored as global');
  await f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [f.docs] } });
  await f.service.mutate('import', { bundle, choices: [{ index: 0, action: 'replace' }] });
  assert.deepEqual((await f.service.overview()).stored!.find(item => item.name === 'deploy')!.targets, { all: false, projects: [f.docs] });
  assert.equal(await f.linked(f.shop, 'deploy'), false);
});

test('an older execution worker is never asked for projects per skill', () => {
  assert.equal(skillsCapability('skillsMutate', ['assign', {}]), 'skillTargets');
  assert.equal(skillsCapability('skillsMutate', ['save', { targets: { all: true } }]), 'skillTargets');
  assert.equal(skillsCapability('skillsMutate', ['save', { name: 'x' }]), 'skills');
  const bundle = { skills: [{ name: 'x', targets: { all: true } }] };
  assert.equal(skillsCapability('skillsImportPlan', [bundle]), 'skillTargets');
  assert.equal(skillsCapability('skillsMutate', ['import', { bundle }]), 'skillTargets');
  assert.equal(skillsCapability('skillsImportPlan', [{ skills: [{ name: 'x' }] }]), 'towerSkills');
});

test('narrowing a skill keeps the links it still needs: one reaching it through a global link, or a project named through a link', async t => {
  const f = await fixture(t);
  const skill = (await save(f.service, 'deploy', { all: true, projects: [] })).stored![0]!;
  // An older install linked the project to the global link, not to Tower's folder.
  await mkdir(join(f.shop, '.claude', 'skills'), { recursive: true });
  await symlink(join(f.homes.agentsHome, 'skills', 'deploy'), join(f.shop, '.claude', 'skills', 'deploy'));
  await f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [f.shop] } });
  assert.equal(await f.global('deploy'), false);
  assert.equal(await realpath(join(f.shop, '.claude', 'skills', 'deploy')), skill.dir, 'still reaches the skill');
  assert.equal(await readlink(join(f.shop, '.claude', 'skills', 'deploy')), skill.dir);
  // The same folder by another name.
  const alias = join(f.home, 'work', 'shop-alias');
  await symlink(f.shop, alias);
  const again = await f.start();
  (again as unknown as { options: { projects: () => string[] } }).options.projects = () => [alias];
  await again.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [alias] } });
  assert.equal(await f.linked(f.shop, 'deploy'), true, 'the links the alias needs stay');
});

test('a lost record is rebuilt from the links in place, never widened to every project', async t => {
  const f = await fixture(t);
  const skill = (await save(f.service, 'deploy', { all: false, projects: [f.shop] })).stored![0]!;
  const file = join(f.state, 'skills.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.targets = [];
  await writeFile(file, JSON.stringify(saved));
  const again = await f.start();
  assert.deepEqual((await again.overview()).stored![0]!.targets, { all: false, projects: [f.shop] });
  assert.equal(await f.global('deploy'), false);
  assert.doesNotMatch((await again.turnNotes(session('a', f.blog))) ?? '', /deploy/);
  assert.equal(skill.name, 'deploy');
});

test('a project that is gone never blocks editing the skill, and a same-named skill elsewhere never blocks making one for chosen projects', async t => {
  const f = await fixture(t);
  const skill = (await save(f.service, 'deploy', { all: false, projects: [f.shop, f.blog] })).stored![0]!;
  await rm(f.blog, { recursive: true });
  const known = f.service as unknown as { options: { sessions: () => Session[] } };
  const sessions = known.options.sessions;
  known.options.sessions = () => sessions().filter(item => item.cwd !== f.blog);
  await f.service.mutate('assign', { dir: skill.dir, targets: { all: false, projects: [f.shop, f.blog, f.docs] } });
  assert.equal(await f.linked(f.docs, 'deploy'), true);
  // A global skill of the same name outside Tower does not stop a Tower skill for chosen projects.
  const theirs = join(f.homes.agentsHome, 'skills', 'review');
  await mkdir(theirs, { recursive: true });
  await writeFile(join(theirs, 'SKILL.md'), '---\nname: review\ndescription: theirs\n---\n');
  await save(f.service, 'review', { all: false, projects: [f.shop] });
  assert.equal(await f.linked(f.shop, 'review'), true);
  await assert.rejects(f.service.mutate('assign', { dir: join(f.state, 'skills', 'global', 'review'), targets: { all: true } }), { statusCode: 409 }, 'but it cannot take the global name');
});

test('a project skill restored into a project chosen here applies there', async t => {
  const f = await fixture(t);
  await f.service.mutate('save', { scope: 'project', projectCwd: f.shop, cwd: f.shop, name: 'shop-deploy', description: 'Deploy.', body: 'Steps', pinned: true });
  const dir = (await f.service.overview()).stored!.find(item => item.name === 'shop-deploy')!.dir;
  const bundle = await f.service.exportBundle({ dirs: [dir] });
  assert.equal(bundle.skills[0]!.scope, 'project');
  const elsewhere: SkillBundle = { ...bundle, skills: [{ ...bundle.skills[0]!, project: { cwd: '/other/shop', title: 'shop' }, targets: { all: false, projects: [{ cwd: '/other/shop', title: 'shop' }] } }] };
  await f.service.mutate('import', { bundle: elsewhere, choices: [{ index: 0, action: 'add', cwd: f.blog }] });
  assert.equal(await f.linked(f.blog, 'shop-deploy'), true);
});

test('deleting a Tower skill never takes an agents’ skill of the same name with it', async t => {
  const f = await fixture(t);
  const theirs = join(f.homes.agentsHome, 'skills', 'review');
  await mkdir(theirs, { recursive: true });
  await writeFile(join(theirs, 'SKILL.md'), '---\nname: review\ndescription: theirs\n---\n');
  await save(f.service, 'review', { all: false, projects: [f.shop] });
  await f.service.mutate('delete', { dir: join(f.state, 'skills', 'global', 'review') });
  assert.equal(await readFile(join(theirs, 'SKILL.md'), 'utf8'), '---\nname: review\ndescription: theirs\n---\n');
  assert.equal(await f.linked(f.shop, 'review'), false);
  assert.equal((await f.service.overview()).stored!.some(item => item.name === 'review'), false);
});

test('a project’s own skill outside Tower is still edited from that project', async t => {
  const f = await fixture(t);
  const own = join(f.shop, '.claude', 'skills', 'notes');
  await mkdir(own, { recursive: true });
  await writeFile(join(own, 'SKILL.md'), '---\nname: notes\ndescription: old\n---\nBody\n');
  const skill = (await f.service.overview({ cwd: f.shop })).skills.find(item => item.name === 'notes')!;
  await f.service.mutate('save', { cwd: f.shop, dir: skill.dir, revision: skill.revision, scope: 'project', name: 'notes', description: 'new', body: 'Body' });
  assert.match(await readFile(join(own, 'SKILL.md'), 'utf8'), /description: "?new/);
});

test('the permission reviewer gets the Tower skills that apply to a folder, as they are now, and the owner guidance', async t => {
  const f = await fixture(t);
  await save(f.service, 'deploy', { all: false, projects: [f.shop] });
  await save(f.service, 'everywhere', { all: true, projects: [] });
  const guidance = await f.service.guidance();
  await f.service.mutate('guidance', { owner: 'Deploy after merge.', revision: guidance.revision });
  const shop = await f.service.authority(join(f.shop, 'packages'));
  assert.deepEqual(shop.skills.map(skill => skill.name).sort(), ['deploy', 'everywhere']);
  assert.equal(shop.guidance?.trim(), 'Deploy after merge.');
  assert.deepEqual((await f.service.authority(f.blog)).skills.map(skill => skill.name), ['everywhere']);
});
