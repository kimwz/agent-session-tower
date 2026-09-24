import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GUIDANCE_FILE, installAgentGuidance, OPT_OUT } from '../../../server/agent-guidance/install.js';
import { AGENT_GUIDANCE } from '../../../server/agent-guidance/guidance.js';

async function homes(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-guidance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = { stateDir: join(dir, 'state'), claudeHome: join(dir, 'claude'), codexHome: join(dir, 'codex') };
  await mkdir(result.claudeHome); await mkdir(result.codexHome);
  return result;
}

test('Claude imports the guidance Tower keeps in its state directory, and Codex carries the text itself', async t => {
  const paths = await homes(t);
  assert.deepEqual(await installAgentGuidance(paths), { claude: 'written', codex: 'written' });
  const guidanceFile = join(paths.stateDir, GUIDANCE_FILE);
  assert.equal(await readFile(guidanceFile, 'utf8'), AGENT_GUIDANCE);
  const claude = await readFile(join(paths.claudeHome, 'CLAUDE.md'), 'utf8');
  assert.match(claude, new RegExp(`^@${guidanceFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.doesNotMatch(claude, /Keep git branches in sync/);
  const codex = await readFile(join(paths.codexHome, 'AGENTS.md'), 'utf8');
  assert.ok(codex.includes(AGENT_GUIDANCE.trimEnd()));
  assert.deepEqual(await installAgentGuidance(paths), { claude: 'unchanged', codex: 'unchanged' });
});

test('the owner’s own instructions stay around Tower’s section, and an older section is replaced in place', async t => {
  const paths = await homes(t);
  const file = join(paths.codexHome, 'AGENTS.md');
  await writeFile(file, '# Mine\n\nAlways answer in Korean.\n\n<!-- agent-session-tower:begin (managed by Agent Session Tower; replaced when it starts) -->\nold text\n<!-- agent-session-tower:end -->\n\n## After\nKeep this.\n');
  await installAgentGuidance(paths);
  const text = await readFile(file, 'utf8');
  assert.ok(text.startsWith('# Mine\n\nAlways answer in Korean.\n\n<!-- agent-session-tower:begin'));
  assert.ok(text.endsWith('<!-- agent-session-tower:end -->\n\n## After\nKeep this.\n'));
  assert.doesNotMatch(text, /old text/);
  assert.equal(text.match(/agent-session-tower:begin/g)?.length, 1);
});

test('an opt-out marker, a missing provider home and Codex’s override file are respected', async t => {
  const paths = await homes(t);
  await writeFile(join(paths.claudeHome, 'CLAUDE.md'), `mine\n${OPT_OUT}\n`);
  await writeFile(join(paths.codexHome, 'AGENTS.override.md'), 'override\n');
  assert.deepEqual(await installAgentGuidance(paths), { claude: 'opted-out', codex: 'written' });
  assert.equal(await readFile(join(paths.claudeHome, 'CLAUDE.md'), 'utf8'), `mine\n${OPT_OUT}\n`);
  assert.match(await readFile(join(paths.codexHome, 'AGENTS.override.md'), 'utf8'), /^override\n\n<!-- agent-session-tower:begin/);
  await assert.rejects(stat(join(paths.codexHome, 'AGENTS.md')));

  await rm(paths.codexHome, { recursive: true });
  assert.equal((await installAgentGuidance(paths)).codex, 'not-installed');
  await assert.rejects(stat(paths.codexHome), 'a provider that is not set up gets no home created');
});

test('an instruction file linked from a dotfiles repository stays a link and its target is updated', async t => {
  const paths = await homes(t);
  const target = join(paths.stateDir, '..', 'dotfiles-CLAUDE.md');
  await writeFile(target, 'dotfiles\n', { mode: 0o640 });
  await symlink(target, join(paths.claudeHome, 'CLAUDE.md'));
  await installAgentGuidance(paths);
  assert.ok((await lstat(join(paths.claudeHome, 'CLAUDE.md'))).isSymbolicLink());
  assert.equal(await readlink(join(paths.claudeHome, 'CLAUDE.md')), target);
  assert.match(await readFile(target, 'utf8'), /^dotfiles\n\n<!-- agent-session-tower:begin/);
  assert.equal((await stat(target)).mode & 0o777, 0o640);
});
