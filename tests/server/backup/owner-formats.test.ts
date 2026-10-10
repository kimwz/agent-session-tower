import { empty, serializeState } from '../../../server/triggers/state.js';
import { workerSettingsFixture, backupPermissionRule as permissionRule, backupPermissionRequest as permissionRequest, backupWorkflow } from '../remote/external-storage-fixture.js';
import { collectTriggers as collectLegacyTriggers } from '../../helpers/legacy-trigger-backup.js';
/**
 * What a backup keeps of each part of Tower, how a restore merges it with this computer's, and the files a restore
 * stages, pinned before those rules move to the parts that own them. Fixtures under fixtures/ were made by the released
 * code of each version (fixtures/make-backup.ts, fixtures/payload-of.ts).
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { applyWorkerFiles as applyOwnedWorkerFiles, collectWorkerFiles as collectOwnedWorkerFiles, parsePayload, payloadParts } from '../../../server/backup/payload.js';
import { collectEncryptedVault, importPendingSecret, listPendingSecretImports, stageLegacyImport, stageVaultImport } from '../../../server/backup/secrets.js';
import { readPendingWorker, readReport, takeWorkerRestore as takeOwnedWorkerRestore, writePendingWorker } from '../../../server/backup/restore-files.js';
import { BackupService } from '../../../server/backup/service.js';
import { decryptBackup } from '../../../server/backup/crypto.js';
import { SecretService } from '../../../server/secrets/service.js';
import { SecretStore } from '../../../server/triggers/secrets.js';
import { TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';
import type { TriggerBackup } from '../../../server/triggers/backup.js';
import { initialModelSettings } from '../../../shared/models.js';
import type { TriggerActor, TriggerInput } from '../../../shared/triggers.js';
import type { Run } from '../../../shared/types.js';
import { payloadOf } from './fixtures/payload-of.ts';

const collectTriggers = async (stateDir: string) => (await workerSettingsFixture(stateDir)).triggersBackup();
const collectWorkerFiles = async (stateDir: string) => collectOwnedWorkerFiles(stateDir, (await workerSettingsFixture(stateDir)).collect);
const applyWorkerFiles = async (stateDir: string, files: Parameters<typeof applyOwnedWorkerFiles>[1]) => applyOwnedWorkerFiles(stateDir, files, (await workerSettingsFixture(stateDir)).owner);
const takeWorkerRestore = async (stateDir: string) => takeOwnedWorkerRestore(stateDir, (await workerSettingsFixture(stateDir)).owner);
const sqlFile = (name: string): name is import('../../../server/backup/payload.js').WorkerSqlFile => ['permissions.json', 'slack-automation.json', 'github-automation.json'].includes(name);
const FIXTURES = join(import.meta.dirname, 'fixtures');
const PASS = 'fixture backup passphrase';
const VAULT_PASSWORD = 'fixture vault password 1';
const OWNER: TriggerActor = { kind: 'owner', via: 'ui' };
const RULE = { id: 'rule', name: 'Rule', enabled: true, condition: 'Asked', instructions: 'Answer', replyInstructions: 'Reply', provider: 'codex' };
const secret = (id: string, value = `Bearer ${id}`) => ({ id, name: `Secret ${id}`, origin: 'https://status.example.com', value, createdAt: '2026-10-01T00:00:00.000Z' });

async function dir(t: TestContext, prefix = 'tower-owner-formats-'): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const settings = await workerSettingsFixture(path);
  t.after(async () => { await settings.close(); await rm(path, { recursive: true, force: true }); });
  return path;
}
const write = async (stateDir: string, name: string, value: unknown) => {
  await mkdir(join(stateDir, name, '..'), { recursive: true });
  await writeFile(join(stateDir, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  if (sqlFile(name) && typeof value !== 'string' && !Array.isArray(value)) await (await workerSettingsFixture(stateDir)).seed(name, value);
};
const read = async (stateDir: string, name: string) => name === 'trigger-engine.json'
  ? serializeState(await (await workerSettingsFixture(stateDir)).triggerState()) : sqlFile(name)
  ? JSON.stringify(await (await workerSettingsFixture(stateDir)).read(name)) : readFile(join(stateDir, name), 'utf8');
const mode = async (path: string) => (await stat(path)).mode & 0o777;
async function vault(stateDir: string) { const service = new SecretService({ stateDir }); await service.start(); await service.initialize(VAULT_PASSWORD); return service; }

async function backupService(t: TestContext, stateDir: string) {
  const store = (value: unknown) => ({ backupValue: () => structuredClone(value), restore: async () => undefined });
  const service = new BackupService({ stateDir, settings: (await workerSettingsFixture(stateDir)).collect, triggers: () => collectTriggers(stateDir), version: 'fixture', restartWorker: async () => true,
    skills: async () => ({ bundle: { format: 'agent-session-tower.skills', version: 1, exportedAt: '', from: 'fixture', skills: [] }, guidance: '', settings: { enabled: true, provider: 'claude' } }),
    stores: { groups: store({ groups: [] }), exclusions: store({ folders: [] }), decisions: store({}) } });
  await service.start();
  (await workerSettingsFixture(stateDir)).beforeClose.push(async () => { service.close(); await service.flush(); });
  return service;
}

/** A trigger engine on `stateDir` with an executor that records runs; `finish` ends the running ones. */
async function engine(t: TestContext, stateDir: string, clock = { now: Date.parse('2026-09-24T00:00:30.000Z') }, secretStore?: SecretStore) {
  const runs: Run[] = [];
  const executor: TriggerExecutor = {
    submitAutoPrompt: async () => { throw new Error('not used'); }, getAutoPrompt: () => undefined,
    create: async (input, internal) => { const run: Run = { id: `run-${runs.length + 1}`, sessionId: `codex:s${runs.length + 1}`, prompt: input.prompt, status: 'running', createdAt: '', output: '', origin: internal.origin };
      runs.push(run); return { run, session: { id: run.sessionId, nativeId: 'n', provider: 'codex', title: '', cwd: stateDir, project: 'p', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } }; },
    enqueue: async () => { throw new Error('not used'); }, runs: () => structuredClone(runs), session: () => undefined,
  };
  const open = async (restore?: TriggerBackup) => {
    const settings = await workerSettingsFixture(stateDir);
    if (!await settings.triggers.databaseAuthority()) await settings.seedTriggers(empty());
    const service = new TriggerService({ storage: settings.storage, stateDir, executor, now: () => clock.now, tickMs: 60_000, ...(secretStore ? { secretStore } : {}) });
    const result = await service.start(restore ? { restore } : {});
    settings.beforeClose.push(async () => { service.close(); await service.settle(); });
    return { service, errors: result.errors };
  };
  return { open, clock, finish: () => { for (const run of runs) if (run.status === 'running') run.status = 'completed'; } };
}
const hourly = (cwd: string, values: Partial<TriggerInput> = {}): TriggerInput => ({ name: 'Hourly', enabled: true,
  source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, catchUp: 'latest' },
  handler: { kind: 'task', instructions: 'Report', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd } }, policy: { overlap: 'skip', maxEventsPerHour: 20 }, ...values });
const once = (cwd: string, at: string, name: string): TriggerInput => hourly(cwd, { name, source: { kind: 'schedule', schedule: { type: 'once', at }, catchUp: 'latest' } });

/** Every worker file with the runtime records a backup must leave out. */
async function workerFiles(stateDir: string) {
  await write(stateDir, 'trigger-secrets.json', [secret('local')]);
  await write(stateDir, 'permissions.json', { version: 1, rules: [permissionRule('r1')], requests: [{ ...permissionRequest('pending'), notification: { state: 'pending', message: 'x' } }], codex: [{ path: '/codex.rules', scope: 'global' }], lost: 'lost note', autoReview: { enabled: true, provider: 'claude', model: 'opus', resume: true } });
  await write(stateDir, 'models.json', initialModelSettings());
  await write(stateDir, 'slack-connection.json', { enabled: true, userToken: 'xoxp-1', appToken: 'xapp-1', account: { teamId: 'T', userId: 'U' } });
  await write(stateDir, 'slack-tone.json', { tone: 'Brief.' });
  await write(stateDir, 'slack-automation.json', { rules: [RULE], workflows: [backupWorkflow('w')], extra: 1 });
  await write(stateDir, 'github-automation.json', { rules: [{ ...RULE, id: 'g' }], workflows: [backupWorkflow('gw', 'completed')] });
  await write(stateDir, 'public-agents.json', { version: 1, agents: [] });
}

test('collectWorkerFiles keeps only each file\'s settings, in file order', async t => {
  const stateDir = await dir(t);
  await workerFiles(stateDir);
  assert.equal(JSON.stringify(await collectWorkerFiles(stateDir)),
    `{"trigger-secrets.json":[${JSON.stringify(secret('local'))}],"permissions.json":{"rules":[${JSON.stringify(permissionRule('r1'))}],"autoReview":{"enabled":true,"provider":"claude","model":"opus","resume":true}},"models.json":${JSON.stringify(initialModelSettings())},`
    + '"slack-connection.json":{"enabled":true,"userToken":"xoxp-1","appToken":"xapp-1","account":{"teamId":"T","userId":"U"}},"slack-tone.json":{"tone":"Brief."},"slack-automation.json":{"rules":[' + JSON.stringify(RULE) + ']},'
    + '"github-automation.json":{"rules":[' + JSON.stringify({ ...RULE, id: 'g' }) + ']},"public-agents.json":{"version":1,"agents":[]}}');
});

test('with a Vault, collectWorkerFiles leaves out trigger-secrets.json even when a stale plaintext file exists, and the payload carries the Vault file bytes as is', async t => {
  const stateDir = await dir(t);
  await workerFiles(stateDir);
  const secrets = await vault(stateDir);
  await secrets.create({ name: 'deploy', kind: 'scalar', scope: 'global', value: 'PERMANENT_CANARY' });
  const files = await collectWorkerFiles(stateDir);
  assert.equal(files['trigger-secrets.json'], undefined);
  assert.deepEqual(Object.keys(files), ['permissions.json', 'models.json', 'slack-connection.json', 'slack-tone.json', 'slack-automation.json', 'github-automation.json', 'public-agents.json']);
  const vaultBytes = await readFile(join(stateDir, 'secrets', 'vault.json'));
  assert.equal(await collectEncryptedVault(stateDir), vaultBytes.toString('base64'));
  const service = await backupService(t, stateDir);
  const { payload } = await decryptBackup((await service.export(PASS)).text, PASS) as { payload: { worker: { encryptedVault: string } } };
  assert.equal(payload.worker.encryptedVault, vaultBytes.toString('base64'));
  const text = JSON.stringify(payload);
  for (const canary of ['PERMANENT_CANARY', 'Bearer local']) assert.equal(text.includes(canary), false, canary);
  assert.equal(text.includes((await readFile(join(stateDir, 'secrets', 'journal.json'))).toString('base64')), false, 'no journal');
});

test('collectWorkerFiles leaves out missing and non-object files but keeps a trigger-secrets array; an unreadable file fails', async t => {
  const stateDir = await dir(t);
  await write(stateDir, 'trigger-secrets.json', []);
  await write(stateDir, 'permissions.json', [1]);
  await write(stateDir, 'slack-tone.json', '"text"');
  assert.equal(JSON.stringify(await collectWorkerFiles(stateDir)), '{"trigger-secrets.json":[],"permissions.json":{"rules":[]},"slack-automation.json":{"rules":[]},"github-automation.json":{"rules":[]}}');
  await mkdir(join(stateDir, 'models.json'));
  await assert.rejects(collectWorkerFiles(stateDir), /invalid or too large/);
});

test('collectTriggers keeps once consumption, triggers, settings, trusted folders, grants, fired and GitHub cursors only, in that key order', async t => {
  const stateDir = await dir(t);
  const project = join(stateDir, 'project'); await mkdir(project);
  const e = await engine(t, stateDir);
  const { service } = await e.open();
  await service.create(once(project, '2026-12-01T09:00:00Z', 'Pending'), OWNER);
  const used = await service.create(once(project, '2026-09-24T01:00:00Z', 'Used'), OWNER);
  await service.run(used.id, OWNER); await service.tick(); e.finish(); await service.tick();
  const old = await service.create(hourly(project, { name: 'Old', enabled: false }), OWNER);
  await service.setArchived(old.id, true, old.revision, OWNER);
  await service.settle();
  const saved = JSON.parse(await read(stateDir, 'trigger-engine.json'));
  const part = await collectTriggers(stateDir);
  assert.deepEqual(Object.keys(part!), ['onceConsumed', 'triggers', 'settings', 'trustedFolders', 'secretGrants', 'fired', 'github']);
  assert.equal(JSON.stringify(part), JSON.stringify({ onceConsumed: saved.onceConsumed, triggers: saved.triggers, settings: saved.settings, trustedFolders: saved.trustedFolders, secretGrants: saved.secretGrants, fired: saved.fired, github: {} }));
  assert.equal(Object.keys(saved.onceConsumed).length, 1);
  assert.deepEqual(part!.triggers.map(item => [(item as { name: string }).name, Boolean((item as { onceSchedule?: unknown }).onceSchedule), Boolean((item as { archivedAt?: string }).archivedAt)]),
    [['Pending', true, false], ['Used', true, true], ['Old', false, true]], 'raw as saved: encoded once reservations, archived ones included');
  for (const key of ['events', 'audit', 'tombstones', 'revisions', 'cursors']) assert.equal(key in part!, false, key);

  const bare = await dir(t);
  await write(bare, 'trigger-engine.json', { version: 1, triggers: [], settings: { a: 1 }, trustedFolders: ['/a', 2], secretGrants: { s: ['t'] }, fired: { 'x y': 'z' }, cursors: { t: { github: { handled: [] } }, u: { anchorAt: 1 } } });
  assert.equal(JSON.stringify(await collectLegacyTriggers(bare)), '{"onceConsumed":{},"triggers":[],"settings":{"a":1},"trustedFolders":["/a"],"secretGrants":{"s":["t"]},"fired":{"x y":"z"},"github":{"t":{"handled":[]}}}');
  await write(bare, 'trigger-engine.json', []);
  assert.equal(await collectLegacyTriggers(bare), undefined);
});

test('trigger restore through a backup: once and archive, through the worker files, the web apply and the trigger owner', async t => {
  const from = await dir(t), to = await dir(t);
  const project = join(from, 'project'); await mkdir(project);
  const source = await engine(t, from);
  const { service: a } = await source.open();
  const pending = await a.create(once(project, '2026-12-01T09:00:00Z', 'Pending'), OWNER);
  const used = await a.create(once(project, '2026-09-24T01:00:00Z', 'Used'), OWNER);
  await a.run(used.id, OWNER); await a.tick(); source.finish(); await a.tick();
  await a.settle();
  const file = await (await backupService(t, from)).export(PASS);

  // The target consumed the pending reservation itself and archived nothing yet.
  await (await workerSettingsFixture(to)).seedTriggers(JSON.parse(await read(from, 'trigger-engine.json')));
  const local = await engine(t, to, { now: Date.parse('2026-12-01T09:00:05.000Z') });
  let { service: b } = await local.open();
  await b.run(pending.id, OWNER); await b.tick(); local.finish(); await b.tick();
  await b.settle(); b.close();
  const localConsumed = JSON.parse(await read(to, 'trigger-engine.json')).onceConsumed[pending.id];
  assert.ok(localConsumed);

  const web = await backupService(t, to);
  const report = await web.apply((await web.check(file.text, PASS)).id);
  assert.equal(report.status, 'waiting-worker');
  const taken = await takeWorkerRestore(to);
  ({ service: b } = await local.open(taken!.restore.triggers));
  const saved = JSON.parse(await read(to, 'trigger-engine.json'));
  assert.deepEqual(saved.onceConsumed[pending.id], localConsumed, 'the local consumption wins');
  assert.ok(saved.onceConsumed[used.id], 'the backup\'s consumption comes along');
  const restored = b.list({ includeArchived: true });
  assert.equal(restored.find(item => item.id === used.id)?.enabled, false);
  assert.ok(restored.find(item => item.id === used.id)?.archivedAt);
  await assert.rejects(b.run(used.id, OWNER), /consumed/i);

  // An older backup (no consumption ledger) through the deferred owner path: local consumption and a local archive stay.
  const hourlyLocal = await b.create(hourly(project, { name: 'Local hourly' }), OWNER);
  const archived = await b.setArchived(hourlyLocal.id, true, hourlyLocal.revision, OWNER);
  const older = (await collectTriggers(to))!;
  delete older.onceConsumed;
  older.triggers = older.triggers.map(item => (item as { id: string }).id === archived.id ? { ...(item as object), archivedAt: undefined } : item);
  await b.restoreBackup(older);
  const after = JSON.parse(await read(to, 'trigger-engine.json'));
  assert.deepEqual(Object.keys(after.onceConsumed).sort(), [pending.id, used.id].sort(), 'a backup without the ledger keeps the local one');
  assert.ok(b.list({ includeArchived: true }).find(item => item.id === archived.id)?.archivedAt, 'the local archive choice survives');
});

test('permissions restore keeps this computer\'s requests (pending ones and their notifications stay), codex files and lost note', async t => {
  const stateDir = await dir(t);
  await write(stateDir, 'permissions.json', { version: 1, rules: [permissionRule('old')], requests: [{ ...permissionRequest('pending'), notification: { state: 'pending', message: 'n' } }], codex: [{ path: '/c', scope: 'global' }], lost: 'note', extra: 'dropped' });
  const staleBefore = await readFile(join(stateDir, 'permissions.json'), 'utf8');
  const result = await applyWorkerFiles(stateDir, { 'permissions.json': { rules: [permissionRule('new')], autoReview: { enabled: false, resume: false } } });
  assert.deepEqual(result, { parts: ['permissions'], errors: [] });
  assert.deepEqual(JSON.parse(await read(stateDir, 'permissions.json')), { version: 1, rules: [permissionRule('new')], requests: [{ ...permissionRequest('pending'), notification: { state: 'pending', message: 'n' } }], codex: [{ path: '/c', scope: 'global' }], lost: 'note', extra: 'dropped', autoReview: { enabled: false, resume: false } });
  assert.equal(await readFile(join(stateDir, 'permissions.json'), 'utf8'), staleBefore, 'SQL restore never rewrites legacy authority');
  const fresh = await dir(t);
  await applyWorkerFiles(fresh, { 'permissions.json': { rules: [] } });
  assert.equal(await read(fresh, 'permissions.json'), '{"version":1,"rules":[],"requests":[],"codex":[]}');
  assert.deepEqual(await applyWorkerFiles(fresh, { 'permissions.json': { rules: 'x' } }), { parts: [], errors: ['permissions.json: Invalid permissions backup.'] });
});

test('trigger secrets: the backup wins per id, local-only secrets stay; one bad entry refuses the file', async t => {
  const stateDir = await dir(t);
  await write(stateDir, 'trigger-secrets.json', [secret('both', 'local value'), secret('local')]);
  assert.deepEqual(await applyWorkerFiles(stateDir, { 'trigger-secrets.json': [secret('both', 'backup value'), secret('backup')] }), { parts: ['triggerSecrets'], errors: [] });
  assert.equal(await read(stateDir, 'trigger-secrets.json'), JSON.stringify([secret('both', 'backup value'), secret('backup'), secret('local')]));
  const before = await read(stateDir, 'trigger-secrets.json');
  assert.deepEqual(await applyWorkerFiles(stateDir, { 'trigger-secrets.json': [secret('ok'), { ...secret('bad'), value: 1 }] }), { parts: [], errors: ['trigger-secrets.json: 백업의 내용이 올바르지 않아 건너뛰었습니다.'] });
  assert.equal(await read(stateDir, 'trigger-secrets.json'), before);
});

test('with an initialized Vault, plaintext trigger secrets are refused with their message and the rest apply', async t => {
  const stateDir = await dir(t);
  await vault(stateDir);
  const result = await applyWorkerFiles(stateDir, { 'trigger-secrets.json': [secret('a')], 'slack-tone.json': { tone: 'x' } });
  assert.deepEqual(result, { parts: ['slack'], errors: ['trigger-secrets.json: Vault가 초기화되어 평문 시크릿 복원은 거부했습니다. 암호화 가져오기를 사용하세요.'] });
  await assert.rejects(readFile(join(stateDir, 'trigger-secrets.json')), { code: 'ENOENT' });
});

test('Slack and GitHub automation take rules, preserve local workflows and wrapper metadata, ignore incoming extras and refuse invalid rules', async t => {
  const stateDir = await dir(t);
  await write(stateDir, 'slack-automation.json', { rules: [], workflows: [backupWorkflow('local', 'completed')], extra: 1 });
  const result = await applyWorkerFiles(stateDir, { 'slack-automation.json': { rules: [RULE], workflows: [{ id: 'backup' }], extra: 2 }, 'github-automation.json': { rules: [{ ...RULE, provider: 'gemini' }] } });
  assert.deepEqual(result, { parts: ['slack'], errors: ['github-automation.json: Slack 처리 지침이 올바르지 않습니다.'] });
  assert.deepEqual(JSON.parse(await read(stateDir, 'slack-automation.json')), { rules: [RULE], workflows: [backupWorkflow('local', 'completed')], extra: 1 });
  await applyWorkerFiles(stateDir, { 'github-automation.json': { rules: [RULE] } });
  assert.equal(await read(stateDir, 'github-automation.json'), `{"rules":[${JSON.stringify(RULE)}],"workflows":[]}`);
});

test('Slack account swap matrix', async t => {
  const connection = (teamId: string, userId = 'U') => ({ enabled: true, account: { teamId, userId } });
  const cases: Array<[string, unknown, string | undefined, boolean, ReturnType<typeof connection>?]> = [
    ['same account, work running', connection('T'), 'running', true],
    ['another account, only completed work', connection('T'), 'completed', true],
    ['another account, reply-uncertain work', connection('T'), 'reply-uncertain', false],
    ['another account, work running', connection('T'), 'running', false],
    ['no current connection counts as another account', undefined, 'running', false],
    ['same team, different user with running work', connection('T'), 'running', false, connection('T', 'OTHER')],
    ['same team, different user with uncertain reply', connection('T'), 'reply-uncertain', false, connection('T', 'OTHER')],
    ['foreign SQL unfinished team blocks even matching credentials', connection('OTHER'), 'running', false, connection('OTHER')],
  ];
  for (const [name, current, status, applied, selected] of cases) {
    const stateDir = await dir(t);
    if (current) await write(stateDir, 'slack-connection.json', current);
    await write(stateDir, 'slack-automation.json', { rules: [], workflows: status ? [backupWorkflow('w', status as Parameters<typeof backupWorkflow>[1])] : [] });
    const incoming = selected ?? (name.startsWith('same account') ? connection('T') : connection('OTHER'));
    const result = await applyWorkerFiles(stateDir, { 'slack-connection.json': incoming, 'slack-tone.json': { tone: 'new' }, 'slack-automation.json': { rules: [RULE] } });
    assert.equal(result.errors.some(error => error.startsWith('slack-connection.json:') && /Unfinished.*Slack/.test(error)), !applied, name);
    assert.equal(JSON.parse(await read(stateDir, 'slack-automation.json')).rules.length, 1, `${name}: automation rules still apply`);
    const tone = await read(stateDir, 'slack-tone.json').catch(() => undefined);
    assert.equal(tone === '{"tone":"new"}', applied, `${name}: tone follows the connection`);
  }
});

test('models restore drops unknown roles; slack-tone is written as is; every written file is 0600', async t => {
  const stateDir = await dir(t);
  const settings = initialModelSettings();
  await applyWorkerFiles(stateDir, { 'models.json': { ...settings, roles: { ...settings.roles, 'future.role': { provider: 'claude', claude: {}, codex: {} } } }, 'slack-tone.json': { tone: 'Brief.', extra: [1] },
    'slack-connection.json': { enabled: false }, 'public-agents.json': { version: 1, agents: [] }, 'permissions.json': { rules: [] }, 'trigger-secrets.json': [], 'slack-automation.json': { rules: [] }, 'github-automation.json': { rules: [] } });
  assert.equal(await read(stateDir, 'models.json'), JSON.stringify(settings));
  assert.equal(await read(stateDir, 'slack-tone.json'), '{"tone":"Brief.","extra":[1]}');
  for (const name of await readdir(stateDir)) assert.equal(await mode(join(stateDir, name)), (await stat(join(stateDir, name))).isDirectory() ? 0o700 : 0o600, name);
  const id = await stageLegacyImport(stateDir, [], PASS, undefined);
  assert.equal(await mode(join(stateDir, 'secrets')), 0o700);
  assert.equal(await mode(join(stateDir, 'secrets', `pending-import-${id}.json`)), 0o600);
});

test('an unreadable legacy permission file does not override SQL authority; file-owned settings still apply', async t => {
  const stateDir = await dir(t);
  await write(stateDir, 'permissions.json', '{ not json');
  const result = await applyWorkerFiles(stateDir, { 'permissions.json': { rules: [] }, 'slack-tone.json': { tone: 'x' } });
  assert.deepEqual(result, { parts: ['permissions', 'slack'], errors: [] });
  assert.deepEqual(await (await workerSettingsFixture(stateDir)).read('permissions.json'), { version: 1, rules: [], requests: [], codex: [] });
  assert.equal(await readFile(join(stateDir, 'permissions.json'), 'utf8'), '{ not json');
});

test('restoring the same worker part twice gives the same files; a pending-worker file that still holds encryptedVault is staged once and dropped, also when taken twice', async t => {
  const stateDir = await dir(t);
  await workerFiles(stateDir);
  const incoming = await collectWorkerFiles(stateDir);
  const target = await dir(t);
  await applyWorkerFiles(target, incoming);
  const names = Object.keys(incoming);
  const first = Object.fromEntries(await Promise.all(names.map(async name => [name, await read(target, name)])));
  await applyWorkerFiles(target, incoming);
  assert.deepEqual(Object.fromEntries(await Promise.all(names.map(async name => [name, await read(target, name)]))), first);

  const source = await dir(t);
  await vault(source);
  const encryptedVault = (await collectEncryptedVault(source))!;
  const id = '11111111-2222-4333-8444-555555555555';
  await writePendingWorker(stateDir, { id, files: {}, encryptedVault });
  const taken = await takeWorkerRestore(stateDir);
  assert.equal(taken!.restore.encryptedVault, undefined, 'dropped from the part handed to the services');
  // The worker stops before finishing; the next one takes the same part.
  const restoreDir = join(stateDir, 'restore');
  await writeFile(join(restoreDir, 'pending-worker.json'), JSON.stringify({ id, files: {}, encryptedVault }));
  const second = await takeWorkerRestore(stateDir);
  assert.equal(second!.restore.encryptedVault, undefined);
  const staged = await listPendingSecretImports(stateDir);
  assert.equal(staged.length, 1, 'staged once');
  assert.equal(JSON.parse(await read(stateDir, `secrets/pending-import-${staged[0]}.json`)).content, encryptedVault);
  assert.equal(await readPendingWorker(stateDir), undefined);
  assert.equal(JSON.parse(await read(stateDir, 'restore/applying-worker.json')).encryptedVault, encryptedVault, 'the taken file keeps it until the worker records its outcome');
});

test('pending import files keep their shape', async t => {
  const stateDir = await dir(t);
  const source = await dir(t);
  await vault(source);
  const encryptedVault = (await collectEncryptedVault(source))!;
  const restoreId = '11111111-2222-4333-8444-555555555555';
  const vaultId = await stageVaultImport(stateDir, encryptedVault, restoreId);
  assert.equal(await read(stateDir, `secrets/pending-import-${vaultId}.json`), JSON.stringify({ version: 1, kind: 'vault', content: encryptedVault, restoreId }));
  const legacyId = await stageLegacyImport(stateDir, [secret('a')], PASS, restoreId, { triggers: [], settings: {}, trustedFolders: [], secretGrants: {}, fired: {}, github: {} });
  const legacy = JSON.parse(await read(stateDir, `secrets/pending-import-${legacyId}.json`));
  assert.deepEqual(Object.keys(legacy), ['version', 'kind', 'content', 'restoreId']);
  assert.deepEqual([legacy.version, legacy.kind, legacy.restoreId], [1, 'legacy', restoreId]);
  assert.deepEqual((await decryptBackup(legacy.content, PASS)).payload, { version: 1, records: [secret('a')], triggers: { triggers: [], settings: {}, trustedFolders: [], secretGrants: {}, fired: {}, github: {} } });
  assert.equal((await decryptBackup(legacy.content, PASS)).header.towerVersion, 'secret-legacy-import');
  assert.equal(await stageVaultImport(stateDir, encryptedVault, restoreId), vaultId, 'the same restore stages once');
  assert.deepEqual(await listPendingSecretImports(stateDir), [vaultId, legacyId].sort());
  await assert.rejects(stageVaultImport(stateDir, Buffer.from('{"format":2}').toString('base64')), /Invalid encrypted vault/);
  await assert.rejects(stageLegacyImport(stateDir, [{ id: 1 }], PASS), /Invalid legacy import/);
  const target = await vault(await dir(t));
  await assert.rejects(importPendingSecret(stateDir, 'not-an-id', VAULT_PASSWORD, target), /Invalid secret import ID/);
  const notDirectory = await dir(t);
  await writeFile(join(notDirectory, 'secrets'), '');
  await assert.rejects(listPendingSecretImports(notDirectory), /Invalid secret import directory/);
});

test('restore matrix: plaintext and Vault backups onto computers with and without a Vault', async t => {
  const plaintext = async () => {
    const source = await dir(t);
    await write(source, 'trigger-secrets.json', [secret('legacy', 'LEGACY_CANARY')]);
    await (await workerSettingsFixture(source)).seedTriggers({ ...empty(), secretGrants: { legacy: [] } });
    return (await backupService(t, source)).export(PASS);
  };
  const vaulted = async () => {
    const source = await dir(t);
    const secrets = await vault(source);
    await new SecretStore(source, { vault: secrets }).create({ name: 'Legacy', origin: 'https://status.example.com', value: 'LEGACY_CANARY' }, Date.now());
    await (await workerSettingsFixture(source)).seedTriggers(empty());
    return (await backupService(t, source)).export(PASS);
  };
  const apply = async (file: { text: string }, targetVault: boolean) => {
    const target = await dir(t);
    const secrets = targetVault ? await vault(target) : undefined;
    const web = await backupService(t, target);
    const report = await web.apply((await web.check(file.text, PASS)).id);
    const pendingWorker = await readPendingWorker(target);
    const kinds = await Promise.all((report.pendingSecretImports ?? []).map(async id => JSON.parse(await read(target, `secrets/pending-import-${id}.json`)).kind));
    const plaintextFiles = (await readdir(target)).filter(name => name === 'trigger-secrets.json');
    return { target, secrets, report, pendingWorker, kinds, plaintextFiles };
  };

  const noVault = await apply(await plaintext(), false);
  assert.equal(noVault.report.status, 'waiting-worker');
  assert.deepEqual(noVault.kinds, []);
  assert.deepEqual(Object.keys(noVault.pendingWorker!.files), ['trigger-secrets.json', 'permissions.json', 'slack-automation.json', 'github-automation.json']);
  assert.ok(noVault.pendingWorker!.triggers);

  // The skills still go to the worker; trigger secrets and triggers wait for the encrypted import.
  const intoVault = await apply(await plaintext(), true);
  assert.equal(intoVault.report.status, 'waiting-worker');
  assert.deepEqual(intoVault.kinds, ['legacy']);
  assert.deepEqual(Object.keys(intoVault.pendingWorker!.files), ['permissions.json', 'slack-automation.json', 'github-automation.json']);
  assert.equal(intoVault.pendingWorker!.triggers, undefined);
  assert.deepEqual(intoVault.plaintextFiles, []);

  const vaultIntoVault = await apply(await vaulted(), true);
  assert.equal(vaultIntoVault.report.status, 'waiting-worker');
  assert.deepEqual(vaultIntoVault.kinds, ['vault', 'legacy']);
  assert.equal(vaultIntoVault.pendingWorker!.triggers, undefined);
  assert.equal(vaultIntoVault.pendingWorker!.encryptedVault, undefined);
  const device = vaultIntoVault.secrets!.device().id;
  const vaultImport = vaultIntoVault.report.pendingSecretImports!.find((_id, index) => vaultIntoVault.kinds[index] === 'vault')!;
  await importPendingSecret(vaultIntoVault.target, vaultImport, VAULT_PASSWORD, vaultIntoVault.secrets!);
  assert.equal(vaultIntoVault.secrets!.device().id, device, 'the target keeps its device identity');

  const vaultIntoNone = await apply(await vaulted(), false);
  assert.equal(vaultIntoNone.report.status, 'waiting-worker');
  assert.deepEqual(vaultIntoNone.kinds, ['vault', 'legacy']);
  assert.equal(vaultIntoNone.pendingWorker!.triggers, undefined);
  const none = new SecretService({ stateDir: vaultIntoNone.target }); await none.start();
  for (const id of vaultIntoNone.report.pendingSecretImports!) await assert.rejects(importPendingSecret(vaultIntoNone.target, id, VAULT_PASSWORD, none), /Unlock the target Vault/);
  assert.deepEqual((await listPendingSecretImports(vaultIntoNone.target)).sort(), [...vaultIntoNone.report.pendingSecretImports!].sort(), 'nothing changed meanwhile');
  for (const result of [noVault, intoVault, vaultIntoVault, vaultIntoNone]) assert.equal(JSON.stringify(result.pendingWorker ?? {}).includes('LEGACY_CANARY'), result === noVault, 'plaintext only on the path that never had a Vault');
});

const FROZEN_PARTS: Record<string, string[]> = {
  'backup-1.92.0': ['triggers', 'triggerSecrets', 'permissions', 'slack', 'github', 'publicAgents', 'skills', 'decisions', 'projectGroups', 'remoteExclusions', 'backup'],
  'backup-1.95.0': ['triggers', 'triggerSecrets', 'permissions', 'models', 'slack', 'github', 'publicAgents', 'skills', 'decisions', 'projectGroups', 'remoteExclusions', 'backup'],
  'backup-1.105.0-vault': ['triggers', 'secretVault', 'permissions', 'models', 'slack', 'github', 'publicAgents', 'skills', 'decisions', 'projectGroups', 'remoteExclusions', 'backup'],
  'backup-1.106.0-once': ['triggers', 'permissions', 'models', 'slack', 'github', 'publicAgents', 'skills', 'decisions', 'projectGroups', 'remoteExclusions', 'backup'],
};

test('historic backups still check and restore valid parts while malformed permission grants are reported', async t => {
  for (const [name, parts] of Object.entries(FROZEN_PARTS)) {
    const text = await readFile(join(FIXTURES, `${name}.towerbackup`), 'utf8');
    const released = JSON.parse(await readFile(join(FIXTURES, `${name}.payload.json`), 'utf8'));
    assert.deepEqual((await decryptBackup(text, PASS)).payload, released, `${name}: decrypts to what its release wrote`);
    assert.deepEqual(payloadParts(parsePayload(released)), parts, name);
    const target = await dir(t);
    const web = await backupService(t, target);
    const checked = await web.check(text, PASS);
    assert.deepEqual(checked.parts, parts, name);
    const report = await web.apply(checked.id);
    const files = released.worker.files as Record<string, unknown>;
    if (name.includes('vault')) {
      assert.equal(report.status, 'waiting-worker', name);
      assert.equal(report.pendingSecretImports?.length, 2, `${name}: the Vault and the trigger part wait for encrypted imports`);
      const pendingWorker = await readPendingWorker(target);
      assert.equal(pendingWorker!.triggers, undefined);
      assert.equal(pendingWorker!.encryptedVault, undefined);
    } else assert.equal(report.status, 'waiting-worker', name);
    const taken = await takeWorkerRestore(target);
    for (const file of Object.keys(files)) {
      if (file === 'trigger-secrets.json' && name.includes('vault')) continue;
      if (sqlFile(file)) {
        if (file === 'permissions.json') assert.deepEqual((await (await workerSettingsFixture(target)).read(file) as { rules: unknown[] }).rules, [], `${name}: malformed historic permission grant is refused`);
        else assert.deepEqual((await (await workerSettingsFixture(target)).read(file) as { rules: unknown[] }).rules, (files[file] as { rules: unknown[] }).rules, `${name}: ${file} restored through SQL`);
      } else assert.ok((await readdir(target)).includes(file), `${name}: ${file} restored`);
    }
    assert.deepEqual(JSON.parse(await read(target, 'permissions.json')), { version: 1, rules: [], requests: [], codex: [] }, `${name}: invalid grants do not change SQL authority`);
    await taken!.applied({ parts: [], errors: [] });
    await taken!.finish({ parts: [], errors: [] });
    assert.match((await readReport(target))!.errors.join(' '), /permissions.json:.*Malformed permission enum/, `${name}: partial refusal is visible`);
    if (!name.includes('vault')) {
      const e = await engine(t, target);
      const { service } = await e.open(taken!.restore.triggers);
      const restored = service.list({ includeArchived: true }).map(item => ({ name: item.name, archived: Boolean(item.archivedAt), schedule: item.source.kind === 'schedule' ? item.source.schedule.type : item.source.kind }));
      const expected = name.includes('once')
        ? [{ name: 'Hourly report', archived: false, schedule: 'cron' }, { name: 'Pending reservation', archived: false, schedule: 'once' }, { name: 'Used reservation', archived: true, schedule: 'once' }, { name: 'Old weekly digest', archived: true, schedule: 'cron' }]
        : [{ name: 'Hourly report', archived: false, schedule: 'cron' }, { name: 'Status', archived: false, schedule: 'http' }];
      assert.deepEqual(restored, expected, name);
    }
  }
});

test('the SQL settings payload keeps the exact 1.106.0 public format and every other part', async () => {
  for (const [state, expected] of [['backup-1.95.0', 'plain'], ['backup-1.106.0-once', 'once'], ['backup-1.105.0-vault', 'vault']]) {
    const files = JSON.parse(await readFile(join(FIXTURES, `${state}.state.json`), 'utf8'));
    const reference = JSON.parse(await readFile(join(FIXTURES, `payload-1.106.0-${expected}.json`), 'utf8'));
    assert.equal(reference.worker.files['permissions.json'].rules[0].kind, undefined, 'frozen fixture permission is not a valid current grant');
    const settings = { ...reference.worker.files['permissions.json'], rules: [permissionRule('r1')] };
    const sqlSettings = { 'permissions.json': settings, 'slack-automation.json': reference.worker.files['slack-automation.json'], 'github-automation.json': reference.worker.files['github-automation.json'] };
    reference.worker.files['permissions.json'] = settings;
    assert.equal(await payloadOf(join(import.meta.dirname, '../../..'), files, sqlSettings), JSON.stringify(reference), expected);
  }
});

test('fixture states hold no unexpected plaintext secret', async () => {
  for (const name of ['payload-1.106.0-vault.json', 'backup-1.105.0-vault.payload.json']) {
    assert.equal((await readFile(join(FIXTURES, name), 'utf8')).includes('FIXTURE_'), false, name);
  }
  const state = JSON.parse(await readFile(join(FIXTURES, 'backup-1.105.0-vault.state.json'), 'utf8')) as Record<string, string>;
  assert.equal('trigger-secrets.json' in state, false, 'the Vault release keeps trigger secrets encrypted');
});

test('public backup and restore reject the closed SQL owner without reading or overwriting stale permission settings', async t => {
  const stateDir = await dir(t), settings = await workerSettingsFixture(stateDir);
  const local = { ...permissionRequest('held-local'), notification: { state: 'pending' as const, message: 'local notice' } };
  await settings.seed('permissions.json', { version: 1, rules: [permissionRule('owner-rule')], requests: [local], codex: [{ path: '/local/rules', scope: 'global' }], lost: 'local loss' });
  const before = await settings.read('permissions.json');
  const stale = '{"rules":[],"requests":[]}';
  await writeFile(join(stateDir, 'permissions.json'), stale, { mode: 0o600 });
  const service = await backupService(t, stateDir);
  await settings.storage.close();
  await assert.rejects(service.export(PASS));
  const restore = await applyWorkerFiles(stateDir, { 'permissions.json': { rules: [permissionRule('foreign-rule')] } });
  assert.deepEqual(restore.parts, []); assert.equal(restore.errors.length, 1); assert.match(restore.errors[0], /^permissions.json:/);
  assert.equal(await readFile(join(stateDir, 'permissions.json'), 'utf8'), stale);
  await settings.storage.reopen(); await settings.storage.prepare({ allowMigration: false });
  assert.deepEqual(await settings.read('permissions.json'), before, 'failed restore preserves local requests, notices, files, loss and rules');
});
