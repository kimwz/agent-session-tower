import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { initialModelSettings } from '../../../shared/models.js';
import { readModelSettings, readModelSettingsState, resolveModel, saveModelSettings } from '../../../server/models/settings.js';
import { captureErrors, failOpen } from '../../helpers/quarantine.js';
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
  await assert.rejects(saveModelSettings(directory, { ...next, custom: [{ id: 'x', provider: 'codex', claude: {}, codex: {} }] }), { kind: 'invalid' });
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
  assert.deepEqual((await readdir(directory)).filter(name => !name.startsWith('models.json.unreadable-')), ['models.json'], 'only a copy is added beside it');
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

const sha16 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const copiedProblem = (copy: string) => `모델 설정 파일(models.json)을 읽을 수 없어 기본값을 쓰고 있습니다. 원래 파일은 그대로 두고 ${copy}에 복사해 두었습니다. 저장하면 이 화면의 설정으로 바뀝니다.`;
const copies = async (directory: string) => (await readdir(directory)).filter(name => name.startsWith('models.json.unreadable-')).sort();

test('a corrupt settings file is copied aside once, kept, and reported', async t => {
  const directory = await stateDir(t);
  const path = join(directory, 'models.json');
  await writeFile(path, '{ not json', { mode: 0o600 });
  const logged = captureErrors(t, path);
  const copy = `${path}.unreadable-${sha16('{ not json')}`;
  for (let read = 0; read < 3; read++) {
    const state = await readModelSettingsState(directory);
    assert.deepEqual(state.settings, initialModelSettings());
    assert.equal(state.problem, copiedProblem(copy));
  }
  assert.deepEqual(await copies(directory), [basename(copy)]);
  assert.equal(await readFile(copy, 'utf8'), '{ not json');
  assert.equal((await stat(copy)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, 'utf8'), '{ not json', 'the file itself is never renamed or written');
  assert.equal(logged.length, 1, 'logged once per cache fill');
  assert.deepEqual(await readModelSettings(directory), initialModelSettings(), 'readModelSettings keeps its contract');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});

test('a settings file of the wrong shape is treated the same', async t => {
  for (const text of ['[]', 'null']) {
    const directory = await stateDir(t);
    const path = join(directory, 'models.json');
    await writeFile(path, text, { mode: 0o600 });
    captureErrors(t, path);
    const state = await readModelSettingsState(directory);
    assert.deepEqual(state.settings, initialModelSettings());
    assert.equal(state.problem, copiedProblem(`${path}.unreadable-${sha16(text)}`));
    assert.equal(await readFile(`${path}.unreadable-${sha16(text)}`, 'utf8'), text);
  }
});

test('a settings file that cannot be read is not copied and is reported', async t => {
  const directory = await stateDir(t);
  const path = join(directory, 'models.json');
  await writeFile(path, JSON.stringify(initialModelSettings()), { mode: 0o600 });
  const refused = failOpen(t, path);
  captureErrors(t, path);
  const state = await readModelSettingsState(directory);
  assert.ok(refused.hits() >= 1, 'the settings reader was refused after its stat');
  assert.deepEqual(state.settings, initialModelSettings());
  assert.match(state.problem ?? '', /^모델 설정 파일을 읽지 못해 기본값을 쓰고 있습니다: .*EACCES.*\. 파일은 그대로 두었습니다\.$/);
  assert.deepEqual(await copies(directory), []);

  const linked = await stateDir(t);
  await symlink(path, join(linked, 'models.json'));
  const loop = await readModelSettingsState(linked);
  assert.match(loop.problem ?? '', /^모델 설정 파일을 읽지 못해 기본값을 쓰고 있습니다: .*ELOOP/);
  assert.deepEqual(await copies(linked), []);
});

test('two readers with their own cache copy a corrupt file once', async t => {
  const directory = await stateDir(t);
  const other = join(await stateDir(t), 'same');
  await symlink(directory, other);
  await writeFile(join(directory, 'models.json'), '{ not json', { mode: 0o600 });
  captureErrors(t, join(directory, 'models.json'));
  const [first, second] = await Promise.all([readModelSettingsState(directory), readModelSettingsState(other)]);
  assert.ok(first.problem && second.problem);
  assert.deepEqual(await copies(directory), [`models.json.unreadable-${sha16('{ not json')}`]);
});

test('invalid UTF-8 is copied byte for byte', async t => {
  const directory = await stateDir(t);
  const bytes = Buffer.from([0x7b, 0xff]);
  await writeFile(join(directory, 'models.json'), bytes, { mode: 0o600 });
  captureErrors(t, join(directory, 'models.json'));
  await readModelSettingsState(directory);
  assert.deepEqual(await readFile(join(directory, `models.json.unreadable-${sha16(bytes)}`)), bytes);
});

test('two different corrupt contents with the same mtime are both kept', async t => {
  const directory = await stateDir(t);
  const other = join(await stateDir(t), 'same');
  await symlink(directory, other);
  const path = join(directory, 'models.json');
  captureErrors(t, path);
  await writeFile(path, '{ corrupt A', { mode: 0o600 });
  await readModelSettingsState(directory);
  const { mtime } = await stat(path);
  await writeFile(path, '{ corrupt B', { mode: 0o600 });
  await utimes(path, mtime, mtime);
  await readModelSettingsState(other);
  const kept = await copies(directory);
  assert.deepEqual(kept, [`models.json.unreadable-${sha16('{ corrupt A')}`, `models.json.unreadable-${sha16('{ corrupt B')}`].sort());
  assert.deepEqual((await Promise.all(kept.map(name => readFile(join(directory, name), 'utf8')))).sort(), ['{ corrupt A', '{ corrupt B']);
});

test('an explicit save replaces a corrupt file and clears the problem', async t => {
  const directory = await stateDir(t);
  await writeFile(join(directory, 'models.json'), '{ not json', { mode: 0o600 });
  captureErrors(t, join(directory, 'models.json'));
  assert.ok((await readModelSettingsState(directory)).problem);
  const next = initialModelSettings();
  next.roles['slack.match'] = { provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol' } };
  await saveModelSettings(directory, next);
  const state = await readModelSettingsState(directory);
  assert.equal(state.problem, undefined);
  assert.deepEqual(state.settings.roles['slack.match'], next.roles['slack.match']);
  assert.equal(await readFile(join(directory, `models.json.unreadable-${sha16('{ not json')}`), 'utf8'), '{ not json', 'the copy stays');
});

test('a save between reading a corrupt file and copying it keeps both', { timeout: 10_000 }, async t => {
  const directory = await stateDir(t);
  const path = join(directory, 'models.json');
  await writeFile(path, '{ not json', { mode: 0o600 });
  captureErrors(t, path);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const atBarrier = new Promise<void>(resolve => { reached = resolve; });
  t.after(() => release());
  const reading = readModelSettingsState(directory, { afterRead: async () => { reached(); await barrier; } });
  await Promise.race([atBarrier, reading.then(() => { throw new Error('the read finished without reaching afterRead'); })]);
  const next = initialModelSettings();
  next.roles['slack.match'] = { provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol' } };
  const saved = await saveModelSettings(directory, next);
  release();
  await reading;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), saved);
  assert.equal(await readFile(join(directory, `models.json.unreadable-${sha16('{ not json')}`), 'utf8'), '{ not json');
  assert.equal((await readModelSettingsState(directory)).problem, undefined);
});
