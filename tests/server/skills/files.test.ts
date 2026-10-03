import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectFolders, SkillFiles } from '../../../server/skills/files.js';
import { formatSkillFile, parseSkillFile } from '../../../server/skills/skill-file.js';
import { blockQuarantine, captureErrors } from '../../helpers/quarantine.js';

async function homes(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-skills-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const result = { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'), trash: join(root, 'state', 'skills-trash'), store: join(root, 'state', 'skills'), journal: join(root, 'state', 'skills-moves.json') };
  await mkdir(result.claudeHome, { recursive: true }); await mkdir(result.codexHome, { recursive: true });
  return { ...result, files: new SkillFiles(result) };
}

test('a SKILL.md keeps every frontmatter key Tower does not own when its name and description change', () => {
  const text = '---\nname: tmux\nversion: 0.1.0\ndescription: |\n  Coordinate with panes.\n  Use when asked.\ntriggers:\n  - list panes\n---\n\n# Body\n';
  const parsed = parseSkillFile(text);
  assert.equal(parsed.name, 'tmux');
  assert.equal(parsed.description, 'Coordinate with panes.\nUse when asked.');
  assert.equal(parsed.body, '# Body\n');
  const written = formatSkillFile({ name: 'tmux', description: 'New "quoted" text: yes', body: 'Steps', frontmatter: parsed.frontmatter });
  assert.equal(written, '---\nname: "tmux"\nversion: 0.1.0\ndescription: "New \\"quoted\\" text: yes"\ntriggers:\n  - list panes\n---\n\nSteps\n');
  assert.equal(parseSkillFile(written).description, 'New "quoted" text: yes');
  assert.equal(parseSkillFile("---\nname: a\ndescription: 'It''s folded'\n---\nx").description, "It's folded");
});

test('a new skill is kept in Tower’s own folder and linked into both agents’ folders', async t => {
  const f = await homes(t);
  const skill = await f.files.save({ scope: 'global', name: 'cross-review', description: 'Use for new work.', body: '1. Design\n2. Review' });
  assert.equal(skill.dir, join(f.store, 'global', 'cross-review'));
  assert.equal(skill.managed, true);
  assert.deepEqual(skill.providers, ['claude', 'codex']);
  assert.equal(await readlink(join(f.claudeHome, 'skills', 'cross-review')), skill.dir, 'linked by its absolute path');
  assert.equal(await readlink(join(f.agentsHome, 'skills', 'cross-review')), skill.dir);
  // Reached through a linked folder (like /tmp on macOS), the link still leads to the skill.
  const linkedHome = join(f.home, '..', 'linked-home');
  await symlink(f.home, linkedHome);
  const through = new SkillFiles({ ...f, home: linkedHome, agentsHome: join(linkedHome, '.agents'), claudeHome: join(linkedHome, '.claude'), codexHome: join(linkedHome, '.codex') });
  const second = await through.save({ scope: 'global', name: 'second', description: 'd', body: '' });
  assert.deepEqual(second.providers, ['claude', 'codex']);
  assert.match(await readFile(join(linkedHome, '.claude', 'skills', 'second', 'SKILL.md'), 'utf8'), /name: "second"/);
  assert.match(await readFile(join(skill.dir, 'SKILL.md'), 'utf8'), /^---\nname: "cross-review"\ndescription: "Use for new work."\n---\n\n1\. Design/);
  await assert.rejects(f.files.save({ scope: 'global', name: 'cross-review', description: 'x', body: '' }), { statusCode: 409 });
  await assert.rejects(f.files.save({ scope: 'global', name: 'Bad Name', description: 'x', body: '' }), { statusCode: 400 });
});

test('a skill only Claude Code has can be linked for Codex as well, and one edited elsewhere is not overwritten', async t => {
  const f = await homes(t);
  await mkdir(join(f.claudeHome, 'skills', 'mine'), { recursive: true });
  await writeFile(join(f.claudeHome, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: old\nallowed-tools: Bash\n---\nbody\n');
  const [listed] = await f.files.list();
  assert.deepEqual(listed.providers, ['claude']);
  const linked = await f.files.link(listed.dir);
  assert.deepEqual(linked.providers, ['claude', 'codex']);
  assert.equal((await lstat(join(f.agentsHome, 'skills', 'mine'))).isSymbolicLink(), true);
  await assert.rejects(f.files.save({ dir: listed.dir, revision: 'stale', scope: 'global', name: 'mine', description: 'new', body: 'b' }), { statusCode: 409 });
  const saved = await f.files.save({ dir: listed.dir, revision: listed.revision, scope: 'global', name: 'mine', description: 'new', body: 'b' });
  assert.match(await readFile(join(saved.dir, 'SKILL.md'), 'utf8'), /allowed-tools: Bash/);
  assert.equal(saved.description, 'new');
});

test('only a listed skill can be read, changed or deleted, whatever path a request names', async t => {
  const f = await homes(t);
  const outside = join(f.home, 'elsewhere');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');
  await assert.rejects(f.files.detail(outside), { statusCode: 404 });
  await assert.rejects(f.files.remove(outside), { statusCode: 404 });
  await assert.rejects(f.files.save({ dir: outside, revision: '', scope: 'global', name: 'x', description: 'y', body: '' }), { statusCode: 404 });
});

test('deleting a skill moves its folder to Tower’s trash and removes the links to it', async t => {
  const f = await homes(t);
  const skill = await f.files.save({ scope: 'global', name: 'gone', description: 'd', body: 'b' });
  await f.files.remove(skill.dir);
  assert.deepEqual(await f.files.list(), []);
  await assert.rejects(lstat(join(f.claudeHome, 'skills', 'gone')));
  const [kept] = await readdir(f.trash);
  assert.match(kept, /gone/);
  assert.match(await readFile(join(f.trash, kept, 'SKILL.md'), 'utf8'), /name: "gone"/);
});

test('a project shows its own skills, those of folders up to its repository root, and the global ones', async t => {
  const f = await homes(t);
  const repo = join(f.home, 'work', 'repo');
  const app = join(repo, 'packages', 'app');
  await mkdir(join(repo, '.git'), { recursive: true }); await mkdir(app, { recursive: true });
  assert.deepEqual(projectFolders(app, f.home), [app, join(repo, 'packages'), repo]);
  assert.deepEqual(projectFolders(join(f.home, 'loose'), f.home), [join(f.home, 'loose')], 'outside a repository only the folder itself');
  await f.files.save({ scope: 'global', name: 'global-one', description: 'g', body: '' });
  const rootSkill = await f.files.save({ scope: 'project', cwd: repo, name: 'deploy', description: 'repo deploy', body: '' });
  assert.match(rootSkill.dir, new RegExp(`^${f.store}/projects/repo-[0-9a-f]{8}/deploy$`));
  assert.deepEqual(JSON.parse(await readFile(join(rootSkill.dir, '..', 'project.json'), 'utf8')), { cwd: repo });
  assert.equal(await readlink(join(repo, '.claude', 'skills', 'deploy')), rootSkill.dir);
  assert.equal(await readlink(join(repo, '.agents', 'skills', 'deploy')), rootSkill.dir);
  await f.files.save({ scope: 'project', cwd: app, name: 'app-only', description: 'a', body: '' });
  const listed = await f.files.list(app);
  assert.deepEqual(listed.map(skill => [skill.name, skill.scope, skill.cwd ?? '']), [['app-only', 'project', app], ['deploy', 'project', repo], ['global-one', 'global', '']]);
  assert.deepEqual((await f.files.list()).map(skill => skill.name), ['global-one'], 'the global listing has no project skills');
  // A skill installed by the skills command is marked, so the page can warn before editing it.
  await mkdir(join(f.agentsHome, 'skills', 'find-skills'), { recursive: true });
  await writeFile(join(f.agentsHome, 'skills', 'find-skills', 'SKILL.md'), '---\nname: find-skills\ndescription: d\n---\n');
  await writeFile(join(f.agentsHome, '.skill-lock.json'), JSON.stringify({ skills: { 'find-skills': {} } }));
  await symlink('../../.agents/skills/find-skills', join(f.claudeHome, 'skills', 'find-skills'));
  const external = (await f.files.list()).find(skill => skill.name === 'find-skills');
  assert.equal(external?.external, true);
  assert.deepEqual(external?.providers, ['claude', 'codex']);
});

test('deleting a skill that is only a link to another folder removes the link and never moves that folder', async t => {
  const f = await homes(t);
  const project = join(f.home, 'shared-project');
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(project, 'SKILL.md'), '---\nname: shared\ndescription: d\n---\n');
  await mkdir(join(f.agentsHome, 'skills'), { recursive: true });
  await symlink(project, join(f.agentsHome, 'skills', 'shared'));
  const [skill] = await f.files.list();
  assert.equal(skill.dir, project);
  await f.files.remove(skill.dir);
  await assert.rejects(lstat(join(f.agentsHome, 'skills', 'shared')));
  assert.ok((await lstat(join(project, 'src'))).isDirectory(), 'the folder the link led to stays where it is');
  await assert.rejects(readdir(f.trash), 'nothing was moved to the trash');
});

test('a new skill is never written through a linked skills folder that leads outside the project', async t => {
  const f = await homes(t);
  const project = join(f.home, 'work', 'app'), elsewhere = join(f.home, 'elsewhere');
  await mkdir(project, { recursive: true }); await mkdir(elsewhere, { recursive: true });
  await symlink(elsewhere, join(project, '.agents'));
  await assert.rejects(f.files.save({ scope: 'project', cwd: project, name: 'x', description: 'd', body: '' }), { statusCode: 409 });
  assert.deepEqual(await readdir(elsewhere), [], 'nothing was created on the other side of the link');
});

test('two saves of the same revision at once: one wins, the other is told the skill changed', async t => {
  const f = await homes(t);
  const skill = await f.files.save({ scope: 'global', name: 'race', description: 'd', body: 'start' });
  const results = await Promise.allSettled(['first', 'second'].map(body => f.files.save({ dir: skill.dir, revision: skill.revision, scope: 'global', name: 'race', description: 'd', body })));
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const kept = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<unknown>) && await readFile(join(skill.dir, 'SKILL.md'), 'utf8');
  assert.match(kept, /first|second/);
});

test('a skills state file that cannot be read is set aside, not overwritten, and skills start over', async t => {
  const { SkillStateStore } = await import('../../../server/skills/state.js');
  const dir = await mkdtemp(join(tmpdir(), 'tower-skill-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'skills.json'), '{not json', { mode: 0o600 });
  const store = new SkillStateStore(dir);
  await store.start();
  assert.deepEqual(store.get().proposals, []);
  const names = await readdir(dir);
  const aside = names.find(name => name.startsWith('skills.json.unreadable-'));
  assert.ok(aside);
  assert.equal(await readFile(join(dir, aside!), 'utf8'), '{not json');
});

test('a skills state file is logged after it is set aside, and one that cannot be set aside is logged and skills still start', async t => {
  const { SkillStateStore } = await import('../../../server/skills/state.js');
  const dir = await mkdtemp(join(tmpdir(), 'tower-skill-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'skills.json');
  await writeFile(path, '{not json', { mode: 0o600 });
  const logged = captureErrors(t, path);
  await new SkillStateStore(dir).start();
  assert.match(String(logged[0].args[0]), /^Skill state was set aside: /);
  assert.equal(logged[0].present, false, 'logged after the move');

  await writeFile(path, '{not json', { mode: 0o600 });
  const blocked = await blockQuarantine(t, path);
  const store = new SkillStateStore(dir);
  await store.start();
  blocked.release();
  assert.deepEqual(store.get().proposals, []);
  assert.match(String(logged[1].args[0]), /^Skill state was set aside: /);
  assert.deepEqual(await readdir(blocked.aside), ['occupied'], 'the move failed');
});

async function copy(root: string, name: string, text: string) {
  await mkdir(join(root, 'skills', name, 'references'), { recursive: true });
  await writeFile(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${text}\n`);
  await writeFile(join(root, 'skills', name, 'references', 'a.md'), 'ref');
}

test('a skill copied into each agent’s folder is listed once, and identical copies merge into one folder', async t => {
  const f = await homes(t);
  await copy(f.agentsHome, 'wrangler', 'Same text');
  await copy(f.claudeHome, 'wrangler', 'Same text');
  const [listed] = await f.files.list();
  assert.equal((await f.files.list()).length, 1);
  assert.equal(listed.dir, join(f.agentsHome, 'skills', 'wrangler'), 'the shared folder is the one edited');
  assert.deepEqual(listed.providers, ['claude', 'codex']);
  assert.deepEqual(listed.copies?.map(item => item.providers), [['codex'], ['claude']]);
  assert.equal(listed.copiesDiffer, false);
  const merged = await f.files.merge(listed.dir);
  assert.equal(merged.copies, undefined);
  assert.deepEqual(merged.providers, ['claude', 'codex']);
  assert.equal(await readlink(join(f.claudeHome, 'skills', 'wrangler')), '../../.agents/skills/wrangler');
  const [kept] = await readdir(f.trash);
  assert.equal(await readFile(join(f.trash, kept, 'references', 'a.md'), 'utf8'), 'ref', 'the removed copy is kept in the trash');
});

test('copies whose contents differ stay separate, and deleting the skill removes every copy', async t => {
  const f = await homes(t);
  await copy(f.agentsHome, 'tmux', 'Talk to other Codex instances');
  await copy(f.claudeHome, 'tmux', 'Talk to other Claude instances');
  const [listed] = await f.files.list();
  assert.equal(listed.copiesDiffer, true);
  await assert.rejects(f.files.merge(listed.dir), { statusCode: 409 });
  assert.equal((await f.files.detail(join(f.claudeHome, 'skills', 'tmux'))).dir, listed.dir, 'either copy finds the skill');
  await f.files.remove(listed.dir);
  assert.deepEqual(await f.files.list(), []);
  assert.equal((await readdir(f.trash)).length, 2);
});

test('copies with links inside are never called identical, and a merge that cannot finish leaves the copy as it was', async t => {
  const f = await homes(t);
  await copy(f.agentsHome, 'linked', 'Same text');
  await copy(f.claudeHome, 'linked', 'Same text');
  await symlink('../resource.txt', join(f.agentsHome, 'skills', 'linked', 'resource'));
  await symlink('../resource.txt', join(f.claudeHome, 'skills', 'linked', 'resource'));
  assert.equal((await f.files.list())[0].copiesDiffer, true, 'the same link text may lead to different files');

  await copy(f.agentsHome, 'plain', 'Same text');
  await copy(f.claudeHome, 'plain', 'Same text');
  // The trash cannot be made (a file stands where its folder would go), so the copy must stay.
  await mkdir(join(f.trash, '..'), { recursive: true });
  await writeFile(f.trash, 'not a folder');
  const plain = (await f.files.list()).find(skill => skill.name === 'plain')!;
  await assert.rejects(f.files.merge(plain.dir));
  assert.ok((await lstat(join(f.claudeHome, 'skills', 'plain'))).isDirectory());
  assert.deepEqual((await readdir(join(f.claudeHome, 'skills'))).sort(), ['linked', 'plain'], 'no half-made link is left behind');
});

test('skill state of the wrong shape is set aside like an unreadable one', async t => {
  const { SkillStateStore } = await import('../../../server/skills/state.js');
  const dir = await mkdtemp(join(tmpdir(), 'tower-skill-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'skills.json'), '[]', { mode: 0o600 });
  captureErrors(t, join(dir, 'skills.json'));
  const store = new SkillStateStore(dir);
  await store.start();
  const aside = (await readdir(dir)).find(name => name.startsWith('skills.json.unreadable-'));
  assert.ok(aside);
  assert.equal(await readFile(join(dir, aside!), 'utf8'), '[]');
  assert.equal(store.locked, undefined);
});

test('skill state that cannot be moved aside is never written over, and flush only waits', async t => {
  const { SkillStateStore } = await import('../../../server/skills/state.js');
  const dir = await mkdtemp(join(tmpdir(), 'tower-skill-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'skills.json');
  await writeFile(path, '{not json', { mode: 0o600 });
  const blocked = await blockQuarantine(t, path);
  captureErrors(t, path);
  const store = new SkillStateStore(dir);
  await store.start();
  blocked.release();
  assert.equal(store.locked, 'Skill state could not be read or moved aside; skills are not changed until Tower restarts.');
  let changed = false;
  await assert.rejects(store.update(() => { changed = true; }), { statusCode: 503 });
  assert.equal(changed, false, 'the change is never applied, even in memory');
  await store.flush();
  assert.equal(await readFile(path, 'utf8'), '{not json');
});
