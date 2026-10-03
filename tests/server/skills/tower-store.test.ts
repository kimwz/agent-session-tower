import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SkillFiles } from '../../../server/skills/files.js';
import { parseBundle, readMoves, writeMoves } from '../../../server/skills/store.js';
import { asideNames, blockQuarantine, captureErrors } from '../../helpers/quarantine.js';
import { SkillService } from '../../../server/skills/service.js';
import { skillsCapability } from '../../../server/runs/durable-runner.js';
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

const aside = (place: string, id: string) => join(dirname(place), `.${basename(place)}.tower-old-${id}`);

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
  await assert.rejects(f.files.adopt(linked), { kind: 'conflict' });
  await external(f.agentsHome, 'tmux', 'Codex panes');
  await external(f.claudeHome, 'tmux', 'Claude panes');
  await assert.rejects(f.files.adopt(join(f.agentsHome, 'skills', 'tmux')), { kind: 'conflict' });
  assert.ok((await lstat(join(f.claudeHome, 'skills', 'tmux'))).isDirectory(), 'nothing moved');
  // Identical copies are merged first, then moved as one.
  await external(f.agentsHome, 'same');
  await external(f.claudeHome, 'same');
  const { skill } = await f.files.adopt(join(f.claudeHome, 'skills', 'same'));
  assert.equal(skill.copies, undefined);
  assert.equal(await realpath(join(f.claudeHome, 'skills', 'same')), skill.dir);
  assert.equal(await realpath(join(f.agentsHome, 'skills', 'same')), skill.dir);
});

test('a move a crash interrupted is undone before its copy is complete, and finished after, at every step', async t => {
  const f = await homes(t);
  await mkdir(join(f.store, 'global'), { recursive: true });
  const id = (n: number) => `0000000${n}`;
  const move = async (name: string, n: number, copied: boolean) => {
    const from = await external(f.agentsHome, name);
    const to = join(f.store, 'global', name);
    if (copied) execFileSync('cp', ['-R', from, to]);
    return { id: id(n), to, incoming: join(f.store, 'global', `.incoming-${id(n)}`), places: [from] };
  };
  // Stopped while copying: the copy goes, the skill stays where it was.
  const copying = await move('copying', 1, false);
  execFileSync('cp', ['-R', copying.places[0], copying.incoming]);
  // Stopped after the copy, before the swap: the swap is done now.
  const copied = await move('copied', 2, true);
  // Stopped between putting the original aside and the link in its place: the link is put there.
  const halfway = await move('aside', 3, true);
  await rename(halfway.places[0], aside(halfway.places[0], halfway.id));
  // Stopped after the swap: the rest is done.
  const swapped = await move('swapped', 4, true);
  await rename(swapped.places[0], aside(swapped.places[0], swapped.id));
  await symlink(swapped.to, swapped.places[0], 'dir');
  await writeMoves(f.journal, [copying, copied, halfway, swapped]);
  const finished = await f.files.recover();
  assert.deepEqual(finished.map(item => item.id).sort(), [copied.id, halfway.id, swapped.id]);
  assert.ok((await lstat(copying.places[0])).isDirectory());
  await assert.rejects(lstat(copying.incoming));
  for (const item of [copied, halfway, swapped]) {
    assert.equal(await readlink(item.places[0]), item.to);
    await assert.rejects(lstat(aside(item.places[0], item.id)));
    assert.equal(await realpath(join(f.claudeHome, 'skills', item.places[0].split('/').at(-1)!)), item.to, 'the other agent is linked too');
  }
  assert.deepEqual(JSON.parse(await readFile(f.journal, 'utf8')), []);
  assert.equal((await readdir(f.trash)).length, 3);
});

test('identical copies moved into Tower are all recorded, so a crash between them is finished too', async t => {
  const f = await homes(t);
  const codex = await external(f.agentsHome, 'same'), claude = await external(f.claudeHome, 'same');
  const to = join(f.store, 'global', 'same');
  await mkdir(join(f.store, 'global'), { recursive: true });
  execFileSync('cp', ['-R', codex, to]);
  // The first place was swapped; the crash came before the Claude copy was.
  await rename(codex, aside(codex, '00000009'));
  await symlink(to, codex, 'dir');
  await writeMoves(f.journal, [{ id: '00000009', to, incoming: join(f.store, 'global', '.incoming-00000009'), places: [codex, claude] }]);
  await f.files.recover();
  assert.equal(await readlink(codex), to);
  assert.equal(await readlink(claude), to);
  assert.equal((await readdir(f.trash)).length, 2);
});

test('recovery never touches anything outside Tower’s own folder', async t => {
  const f = await homes(t);
  const elsewhere = join(f.root, 'elsewhere');
  await mkdir(join(elsewhere, '.incoming-abcdef12'), { recursive: true });
  await mkdir(join(elsewhere, '.x.tower-old-abcdef12'), { recursive: true });
  await mkdir(f.store, { recursive: true });
  await symlink(elsewhere, join(f.store, 'global'));
  await writeMoves(f.journal, [{ id: 'abcdef12', to: join(elsewhere, 'x'), incoming: join(elsewhere, '.incoming-abcdef12'), places: [join(f.agentsHome, 'skills', 'x')] }]);
  await f.files.recover();
  assert.deepEqual((await readdir(elsewhere)).sort(), ['.incoming-abcdef12', '.x.tower-old-abcdef12']);
  assert.deepEqual(JSON.parse(await readFile(f.journal, 'utf8')), []);
});

test('an import that stopped while replacing a Tower skill gets the old one back', async t => {
  const f = await homes(t);
  const global = join(f.store, 'global');
  await mkdir(join(global, '.review.tower-old-abcdef12'), { recursive: true });
  await writeFile(join(global, '.review.tower-old-abcdef12', 'SKILL.md'), '---\nname: review\ndescription: d\n---\nold\n');
  await mkdir(join(global, '.incoming-abcdef12'), { recursive: true });
  await f.files.recover();
  assert.deepEqual(await readdir(global), ['review']);
  assert.match(await readFile(join(global, 'review', 'SKILL.md'), 'utf8'), /old/);
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

test('links to a Tower skill in a git project are kept out of git status, and the lines stay for other worktrees', async t => {
  const f = await homes(t);
  const repo = join(f.home, 'work', 'shop');
  await mkdir(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const skill = await f.files.save({ scope: 'project', cwd: repo, name: 'deploy', description: 'd', body: 'b' });
  const exclude = join(repo, '.git', 'info', 'exclude');
  assert.match(await readFile(exclude, 'utf8'), /^\/\.agents\/skills\/deploy\n\/\.claude\/skills\/deploy$/m);
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString().trim(), '');
  await f.files.remove(skill.dir, repo);
  assert.match(await readFile(exclude, 'utf8'), /deploy/, 'other worktrees of the repository share these lines');
  // A folder git tracks (a skill the repository shares) is never moved into Tower.
  await mkdir(join(repo, '.agents', 'skills', 'shared'), { recursive: true });
  await writeFile(join(repo, '.agents', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: d\n---\n');
  execFileSync('git', ['-C', repo, 'add', '.agents/skills/shared']);
  await assert.rejects(f.files.adopt(join(repo, '.agents', 'skills', 'shared'), repo), { kind: 'conflict' });
  assert.ok((await lstat(join(repo, '.agents', 'skills', 'shared'))).isDirectory());
});

test('a git exclude file that is a link is left alone', async t => {
  const f = await homes(t);
  const repo = join(f.home, 'work', 'linked');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const outside = join(f.root, 'settings.json');
  await writeFile(outside, '{"keep":true}');
  await rm(join(repo, '.git', 'info', 'exclude'), { force: true });
  await symlink(outside, join(repo, '.git', 'info', 'exclude'));
  await f.files.save({ scope: 'project', cwd: repo, name: 'deploy', description: 'd', body: 'b' });
  assert.equal(await readFile(outside, 'utf8'), '{"keep":true}');
});

test('a backup file is checked before use: names, paths inside a skill and SKILL.md', () => {
  const skill = (files: object[]) => ({ format: 'agent-session-tower.skills', version: 1, skills: [{ name: 'x', scope: 'global', files }] });
  const file = (path: string) => ({ path, mode: 0o644, base64: Buffer.from('a').toString('base64') });
  assert.equal(parseBundle(skill([file('SKILL.md'), file('references/a.md')])).skills[0].files.length, 2);
  for (const path of ['../escape', '/etc/passwd', 'a/../../b', 'a//b', 'a\\b', './SKILL.md']) {
    assert.throws(() => parseBundle(skill([file('SKILL.md'), file(path)])), { kind: 'invalid' }, path);
  }
  assert.throws(() => parseBundle(skill([file('notes.md')])), { kind: 'invalid' }, 'SKILL.md is required');
  assert.throws(() => parseBundle(skill([file('SKILL.md'), file('SKILL.md')])), { kind: 'invalid' });
  assert.throws(() => parseBundle({ ...skill([file('SKILL.md')]), skills: [{ name: 'Bad Name', scope: 'global', files: [file('SKILL.md')] }] }), { kind: 'invalid' });
  assert.throws(() => parseBundle({ format: 'other' }), { kind: 'invalid' });
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
  const guidance = (await from.overview()).guidance!;
  await from.mutate('guidance', { owner: 'Always answer in Korean.', revision: guidance.revision });
  const stored = (await from.overview()).stored!;
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
  const review = after.stored!.find(skill => skill.name === 'review')!;
  assert.equal(review.pinned, true);
  assert.deepEqual(review.providers, ['claude', 'codex']);
  assert.equal(after.stored!.find(skill => skill.name === 'deploy')?.cwd, projectB);
  assert.equal(after.guidance!.owner, 'Always answer in Korean.\n');
  assert.equal(installed, 1, 'the agents are given the imported guidance');
  assert.match((await to.turnNotes(session(projectB)))!, /- review: Review code\./);

  // A skill outside Tower by the same name is never replaced; a Tower one is, when asked.
  await external(b.agentsHome, 'outside');
  const outsider = { ...bundle, skills: [{ ...bundle.skills[0], name: 'outside' }] };
  assert.equal((await to.importPlan(outsider)).items[0].conflict, 'external');
  await assert.rejects(to.mutate('import', { bundle: outsider, choices: [{ index: 0, action: 'replace' }] }), { kind: 'conflict' });
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
  const state = JSON.parse(await readFile(join(f.state, 'skills.json'), 'utf8')) as { pinned: { dir: string }[] };
  assert.deepEqual(state.pinned.map(pin => pin.dir), [moved.dir], 'the pin itself names the stored folder');
  // A stale page asking to move it again changes nothing, the pin included.
  await skills.mutate('adopt', { dir: moved.dir });
  assert.equal((await skills.overview()).skills[0].pinned, true);
  assert.match((await skills.turnNotes(session(f.home)))!, new RegExp(`${moved.dir}/SKILL\\.md`));

  await mkdir(join(f.state, 'guidance'), { recursive: true });
  await writeFile(join(f.state, OWNER_GUIDANCE_FILE), 'Answer in Korean.\n');
  await installAgentGuidance({ stateDir: f.state, claudeHome: f.claudeHome, codexHome: f.codexHome });
  assert.match(await readFile(join(f.claudeHome, 'CLAUDE.md'), 'utf8'), new RegExp(`^@${join(f.state, OWNER_GUIDANCE_FILE)}$`, 'm'));
  assert.match(await readFile(join(f.codexHome, 'AGENTS.md'), 'utf8'), /## The owner's own instructions\n\nAnswer in Korean\.\n<!-- agent-session-tower:end -->/);
});

test('the owner’s guidance: two saves of one revision never both win, Tower’s markers are dropped, and a partial import leaves it alone', async t => {
  const f = await homes(t);
  const skills = await service(f, []);
  const { revision } = (await skills.overview()).guidance!;
  const results = await Promise.allSettled(['First', 'Second'].map(owner => skills.mutate('guidance', { owner, revision })));
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const current = (await skills.overview()).guidance!;
  await skills.mutate('guidance', { owner: 'Keep\n<!-- agent-session-tower:end -->\n<!-- agent-session-tower:off -->\nThis', revision: current.revision });
  assert.equal((await skills.overview()).guidance!.owner, 'Keep\nThis\n');
  const bundle = { format: 'agent-session-tower.skills', version: 1, exportedAt: '', from: '', guidance: 'Imported rule',
    skills: [{ name: 'broken', scope: 'global', pinned: false, description: 'd', files: [{ path: 'SKILL.md', mode: 0o644, base64: Buffer.from('x').toString('base64') }] }] };
  await external(f.agentsHome, 'broken');
  await assert.rejects(skills.mutate('import', { bundle, choices: [{ index: 0, action: 'add' }], guidance: 'append' }), { kind: 'conflict' });
  assert.equal((await skills.overview()).guidance!.owner, 'Keep\nThis\n', 'nothing to add twice on a retry');
});

test('the copy Tower keeps is the one listed and kept when an identical outside copy appears', async t => {
  const f = await homes(t);
  const stored = await f.files.save({ scope: 'global', name: 'same', description: 'd', body: 'b' });
  await mkdir(join(f.codexHome, 'skills'), { recursive: true });
  execFileSync('cp', ['-R', stored.dir, join(f.codexHome, 'skills', 'same')]);
  const [listed] = await f.files.list();
  assert.equal(listed.dir, stored.dir);
  assert.equal(listed.managed, true);
  await f.files.merge(listed.dir);
  assert.ok((await lstat(stored.dir)).isDirectory(), 'the stored copy stays');
  assert.equal(await realpath(join(f.codexHome, 'skills', 'same')), stored.dir);
});

test('one move that cannot be settled never stops the others, and an unreadable move record is set aside', async t => {
  const f = await homes(t);
  await mkdir(join(f.store, 'global'), { recursive: true });
  const stuckFolder = join(f.root, 'locked');
  await mkdir(stuckFolder, { recursive: true });
  const stuck = join(stuckFolder, 'stuck');
  await mkdir(stuck); await writeFile(join(stuck, 'SKILL.md'), '---\nname: stuck\ndescription: d\n---\n');
  execFileSync('cp', ['-R', stuck, join(f.store, 'global', 'stuck')]);
  const { chmod } = await import('node:fs/promises');
  await chmod(stuckFolder, 0o555);
  const ok = await external(f.agentsHome, 'ok');
  execFileSync('cp', ['-R', ok, join(f.store, 'global', 'ok')]);
  await writeMoves(f.journal, [
    { id: '00000001', to: join(f.store, 'global', 'stuck'), incoming: join(f.store, 'global', '.incoming-00000001'), places: [stuck] },
    { id: '00000002', to: join(f.store, 'global', 'ok'), incoming: join(f.store, 'global', '.incoming-00000002'), places: [ok] },
  ]);
  const finished = await f.files.recover().finally(() => chmod(stuckFolder, 0o755));
  assert.deepEqual(finished.map(move => move.id), ['00000002']);
  assert.equal(await readlink(ok), join(f.store, 'global', 'ok'));
  assert.deepEqual((JSON.parse(await readFile(f.journal, 'utf8')) as { id: string }[]).map(move => move.id), ['00000001'], 'kept for the next start');

  await writeFile(f.journal, '{not json');
  assert.deepEqual(await f.files.recover(), []);
  assert.ok((await readdir(f.state)).some(name => name.startsWith('skills-moves.json.unreadable-')));
});

test('an unreadable move record is logged after it is set aside', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-skill-moves-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'skills-moves.json');
  const logged = captureErrors(t, path);
  // Two moves within one millisecond would share a name.
  let now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now++);
  for (const text of ['{not json', '{}']) {
    await writeFile(path, text, { mode: 0o600 });
    assert.deepEqual(await readMoves(path), []);
    assert.equal(logged.at(-1)!.args[0], 'The skill move record could not be read and was set aside.');
    assert.equal(logged.at(-1)!.present, false, 'logged after the move');
  }
  assert.deepEqual((await Promise.all((await asideNames(path)).map(name => readFile(join(dir, name), 'utf8')))).sort(), ['{not json', '{}'].sort());
  clock.mock.restore();

});

test('a skill move record that cannot be moved aside is not replaced', async t => {
  const f = await homes(t);
  await mkdir(f.state, { recursive: true });
  await writeFile(f.journal, '{not json', { mode: 0o600 });
  const blocked = await blockQuarantine(t, f.journal);
  const logged = captureErrors(t, f.journal);
  await assert.rejects(readMoves(f.journal), SyntaxError);
  await assert.rejects(f.files.recover(), SyntaxError);
  blocked.release();
  assert.equal(await readFile(f.journal, 'utf8'), '{not json');
  assert.deepEqual(await readdir(blocked.aside), ['occupied'], 'the move failed');
  assert.equal(logged[0].args[0], 'The skill move record could not be read and was set aside.');
});

test('an older execution worker is never asked for what came with Tower’s own skill folder', () => {
  for (const [operation, action] of [['skillsExport'], ['skillsImportPlan'], ['skillsMutate', 'adopt'], ['skillsMutate', 'guidance'], ['skillsMutate', 'import']]) {
    assert.equal(skillsCapability(operation, [action]), 'towerSkills', `${operation} ${action ?? ''}`);
  }
  for (const [operation, action] of [['skillsOverview'], ['skillsDetail'], ['skillsSummary'], ['skillsMutate', 'save'], ['skillsMutate', 'merge'], ['skillsMutate', 'pin']]) {
    assert.equal(skillsCapability(operation, [action]), 'skills', `${operation} ${action ?? ''}`);
  }
});

test('a project skill moved into Tower goes to that project’s folder in Tower and stays out of git status', async t => {
  const f = await homes(t);
  const repo = join(f.home, 'work', 'shop');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const original = join(repo, '.agents', 'skills', 'deploy');
  await mkdir(original, { recursive: true });
  await writeFile(join(original, 'SKILL.md'), '---\nname: deploy\ndescription: d\n---\nSteps\n');
  const { skill } = await f.files.adopt(original, repo);
  assert.match(skill.dir, new RegExp(`^${f.store}/projects/shop-[0-9a-f]{8}/deploy$`));
  assert.deepEqual(JSON.parse(await readFile(join(skill.dir, '..', 'project.json'), 'utf8')), { cwd: repo });
  assert.equal(await readlink(original), skill.dir);
  assert.equal(await readlink(join(repo, '.claude', 'skills', 'deploy')), skill.dir);
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString().trim(), '');
});
