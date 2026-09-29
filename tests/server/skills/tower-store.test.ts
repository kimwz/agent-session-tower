import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillFiles } from '../../../server/skills/files.js';
import { parseBundle, writeMoves } from '../../../server/skills/store.js';
import { SkillService } from '../../../server/skills/service.js';
import { installAgentGuidance, OWNER_GUIDANCE_FILE } from '../../../server/agent-guidance/install.js';
import type { Session } from '../../../shared/types.js';

async function homes(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-store-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), state = join(root, 'state');
  const paths = { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'),
    trash: join(state, 'skills-trash'), store: join(state, 'skills'), journal: join(state, 'skills-moves.json') };
  await mkdir(paths.claudeHome, { recursive: true }); await mkdir(paths.codexHome, { recursive: true });
  return { ...paths, root, state, files: new SkillFiles(paths) };
}

async function external(root: string, name: string, text = 'Steps') {
  const dir = join(root, 'skills', name);
  await mkdir(join(dir, 'references'), { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${text}\n`);
  await writeFile(join(dir, 'references', 'a.md'), 'ref');
  return dir;
}

test('moving a skill into Tower keeps it where the agents look, through a link to Tower’s folder', async t => {
  const f = await homes(t);
  const original = await external(f.claudeHome, 'mine');
  const { skill, from } = await f.files.adopt(original);
  assert.deepEqual(from, [original]);
  assert.equal(skill.dir, join(f.store, 'global', 'mine'));
  assert.equal(skill.managed, true);
  assert.deepEqual(skill.providers, ['claude', 'codex'], 'Codex gets a link too');
  assert.equal(await readlink(original), skill.dir);
  assert.equal(await readFile(join(original, 'references', 'a.md'), 'utf8'), 'ref', 'read through the link as before');
  assert.equal(await readlink(join(f.agentsHome, 'skills', 'mine')), skill.dir);
  assert.equal((await readdir(f.trash)).length, 1, 'the original folder is kept in the trash');
  assert.deepEqual(JSON.parse(await readFile(f.journal, 'utf8')), []);
});

test('a skill with a link inside, or with per-agent copies that differ, is not moved', async t => {
  const f = await homes(t);
  const linked = await external(f.agentsHome, 'linked');
  await symlink('../shared.md', join(linked, 'shared.md'));
  await assert.rejects(f.files.adopt(linked), { statusCode: 409 });
  await external(f.agentsHome, 'tmux', 'Codex panes');
  await external(f.claudeHome, 'tmux', 'Claude panes');
  await assert.rejects(f.files.adopt(join(f.agentsHome, 'skills', 'tmux')), { statusCode: 409 });
  assert.ok((await lstat(join(f.claudeHome, 'skills', 'tmux'))).isDirectory(), 'nothing moved');
  // Identical copies are merged first, then moved as one.
  await external(f.agentsHome, 'same');
  await external(f.claudeHome, 'same');
  const { skill } = await f.files.adopt(join(f.claudeHome, 'skills', 'same'));
  assert.equal(skill.copies, undefined);
  assert.equal(await realpath(join(f.claudeHome, 'skills', 'same')), skill.dir);
  assert.equal(await realpath(join(f.agentsHome, 'skills', 'same')), skill.dir);
});

test('a move a crash interrupted is undone when the original never left, and finished when it did', async t => {
  const f = await homes(t);
  const step = async (name: string) => {
    const from = await external(f.agentsHome, name);
    const to = join(f.store, 'global', name);
    const move = { from, to, incoming: join(f.store, 'global', `.incoming-${name}`), aside: `${from}.tower-old-00000000`, link: `${from}.tower-link-00000000` };
    await mkdir(join(f.store, 'global'), { recursive: true });
    execFileSync('cp', ['-R', from, to]);
    return move;
  };
  // Stopped after the copy: the original is still in place, so the copy goes and the skill stays where it was.
  const copied = await step('copied');
  // Stopped between putting the original aside and the link in its place: the link is put there.
  const aside = await step('aside');
  await rename(aside.from, aside.aside);
  // Stopped after the swap, before the rest: it is finished.
  const swapped = await step('swapped');
  await rename(swapped.from, swapped.aside);
  await symlink(swapped.to, swapped.from, 'dir');
  await writeMoves(f.journal, [copied, aside, swapped]);
  const finished = await f.files.recover();
  assert.deepEqual(finished.map(move => move.from).sort(), [aside.from, swapped.from].sort());
  assert.ok((await lstat(copied.from)).isDirectory());
  await assert.rejects(lstat(copied.to));
  for (const move of [aside, swapped]) {
    assert.equal(await readlink(move.from), move.to);
    await assert.rejects(lstat(move.aside));
    assert.equal(await realpath(join(f.claudeHome, 'skills', move.from.split('/').at(-1)!)), move.to, 'the other agent is linked too');
  }
  assert.deepEqual(JSON.parse(await readFile(f.journal, 'utf8')), []);
  assert.equal((await readdir(f.trash)).length, 2);
});

test('a skill kept in Tower whose links were lost is still listed, and linking puts them back', async t => {
  const f = await homes(t);
  const skill = await f.files.save({ scope: 'global', name: 'kept', description: 'd', body: 'b' });
  await unlink(join(f.agentsHome, 'skills', 'kept')); await unlink(join(f.claudeHome, 'skills', 'kept'));
  const [listed] = await f.files.list();
  assert.equal(listed.dir, skill.dir);
  assert.deepEqual(listed.providers, []);
  assert.deepEqual((await f.files.link(skill.dir)).providers, ['claude', 'codex']);
});

test('links to a Tower skill in a git project are kept out of git status, and put back in when it is deleted', async t => {
  const f = await homes(t);
  const repo = join(f.home, 'work', 'shop');
  await mkdir(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const skill = await f.files.save({ scope: 'project', cwd: repo, name: 'deploy', description: 'd', body: 'b' });
  const exclude = join(repo, '.git', 'info', 'exclude');
  assert.match(await readFile(exclude, 'utf8'), /^\/\.agents\/skills\/deploy\n\/\.claude\/skills\/deploy$/m);
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString().trim(), '');
  await f.files.remove(skill.dir, repo);
  assert.doesNotMatch(await readFile(exclude, 'utf8'), /deploy/);
});

test('a backup file is checked before use: names, paths inside a skill and SKILL.md', () => {
  const skill = (files: object[]) => ({ format: 'agent-session-tower.skills', version: 1, skills: [{ name: 'x', scope: 'global', files }] });
  const file = (path: string) => ({ path, mode: 0o644, base64: Buffer.from('a').toString('base64') });
  assert.equal(parseBundle(skill([file('SKILL.md'), file('references/a.md')])).skills[0].files.length, 2);
  for (const path of ['../escape', '/etc/passwd', 'a/../../b', 'a//b', 'a\\b', './SKILL.md']) {
    assert.throws(() => parseBundle(skill([file('SKILL.md'), file(path)])), { statusCode: 400 }, path);
  }
  assert.throws(() => parseBundle(skill([file('notes.md')])), { statusCode: 400 }, 'SKILL.md is required');
  assert.throws(() => parseBundle(skill([file('SKILL.md'), file('SKILL.md')])), { statusCode: 400 });
  assert.throws(() => parseBundle({ ...skill([file('SKILL.md')]), skills: [{ name: 'Bad Name', scope: 'global', files: [file('SKILL.md')] }] }), { statusCode: 400 });
  assert.throws(() => parseBundle({ format: 'other' }), { statusCode: 400 });
});

function session(cwd: string): Session {
  return { id: 'claude:s', nativeId: 's', provider: 'claude', title: 't', cwd, project: 'p', status: 'completed', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
}

async function service(f: Awaited<ReturnType<typeof homes>>, cwds: string[], installGuidance?: () => Promise<void>) {
  const skills = new SkillService({ stateDir: f.state, homes: f, sessions: () => cwds.map(session), runs: () => [], history: async () => [], model: async () => ({}), advise: false, ...(installGuidance ? { installGuidance } : {}) });
  await skills.start();
  return skills;
}

test('chosen Tower skills, their pins and the owner’s guidance go to another computer in one file', async t => {
  const a = await homes(t), b = await homes(t);
  const projectA = join(a.home, 'work', 'shop'), projectB = join(b.home, 'work', 'shop');
  await mkdir(projectA, { recursive: true }); await mkdir(projectB, { recursive: true });
  const from = await service(a, [projectA]);
  await from.mutate('save', { scope: 'global', name: 'review', description: 'Review code.', body: 'Steps', pinned: true });
  await from.mutate('save', { scope: 'project', projectCwd: projectA, cwd: projectA, name: 'deploy', description: 'Deploy.', body: 'Steps' });
  await from.mutate('save', { scope: 'global', name: 'left-out', description: 'Not chosen.', body: 'Steps' });
  const guidance = (await from.overview()).guidance;
  await from.mutate('guidance', { owner: 'Always answer in Korean.', revision: guidance.revision });
  const stored = (await from.overview()).stored;
  assert.deepEqual(stored.map(skill => skill.name).sort(), ['deploy', 'left-out', 'review'], 'every Tower skill, projects included');
  const chosen = stored.filter(skill => skill.name !== 'left-out').map(skill => skill.dir);
  const bundle = JSON.parse(JSON.stringify(await from.exportBundle({ dirs: chosen, guidance: true })));
  assert.equal(bundle.guidance, 'Always answer in Korean.\n');

  let installed = 0;
  const to = await service(b, [projectB], async () => { installed++; });
  await b.files.save({ scope: 'global', name: 'kept', description: 'd', body: 'b' });
  const plan = await to.importPlan(bundle);
  assert.deepEqual(plan.items.map(item => [item.name, item.conflict, item.cwd ?? '']), [['review', 'new', ''], ['deploy', 'new', '']],
    'a project path this computer does not know is left for the owner to choose');
  await to.mutate('import', { bundle, choices: [{ index: 0, action: 'add' }, { index: 1, action: 'add', cwd: projectB }], guidance: 'replace', pins: true });
  const after = await to.overview();
  const review = after.stored.find(skill => skill.name === 'review')!;
  assert.equal(review.pinned, true);
  assert.deepEqual(review.providers, ['claude', 'codex']);
  assert.equal(after.stored.find(skill => skill.name === 'deploy')?.cwd, projectB);
  assert.equal(after.guidance.owner, 'Always answer in Korean.\n');
  assert.equal(installed, 1, 'the agents are given the imported guidance');
  assert.match((await to.turnNotes(session(projectB)))!, /- review: Review code\./);

  // A skill outside Tower by the same name is never replaced; a Tower one is, when asked.
  await external(b.agentsHome, 'outside');
  const outsider = { ...bundle, skills: [{ ...bundle.skills[0], name: 'outside' }] };
  assert.equal((await to.importPlan(outsider)).items[0].conflict, 'external');
  await assert.rejects(to.mutate('import', { bundle: outsider, choices: [{ index: 0, action: 'replace' }] }), { statusCode: 409 });
  assert.match(await readFile(join(b.agentsHome, 'skills', 'outside', 'SKILL.md'), 'utf8'), /name: outside/);
  const changed = { ...bundle, skills: [{ ...bundle.skills[0], files: bundle.skills[0].files.map((file: { path: string }) => file.path === 'SKILL.md' ? { ...file, base64: Buffer.from('---\nname: review\ndescription: New.\n---\nNew steps\n').toString('base64') } : file) }] };
  assert.equal((await to.importPlan(changed)).items[0].conflict, 'managed');
  await to.mutate('import', { bundle: changed, choices: [{ index: 0, action: 'replace' }] });
  assert.match(await readFile(join(review.dir, 'SKILL.md'), 'utf8'), /New steps/);
});

test('a pin on a skill moved into Tower moves with it, and the owner’s guidance reaches both agents', async t => {
  const f = await homes(t);
  const original = await external(f.agentsHome, 'wrangler');
  const skills = await service(f, [f.home]);
  await skills.mutate('pin', { dir: original, pinned: true });
  await skills.mutate('adopt', { dir: original });
  const [moved] = (await skills.overview()).skills;
  assert.equal(moved.managed, true);
  assert.equal(moved.pinned, true);
  assert.match((await skills.turnNotes(session(f.home)))!, new RegExp(`${moved.dir}/SKILL\\.md`));

  await mkdir(join(f.state, 'guidance'), { recursive: true });
  await writeFile(join(f.state, OWNER_GUIDANCE_FILE), 'Answer in Korean.\n');
  await installAgentGuidance({ stateDir: f.state, claudeHome: f.claudeHome, codexHome: f.codexHome });
  assert.match(await readFile(join(f.claudeHome, 'CLAUDE.md'), 'utf8'), new RegExp(`^@${join(f.state, OWNER_GUIDANCE_FILE)}$`, 'm'));
  assert.match(await readFile(join(f.codexHome, 'AGENTS.md'), 'utf8'), /## The owner's own instructions\n\nAnswer in Korean\.\n<!-- agent-session-tower:end -->/);
});
