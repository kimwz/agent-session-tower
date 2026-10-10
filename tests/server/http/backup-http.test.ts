import { workerSettingsFixture, backupPermissionRule, backupPermissionRequest } from '../remote/external-storage-fixture.js';
import { BackupService } from '../../../server/backup/service.js';
import { parsePayload } from '../../../server/backup/payload.js';
import { decryptBackup } from '../../../server/backup/crypto.js';
import { ProjectGroupStore } from '../../../server/stores/project-groups.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { DecisionService } from '../../../server/decisions/service.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { createMonitorServer, type HttpOptions } from '../../../server/http/server.js';
import { BackupError } from '../../../server/backup/crypto.js';
import type { BackupOverview } from '../../../shared/backup.js';
import type { Snapshot } from '../../../shared/types.js';

const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' };
const overview = { settings: { enabled: false, remote: { endpoint: '', bucket: '', prefix: '', region: 'auto', accessKeyId: '', secretSet: false }, passphraseSet: false, intervalHours: 24, keep: 14 }, status: { running: false } } satisfies BackupOverview;

test('backups need a signed-in page and its token, come as a file, and are never made or applied by the master agent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-backup-http-'));
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const calls: unknown[] = [];
  const secret = 'm'.repeat(64);
  const backup: NonNullable<HttpOptions['backup']> = {
    overview: async () => overview, saveSettings: async body => { calls.push(['settings', body]); return overview; },
    export: async passphrase => { calls.push(['export', passphrase]); return { name: 'tower-backup-here-20260930T000000Z.towerbackup', text: '{"format":"x"}' }; },
    upload: async () => 'key', test: async () => {}, remote: async () => [], download: async () => ({ name: 'a b.towerbackup', text: 'x' }),
    check: async (file, passphrase) => { calls.push(['check', file, passphrase]); return { id: 'id', createdAt: '', from: 'a', towerVersion: '1', parts: [], skills: 0, otherComputer: false }; },
    apply: async () => { throw new BackupError('확인한 백업이 만료되었습니다. 파일을 다시 확인하세요.', 'conflict'); },
    cancel: async () => { throw new BackupError('기다리는 복원이 없습니다.', 'conflict'); },
  };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, backup,
    master: { callerSecret: secret, handle: async () => false },
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const post = (path: string, body: unknown, headers: Record<string, string> = { cookie, 'X-Agent-Monitor-Token': token }) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  assert.equal((await fetch(`${base}/api/backup`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/api/backup`, { headers: { cookie } })).json(), overview);
  assert.equal((await post('/api/backup/export', { passphrase: 'correct horse' }, { cookie })).status, 403, 'the page token is required');
  const file = await post('/api/backup/export', { passphrase: 'correct horse' });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-disposition'), 'attachment; filename="tower-backup-here-20260930T000000Z.towerbackup"');
  assert.equal(file.headers.get('cache-control'), 'no-store');
  assert.equal(await file.text(), '{"format":"x"}');
  assert.equal((await post('/api/backup/remote/download', { key: 'k' })).headers.get('content-disposition'), 'attachment; filename="a_b.towerbackup"');
  assert.equal((await post('/api/backup/restore/check', { file: 'x'.repeat(2_000_000), passphrase: 'correct horse' })).status, 200, 'a whole backup file fits');
  const expired = await post('/api/backup/restore/apply', { id: 'id' });
  assert.equal(expired.status, 409);
  assert.match((await expired.json()).error, /만료/);
  assert.equal((await post('/api/backup/export', { passphrase: 'correct horse' }, { cookie, 'X-Agent-Monitor-Token': token, 'x-tower-master': secret })).status, 403);
  assert.deepEqual(calls.map(call => (call as unknown[])[0]), ['export', 'check']);
});

test('authenticated backup HTTP export encrypts the actual SQL owner settings in the existing v1 payload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-backup-http-sql-'));
  const settings = await workerSettingsFixture(dir);
  const permission = backupPermissionRule('http-owner-rule');
  await settings.seed('permissions.json', { version: 1, rules: [permission], requests: [backupPermissionRequest('http-local-request')], codex: [] });
  await writeFile(join(dir, 'permissions.json'), '{"rules":[]}', { mode: 0o600 });
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const groups = new ProjectGroupStore(dir), exclusions = new RemoteExclusionStore(dir), decisions = new DecisionService(dir);
  await groups.start(); await exclusions.start(); await decisions.start();
  const backup = new BackupService({ stateDir: dir, version: '1.125.0', settings: settings.collect, triggers: settings.triggersBackup,
    skills: async () => ({ bundle: { format: 'agent-session-tower.skills', version: 1, exportedAt: '', from: 'fixture', skills: [] }, guidance: '', settings: { enabled: false, provider: 'codex' } }), restartWorker: async () => true, stores: { groups, exclusions, decisions } });
  await backup.start();
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, backup,
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    backup.close(); await backup.flush(); await settings.close(); await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const response = await fetch(`${base}/api/backup/export`, { method: 'POST', headers: { cookie, 'X-Agent-Monitor-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'SQL owner fixture passphrase' }) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition')!, /attachment; filename="tower-backup-/);
  const encrypted = await response.text(); assert.equal(encrypted.includes('http-owner-rule'), false);
  await assert.rejects(decryptBackup(encrypted, 'wrong fixture passphrase'));
  const payload = parsePayload((await decryptBackup(encrypted, 'SQL owner fixture passphrase')).payload);
  assert.equal(payload.version, 1); assert.deepEqual(payload.worker.files['permissions.json'], { rules: [permission] });
  assert.deepEqual(payload.worker.files['slack-automation.json'], { rules: [] });
  assert.deepEqual(payload.worker.files['github-automation.json'], { rules: [] });
  assert.equal(JSON.stringify(payload).includes('http-local-request'), false);
  assert.equal(await readFile(join(dir, 'permissions.json'), 'utf8'), '{"rules":[]}');
});
