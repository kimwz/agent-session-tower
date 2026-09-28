import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectFolders, SkillFiles } from '../../../server/skills/files.js';
import { formatSkillFile, parseSkillFile } from '../../../server/skills/skill-file.js';

async function homes(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-skills-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const result = { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'), trash: join(root, 'state', 'skills-trash') };
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

test('a new global skill is written once in ~/.agents/skills and linked into Claude Code, so both agents find it', async t => {
  const f = await homes(t);
  const skill = await f.files.save({ scope: 'global', name: 'cross-review', description: 'Use for new work.', body: '1. Design\n2. Review' });
  assert.equal(skill.dir, join(f.agentsHome, 'skills', 'cross-review'));
  assert.deepEqual(skill.providers, ['claude', 'codex']);
  assert.equal(await readlink(join(f.claudeHome, 'skills', 'cross-review')), '../../.agents/skills/cross-review');
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
  assert.equal(rootSkill.dir, join(repo, '.agents', 'skills', 'deploy'));
  assert.equal(await readlink(join(repo, '.claude', 'skills', 'deploy')), '../../.agents/skills/deploy');
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
