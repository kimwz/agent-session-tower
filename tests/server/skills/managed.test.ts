import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../../../server/skills/service.js';
import { parseManagedApply, parseManagedSkills, type ManagedSkills } from '../../../server/skills/managed.js';
import type { ManagedFolder } from '../../../shared/managed.js';
import type { Session } from '../../../shared/types.js';
import { ISSUE_SKILL } from '../../../shared/issues.js';
import { DEFAULT_SKILLS } from '../../../server/skills/defaults.js';

/** One Tower's skill folders and state, in its own temporary home. */
async function computer(t: test.TestContext, name: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `tower-skill-managed-${name}-`)));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), state = join(root, 'state');
  const homes = { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'),
    trash: join(state, 'skills-trash'), store: join(state, 'skills'), journal: join(state, 'skills-moves.json') };
  await mkdir(homes.claudeHome, { recursive: true }); await mkdir(homes.codexHome, { recursive: true });
  return { root, home, state, homes };
}
const session = (cwd: string): Session => ({ id: `claude:${cwd}`, nativeId: 's', provider: 'claude', title: 't', cwd, project: 'p', status: 'completed', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true });
async function service(f: Awaited<ReturnType<typeof computer>>, cwds: string[], seed = false) {
  const skills = new SkillService({ stateDir: f.state, homes: f.homes, sessions: () => cwds.map(session), runs: () => [], history: async () => [], model: async () => ({}), advise: false, seed });
  await skills.start();
  await skills.settled();
  return skills;
}
/** A clone of `remote`: a git folder whose origin is that address. */
async function clone(path: string, remote: string) {
  await mkdir(path, { recursive: true });
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote]);
}
const exists = (path: string) => lstat(path).then(() => true, () => false);
/** As the node's web hands it to its worker: through JSON, with the node's folders and their repositories. */
const relay = (value: ManagedSkills, folders: ManagedFolder[] = []) => JSON.parse(JSON.stringify({ section: value, folders })) as unknown;
/** Every file under a folder with its modification time, links by where they lead. */
async function tree(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else result[path] = String((await lstat(path)).mtimeMs);
    }
  };
  await walk(dir);
  return result;
}

test('a following computer mirrors the host\'s Tower skills: made, changed, pinned, linked by repository, guidance', async t => {
  const host = await computer(t, 'host'), node = await computer(t, 'node');
  const hostApp = join(host.home, 'work', 'app'), hostLocal = join(host.home, 'work', 'notes');
  await clone(hostApp, 'git@github.com:kimwz/app.git');
  await mkdir(hostLocal, { recursive: true });
  const nodeApp = join(node.home, 'Workspace', 'app'), nodeOther = join(node.home, 'Workspace', 'other');
  await mkdir(nodeApp, { recursive: true }); await mkdir(nodeOther, { recursive: true });
  const nodeFolders = [{ cwd: nodeApp, remoteUrl: 'github.com/kimwz/app' }, { cwd: nodeOther, remoteUrl: 'github.com/kimwz/other' }];
  const from = await service(host, [hostApp, hostLocal]);
  const to = await service(node, [nodeApp, nodeOther]);
  await from.mutate('save', { scope: 'global', name: 'review', description: 'Review code.', body: 'Steps', pinned: true });
  await from.mutate('save', { scope: 'global', name: 'deploy', description: 'Deploy the app.', body: 'Deploy steps', targets: { all: false, projects: [hostApp, hostLocal] } });
  let guidance = (await from.overview()).guidance!;
  await from.mutate('guidance', { owner: 'Answer in Korean.', revision: guidance.revision });

  const sent = await from.exportManaged();
  assert.deepEqual(sent.skills.map(skill => [skill.name, skill.pinned, skill.targets]), [
    ['deploy', false, { all: false, repositories: ['github.com/kimwz/app'] }],
    ['review', true, { all: true, repositories: [] }],
  ], 'a project without a repository is left out');
  await to.applyManaged(relay(sent, nodeFolders));
  let stored = new Map((await to.overview()).stored!.map(skill => [skill.name, skill]));
  assert.equal(stored.get('review')!.pinned, true);
  assert.deepEqual(stored.get('review')!.targets, { all: true, projects: [] });
  assert.deepEqual(stored.get('deploy')!.targets, { all: false, projects: [nodeApp] }, 'the node folder of the same repository');
  assert.equal(await exists(join(node.homes.agentsHome, 'skills', 'review')), true);
  assert.equal(await exists(join(nodeApp, '.agents', 'skills', 'deploy')), true);
  assert.equal(await exists(join(nodeOther, '.agents', 'skills', 'deploy')), false);
  assert.equal((await to.overview()).guidance!.owner, 'Answer in Korean.\n');

  // Applying the same again changes nothing on disk.
  const before = { ...await tree(node.state), ...await tree(node.homes.agentsHome), ...await tree(join(nodeApp, '.agents')) };
  await to.applyManaged(relay(await from.exportManaged(), nodeFolders));
  assert.deepEqual({ ...await tree(node.state), ...await tree(node.homes.agentsHome), ...await tree(join(nodeApp, '.agents')) }, before);

  // The host edits, unpins, retargets and empties its guidance: all of it reaches the node.
  const review = (await from.overview()).stored!.find(skill => skill.name === 'review')!;
  await from.mutate('save', { dir: review.dir, revision: review.revision, scope: 'global', name: 'review', description: 'Review code.', body: 'Changed steps' });
  await from.mutate('pin', { dir: review.dir, pinned: false });
  await from.mutate('assign', { dir: review.dir, targets: { all: false, projects: [hostApp] } });
  guidance = (await from.overview()).guidance!;
  await from.mutate('guidance', { owner: '', revision: guidance.revision });
  await to.applyManaged(relay(await from.exportManaged(), nodeFolders));
  stored = new Map((await to.overview()).stored!.map(skill => [skill.name, skill]));
  assert.equal(stored.get('review')!.pinned, false);
  assert.match(await readFile(join(stored.get('review')!.dir, 'SKILL.md'), 'utf8'), /Changed steps/);
  assert.deepEqual(stored.get('review')!.targets, { all: false, projects: [nodeApp] });
  assert.equal(await exists(join(node.homes.agentsHome, 'skills', 'review')), false, 'no longer linked everywhere');
  assert.equal((await to.overview()).guidance!.owner, '');
});

test('a skill the host deleted goes from the node; the node\'s own skills never do, and one in the way is reported', async t => {
  const host = await computer(t, 'host'), node = await computer(t, 'node');
  const from = await service(host, []);
  const to = await service(node, []);
  await from.mutate('save', { scope: 'global', name: 'shared', description: 'From the host.', body: 'Host steps' });
  await from.mutate('save', { scope: 'global', name: 'clash', description: 'The host one.', body: 'Host version' });
  await to.mutate('save', { scope: 'global', name: 'mine', description: 'The node owner\'s.', body: 'Node steps', pinned: true });
  await to.mutate('save', { scope: 'global', name: 'clash', description: 'The node one.', body: 'Node version' });

  await assert.rejects(to.applyManaged(relay(await from.exportManaged())), /clash: 이 컴퓨터에 같은 이름의 Tower 스킬이 있어/);
  let stored = new Map((await to.overview()).stored!.map(skill => [skill.name, skill]));
  assert.ok(stored.has('shared'), 'the others still apply');
  assert.match(await readFile(join(stored.get('clash')!.dir, 'SKILL.md'), 'utf8'), /Node version/, 'the node\'s own skill stays as it was');

  const shared = (await from.overview()).stored!.find(skill => skill.name === 'shared')!;
  await from.mutate('delete', { dir: shared.dir });
  const clash = (await from.overview()).stored!.find(skill => skill.name === 'clash')!;
  await from.mutate('delete', { dir: clash.dir });
  await to.applyManaged(relay(await from.exportManaged()));
  stored = new Map((await to.overview()).stored!.map(skill => [skill.name, skill]));
  assert.equal(stored.has('shared'), false);
  assert.equal(await exists(join(node.homes.agentsHome, 'skills', 'shared')), false);
  assert.equal(stored.get('mine')!.pinned, true, 'the node owner\'s skill and pin stay');
  assert.ok(stored.has('clash'), 'never the host\'s, so never removed by it');
});

test('a node skill of the same name stays the node\'s even with the same content: never replaced or removed by the host', async t => {
  const host = await computer(t, 'host'), node = await computer(t, 'node');
  const from = await service(host, []);
  const to = await service(node, []);
  await from.mutate('save', { scope: 'global', name: 'same', description: 'Same.', body: 'Same steps' });
  await to.mutate('save', { scope: 'global', name: 'same', description: 'Same.', body: 'Same steps' });
  await assert.rejects(to.applyManaged(relay(await from.exportManaged())), /same: 이 컴퓨터에 같은 이름의/);
  assert.equal(await exists(join(node.state, 'skills-managed.json')), false, 'not counted as the host\'s');
  const same = (await from.overview()).stored!.find(skill => skill.name === 'same')!;
  await from.mutate('delete', { dir: same.dir });
  await to.applyManaged(relay(await from.exportManaged()));
  assert.equal((await to.overview()).stored!.some(skill => skill.name === 'same'), true, 'the host deleting its own never removes the node\'s');
});

test('Tower\'s seeded defaults: an untouched one is not sent, a changed one replaces only an untouched node default', async t => {
  const host = await computer(t, 'host'), node = await computer(t, 'node'), edited = await computer(t, 'edited');
  const from = await service(host, [], true);
  const to = await service(node, [], true);
  const own = await service(edited, [], true);
  const defaultOf = async (skills: SkillService) => (await skills.overview()).stored!.find(skill => skill.name === ISSUE_SKILL);
  const original = await readFile(join((await defaultOf(to))!.dir, 'SKILL.md'), 'utf8');

  // (a) The same on every Tower by construction: not sent, and a fresh node has nothing to report.
  const untouched = await from.exportManaged();
  assert.equal(untouched.skills.some(skill => skill.name === ISSUE_SKILL), false);
  assert.deepEqual(untouched.defaults, [ISSUE_SKILL]);
  await to.applyManaged(relay(untouched));

  // (b) Changed on the host: it replaces the node's untouched default, which the sync then owns.
  const issue = (await defaultOf(from))!;
  await from.mutate('save', { dir: issue.dir, revision: issue.revision, scope: 'global', name: ISSUE_SKILL, description: issue.description, body: 'The owner\'s own way.' });
  await to.applyManaged(relay(await from.exportManaged()));
  assert.match(await readFile(join((await defaultOf(to))!.dir, 'SKILL.md'), 'utf8'), /The owner's own way/);
  assert.equal(JSON.parse(await readFile(join(node.state, 'skills-managed.json'), 'utf8')).dirs.length, 1);
  // A node owner's edit of their default is theirs: kept, and reported.
  const mine = (await defaultOf(own))!;
  await own.mutate('save', { dir: mine.dir, revision: mine.revision, scope: 'global', name: ISSUE_SKILL, description: mine.description, body: 'Edited on the node.' });
  await assert.rejects(own.applyManaged(relay(await from.exportManaged())), new RegExp(`${ISSUE_SKILL}: 이 컴퓨터에 같은 이름의`));
  assert.match(await readFile(join(mine.dir, 'SKILL.md'), 'utf8'), /Edited on the node/);

  // (c) Back as seeded on the host: the node's copy is its own default again; the host deleting its default then leaves it.
  const changed = (await defaultOf(from))!;
  await from.mutate('save', { dir: changed.dir, revision: (await from.detail({ dir: changed.dir })).revision, scope: 'global', name: ISSUE_SKILL, description: changed.description, body: DEFAULT_SKILLS.find(skill => skill.name === ISSUE_SKILL)!.body });
  assert.deepEqual((await from.exportManaged()).defaults, [ISSUE_SKILL]);
  await to.applyManaged(relay(await from.exportManaged()));
  assert.equal(await readFile(join((await defaultOf(to))!.dir, 'SKILL.md'), 'utf8'), original);
  assert.equal(JSON.parse(await readFile(join(node.state, 'skills-managed.json'), 'utf8')).dirs.length, 0);
  await from.mutate('delete', { dir: changed.dir });
  await to.applyManaged(relay(await from.exportManaged()));
  assert.ok(await defaultOf(to), 'never the host\'s now, so the host deleting its own leaves it');
});

test('a node skill reading like a default is taken over only when Tower made it there and it is untouched', async t => {
  const host = await computer(t, 'host'), before = await computer(t, 'before'), remade = await computer(t, 'remade');
  const from = await service(host, [], true);
  const issue = (await from.overview()).stored!.find(skill => skill.name === ISSUE_SKILL)!;
  await from.mutate('save', { dir: issue.dir, revision: issue.revision, scope: 'global', name: ISSUE_SKILL, description: issue.description, body: 'The owner\'s own way.' });
  const changed = await from.exportManaged();
  const text = DEFAULT_SKILLS.find(skill => skill.name === ISSUE_SKILL)!;

  // The owner made a skill of that name, reading exactly like the default, before Tower would have seeded it.
  const owner = await service(before, []);
  await owner.mutate('save', { scope: 'global', name: ISSUE_SKILL, description: text.description, body: text.body });
  const seededLater = await service(before, [], true);
  await assert.rejects(seededLater.applyManaged(relay(changed)), new RegExp(`${ISSUE_SKILL}: 이 컴퓨터에 같은 이름의`));
  const kept = (await seededLater.overview()).stored!.find(skill => skill.name === ISSUE_SKILL)!;
  assert.doesNotMatch(await readFile(join(kept.dir, 'SKILL.md'), 'utf8'), /The owner's own way/);
  await from.mutate('delete', { dir: issue.dir });
  await seededLater.applyManaged(relay(await from.exportManaged())).catch(() => {});
  assert.ok((await seededLater.overview()).stored!.some(skill => skill.name === ISSUE_SKILL), 'never the host\'s, so never removed');

  // Tower made it, then the owner removed it and made one reading the same: another skill, the owner's.
  const node = await service(remade, [], true);
  const seeded = (await node.overview()).stored!.find(skill => skill.name === ISSUE_SKILL)!;
  await node.mutate('delete', { dir: seeded.dir });
  await node.mutate('save', { scope: 'global', name: ISSUE_SKILL, description: text.description, body: text.body });
  await assert.rejects(node.applyManaged(relay(changed)), new RegExp(`${ISSUE_SKILL}: 이 컴퓨터에 같은 이름의`));
});

test('what the host sends is checked before use: names, file paths and repository addresses', () => {
  const file = { path: 'SKILL.md', mode: 0o644, base64: Buffer.from('---\nname: x\n---\n').toString('base64') };
  assert.throws(() => parseManagedSkills({ skills: [{ name: '../x', pinned: false, files: [file], targets: { all: true, repositories: [] } }], guidance: '' }));
  assert.throws(() => parseManagedSkills({ skills: [{ name: 'x', pinned: false, files: [{ ...file, path: '../SKILL.md' }], targets: { all: true, repositories: [] } }], guidance: '' }));
  assert.throws(() => parseManagedSkills({ skills: [{ name: 'x', pinned: false, files: [file], targets: { all: false, repositories: ['/etc'] } }], guidance: '' }));
  assert.throws(() => parseManagedSkills({ skills: [], guidance: 1 }));
  assert.throws(() => parseManagedApply({ section: { skills: [], guidance: '' } }), /폴더 목록/);
  assert.deepEqual([...parseManagedApply({ section: { skills: [], guidance: '' }, folders: [{ cwd: '/w/app', remoteUrl: 'github.com/kimwz/app' }, { cwd: 'relative', remoteUrl: 'github.com/kimwz/app' }, { cwd: '/w/x' }] }).folders],
    [['github.com/kimwz/app', ['/w/app']]]);
  assert.deepEqual(parseManagedSkills({ skills: [{ name: 'x', pinned: true, files: [file], targets: { all: false, repositories: ['github.com/kimwz/app'] } }], guidance: 'g' }).skills[0]!.targets,
    { all: false, repositories: ['github.com/kimwz/app'] });
});

test('the list of skills from the host is owner-only and written only when it changes', async t => {
  const host = await computer(t, 'host'), node = await computer(t, 'node');
  const from = await service(host, []);
  const to = await service(node, []);
  await from.mutate('save', { scope: 'global', name: 'one', description: 'One.', body: 'Steps' });
  await to.applyManaged(relay(await from.exportManaged()));
  const path = join(node.state, 'skills-managed.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const first = (await stat(path)).mtimeMs;
  await to.applyManaged(relay(await from.exportManaged()));
  assert.equal((await stat(path)).mtimeMs, first);
  // A list that cannot be read counts no skill as the host's: the skill stays, and is reported rather than replaced.
  await writeFile(path, 'not json', { mode: 0o600 });
  await assert.rejects(to.applyManaged(relay(await from.exportManaged())), /one: 이 컴퓨터에 같은 이름의/);
  assert.ok((await to.overview()).stored!.some(skill => skill.name === 'one'));
});
