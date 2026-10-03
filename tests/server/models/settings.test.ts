import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialModelSettings } from '../../../shared/models.js';
import { readModelSettings, resolveModel, saveModelSettings } from '../../../server/models/settings.js';
import { modelRoleNotes } from '../../../server/models/notes.js';
import { runModelsCommand } from '../../../server/models/cli.js';

async function stateDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tower-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a Tower without model settings keeps every model it used, the owner\'s earlier reviewer and advisor choices included', async t => {
  const fresh = await stateDir(t);
  assert.deepEqual(await readModelSettings(fresh), initialModelSettings());
  assert.deepEqual(JSON.parse(await readFile(join(fresh, 'models.json'), 'utf8')), initialModelSettings(), 'saved once');
  assert.equal((await stat(join(fresh, 'models.json'))).mode & 0o777, 0o600);

  const chosen = await stateDir(t);
  await writeFile(join(chosen, 'permissions.json'), JSON.stringify({ rules: [], autoReview: { enabled: true, provider: 'codex', model: 'gpt-5.6-terra', resume: true } }));
  await writeFile(join(chosen, 'skills.json'), JSON.stringify({ settings: { enabled: true, provider: 'codex' } }));
  assert.deepEqual(await resolveModel(chosen, 'permissions.reviewer'), { provider: 'codex', model: 'gpt-5.6-terra' });
  assert.deepEqual(await resolveModel(chosen, 'skills.advisor'), { provider: 'codex', model: 'gpt-5.6-terra' });
  // Later changes to the old files no longer move it.
  await writeFile(join(chosen, 'permissions.json'), JSON.stringify({ rules: [], autoReview: { enabled: true, provider: 'claude', model: 'sonnet', resume: true } }));
  assert.deepEqual(await resolveModel(chosen, 'permissions.reviewer'), { provider: 'codex', model: 'gpt-5.6-terra' });

  const odd = await stateDir(t);
  await writeFile(join(odd, 'permissions.json'), JSON.stringify({ autoReview: { enabled: true, provider: 'claude', model: 'haiku' } }));
  assert.deepEqual(await resolveModel(odd, 'permissions.reviewer'), { provider: 'claude', model: 'opus' }, 'a model the reviewer never accepted ran as the first one');
});

test('a saved change reaches the next call; one bad entry never breaks the others', async t => {
  const directory = await stateDir(t);
  assert.deepEqual(await resolveModel(directory, 'slack.match', { provider: 'codex' }), { provider: 'codex', model: 'gpt-5.6-sol' });
  const next = initialModelSettings();
  next.roles['slack.match'] = { provider: 'follow', claude: { model: 'sonnet', effort: 'low' }, codex: { model: 'gpt-6.1-sol', effort: 'medium' } };
  await saveModelSettings(directory, next);
  assert.deepEqual(await resolveModel(directory, 'slack.match', { provider: 'codex' }), { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
  assert.deepEqual(await resolveModel(directory, 'slack.match', { provider: 'claude' }), { provider: 'claude', model: 'sonnet', effort: 'low' });
  // A rule's own model wins for its reply-intent judgment, as before.
  assert.deepEqual(await resolveModel(directory, 'slack.replyIntent', { provider: 'codex', override: { provider: 'codex', model: 'gpt-5.5' } }), { provider: 'codex', model: 'gpt-5.5' });
  // A Claude rule's model never goes to Codex: with the role on Codex, the role's model is used.
  const codexIntent = structuredClone(next);
  codexIntent.roles['slack.replyIntent'] = { provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol' } };
  await saveModelSettings(directory, codexIntent);
  assert.deepEqual(await resolveModel(directory, 'slack.replyIntent', { provider: 'claude', override: { provider: 'claude', model: 'opus' } }), { provider: 'codex', model: 'gpt-6.1-sol' });
  await saveModelSettings(directory, next);
  await assert.rejects(saveModelSettings(directory, { ...next, custom: [{ id: 'x', provider: 'codex', claude: {}, codex: {} }] }), { statusCode: 400 });
  // Written by hand or by another process: read again, and an invalid role falls back to its initial value.
  const saved = JSON.parse(await readFile(join(directory, 'models.json'), 'utf8'));
  saved.roles['autoPrompt.router'] = { provider: 'gemini', claude: {}, codex: {} };
  saved.roles['voice.firstReply'] = { provider: 'claude', claude: { model: 'sonnet' }, codex: {} };
  await writeFile(join(directory, 'models.json'), JSON.stringify(saved, null, 1));
  assert.deepEqual(await resolveModel(directory, 'autoPrompt.router', { provider: 'claude' }), { provider: 'claude', model: 'opus' });
  assert.deepEqual(await resolveModel(directory, 'voice.firstReply'), { provider: 'claude', model: 'sonnet' });
  await writeFile(join(directory, 'models.json'), '{ not json');
  assert.deepEqual(await readModelSettings(directory), initialModelSettings());
});

test('skill roles read the same from the turn table, the CLI and the settings', async t => {
  const directory = await stateDir(t);
  assert.equal(await modelRoleNotes(directory), undefined, 'no table without skill roles');
  await saveModelSettings(directory, { ...initialModelSettings(), custom: [{ id: 'review.codex', provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol', effort: 'high' } }] });
  const notes = await modelRoleNotes(directory);
  assert.match(notes!, /models_get/);
  assert.match(notes!, /^- review\.codex = codex \/ gpt-6\.1-sol \/ high$/m);
  const lines: string[] = [];
  await runModelsCommand(['args', 'review.codex', '--state-dir', directory], line => lines.push(line));
  await runModelsCommand(['get', 'review.codex', '--state-dir', directory], line => lines.push(line));
  await runModelsCommand(['list', '--state-dir', directory], line => lines.push(line));
  assert.equal(lines[0], '-m gpt-6.1-sol -c model_reasoning_effort=high');
  assert.deepEqual(JSON.parse(lines[1]!), { role: 'review.codex', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', args: ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high'] });
  assert.ok(lines.includes('autoPrompt.router = follow / opus / default'));
  assert.ok(lines.includes('review.codex = codex / gpt-6.1-sol / high'));
  await assert.rejects(runModelsCommand(['args', 'review.gemini', '--state-dir', directory], () => {}), /review\.gemini/);
});

test('backups carry the model settings; a restore applies them to the next call and drops roles this version does not know', async t => {
  const { applyWorkerFiles, collectWorkerFiles } = await import('../../../server/backup/payload.js');
  const from = await stateDir(t), to = await stateDir(t);
  const chosen = initialModelSettings();
  chosen.roles['publicAgents.judge'] = { provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol', effort: 'low' } };
  await saveModelSettings(from, chosen);
  const files = await collectWorkerFiles(from);
  assert.deepEqual(files['models.json'], chosen);
  await readModelSettings(to);
  const result = await applyWorkerFiles(to, { 'models.json': { ...chosen, roles: { ...chosen.roles, 'future.role': { provider: 'claude', claude: {}, codex: {} } } } });
  assert.ok(result.parts.includes('models'));
  assert.deepEqual(await resolveModel(to, 'publicAgents.judge', { provider: 'claude' }), { provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
  assert.equal((await readModelSettings(to) as any).roles['future.role'], undefined);
});

test('the first settings never replace ones saved meanwhile', async t => {
  const directory = await stateDir(t);
  const chosen = initialModelSettings();
  chosen.roles['chat.new'] = { provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol' } };
  // Two readers migrate while the owner saves: whichever finishes last, the owner's save stays.
  await Promise.all([readModelSettings(directory), saveModelSettings(directory, chosen), readModelSettings(directory)]);
  assert.deepEqual(await resolveModel(directory, 'chat.new'), { provider: 'codex', model: 'gpt-6.1-sol' });
});

test('reading a corrupt settings file never writes it', async t => {
  const directory = await stateDir(t);
  const path = join(directory, 'models.json');
  await writeFile(path, '{ not json', { mode: 0o600 });
  for (let read = 0; read < 3; read++) {
    assert.deepEqual(await readModelSettings(directory), initialModelSettings());
    assert.deepEqual(await resolveModel(directory, 'slack.match', { provider: 'codex' }), { provider: 'codex', model: 'gpt-5.6-sol' });
  }
  assert.equal(await readFile(path, 'utf8'), '{ not json');
  assert.deepEqual(await readdir(directory), ['models.json']);
});

test('a restore skips a settings file this computer cannot parse', async t => {
  const { applyWorkerFiles } = await import('../../../server/backup/payload.js');
  const directory = await stateDir(t);
  const path = join(directory, 'models.json');
  await writeFile(path, '{ not json', { mode: 0o600 });
  const result = await applyWorkerFiles(directory, { 'models.json': initialModelSettings() });
  assert.equal(result.parts.includes('models'), false);
  assert.deepEqual(result.errors, ['models.json: 이 컴퓨터의 파일을 읽지 못해 건너뛰었습니다.']);
  assert.equal(await readFile(path, 'utf8'), '{ not json');
});
