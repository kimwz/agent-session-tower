import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ISSUE_SKILL } from '../../../shared/issues.js';
import { SkillService } from '../../../server/skills/service.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-default-skills-')));
  const home = join(root, 'home'), state = join(root, 'state');
  await mkdir(home, { recursive: true });
  const homes = { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'),
    trash: join(state, 'skills-trash'), store: join(state, 'skills'), journal: join(state, 'skills-moves.json') };
  const services: SkillService[] = [];
  const start = async (seed = true) => {
    const service = new SkillService({ stateDir: state, homes, sessions: () => [], runs: () => [], history: async () => [], model: async () => ({}), advise: false, seed });
    await service.start();
    await service.settled();
    services.push(service);
    return service;
  };
  t.after(async () => { for (const service of services) { service.close(); await service.flush().catch(() => {}); } await rm(root, { recursive: true, force: true }); });
  const stored = join(state, 'skills', 'global', ISSUE_SKILL, 'SKILL.md');
  const linked = async () => (await Promise.all([join(homes.agentsHome, 'skills', ISSUE_SKILL), join(homes.claudeHome, 'skills', ISSUE_SKILL)]
    .map(place => lstat(place).then(info => info.isSymbolicLink(), () => false)))).every(Boolean);
  const seeded = async () => (JSON.parse(await readFile(join(state, 'skills.json'), 'utf8')) as { seeded: string[] }).seeded;
  return { homes, state, start, stored, linked, seeded };
}

test('Tower makes the issue skill once, kept in Tower and applied to every project, but not named to every turn', async t => {
  const f = await fixture(t);
  const service = await f.start();
  assert.match(await readFile(f.stored, 'utf8'), new RegExp(`^---\\nname: "?${ISSUE_SKILL}"?`));
  assert.equal(await f.linked(), true, 'Claude Code and Codex both find it');
  const skill = (await service.overview()).stored!.find(item => item.name === ISSUE_SKILL)!;
  assert.deepEqual(skill.targets, { all: true, projects: [] });
  assert.equal(skill.pinned, false);
  assert.deepEqual(await f.seeded(), [ISSUE_SKILL]);
});

test('the owner’s edits and removal stand: the skill is never written or made again', async t => {
  const f = await fixture(t);
  const service = await f.start();
  const dir = join(f.state, 'skills', 'global', ISSUE_SKILL);
  await writeFile(f.stored, (await readFile(f.stored, 'utf8')).replace('# Register an issue', '# Register an issue (mine)'));
  await f.start();
  assert.match(await readFile(f.stored, 'utf8'), /\(mine\)/);
  await service.mutate('delete', { dir });
  await f.start();
  assert.equal(await lstat(f.stored).catch(() => undefined), undefined, 'not made again after the owner removed it');
  assert.equal(await f.linked(), false);
});

test('a skill of the same name the owner already has keeps Tower from making one', async t => {
  const f = await fixture(t);
  const own = join(f.homes.agentsHome, 'skills', ISSUE_SKILL);
  await mkdir(own, { recursive: true });
  await writeFile(join(own, 'SKILL.md'), `---\nname: ${ISSUE_SKILL}\ndescription: Mine.\n---\nMine\n`);
  await f.start();
  assert.equal(await lstat(f.stored).catch(() => undefined), undefined);
  assert.equal(await readFile(join(own, 'SKILL.md'), 'utf8'), `---\nname: ${ISSUE_SKILL}\ndescription: Mine.\n---\nMine\n`);
  assert.deepEqual(await f.seeded(), [ISSUE_SKILL]);
});

test('a Tower on another state folder makes no default skill in the account', async t => {
  const f = await fixture(t);
  await f.start(false);
  assert.equal(await lstat(f.stored).catch(() => undefined), undefined);
  assert.equal(await f.linked(), false);
});

test('something else of that name where the skill would be linked stays, and Tower does not try again', async t => {
  const f = await fixture(t);
  const other = join(f.homes.claudeHome, 'skills', ISSUE_SKILL);
  await mkdir(other, { recursive: true });
  await writeFile(join(other, 'notes.txt'), 'not a skill');
  await f.start();
  assert.equal(await readFile(join(other, 'notes.txt'), 'utf8'), 'not a skill');
  assert.equal(await lstat(f.stored).catch(() => undefined), undefined);
  assert.deepEqual(await f.seeded(), [ISSUE_SKILL], 'recorded, so no error on every start');
});

test('a skills.json from before default skills gets them made once', async t => {
  const f = await fixture(t);
  await mkdir(f.state, { recursive: true });
  await writeFile(join(f.state, 'skills.json'), JSON.stringify({ version: 1, pinned: [], targets: [], proposals: [], notes: [], excluded: [], reflected: {}, startedAt: '2026-09-01T00:00:00.000Z' }));
  await f.start();
  assert.equal(await f.linked(), true);
  assert.deepEqual(await f.seeded(), [ISSUE_SKILL]);
});
