import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BackupService } from '../../../server/backup/service.js';
import type { SkillBackup } from '../../../server/backup/payload.js';
import { readPendingWorker, readReport, takeWorkerRestore } from '../../../server/backup/restore-files.js';
import { ProjectGroupStore } from '../../../server/stores/project-groups.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { DecisionService } from '../../../server/decisions/service.js';
import { fakeBucket } from '../../helpers/s3.js';

const PASS = 'correct horse battery';
const skills: SkillBackup = { bundle: { format: 'agent-session-tower.skills', version: 1, exportedAt: '', from: 'a', skills: [] }, guidance: 'Be brief.', guidanceConfirmed: true, confirmed: [], settings: { enabled: true, provider: 'claude' } };

async function computer(t: TestContext, options: { now?: () => number; host?: string } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-backup-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const groups = new ProjectGroupStore(stateDir), exclusions = new RemoteExclusionStore(stateDir), decisions = new DecisionService(stateDir);
  await groups.start(); await exclusions.start(); await decisions.start();
  const handoffs: number[] = [], master: Record<string, unknown>[] = [];
  const service = new BackupService({ stateDir, version: '1.91.0', skills: async () => structuredClone(skills), restartWorker: async () => { handoffs.push(Date.now()); return true; },
    stores: { groups, exclusions, decisions }, master: async body => { master.push(body); }, ...(options.now ? { now: options.now } : {}), host: options.host ?? 'studio' });
  await service.start();
  return { stateDir, groups, exclusions, decisions, service, handoffs, master };
}
const write = (dir: string, name: string, value: unknown) => mkdir(join(dir, name, '..'), { recursive: true }).then(() => writeFile(join(dir, name), JSON.stringify(value), { mode: 0o600 }));

test('a backup made on one computer restores on another: web settings now, the worker part at its next start', async t => {
  const a = await computer(t);
  await write(a.stateDir, 'permissions.json', { version: 1, rules: [{ id: 'r1' }], requests: [{ id: 'a-request' }], codex: [], autoReview: { enabled: true } });
  await write(a.stateDir, 'slack-automation.json', { rules: [{ id: 'rule' }], workflows: [{ id: 'a-work' }] });
  await write(a.stateDir, 'slack-connection.json', { enabled: true, userToken: 'xoxp-1', appToken: 'xapp-1', account: { teamId: 'T', userId: 'U' } });
  await write(a.stateDir, 'trigger-engine.json', { version: 1, triggers: [], settings: {}, trustedFolders: ['/work'], secretGrants: {}, fired: {}, cursors: {}, events: [{ id: 'history' }] });
  await write(a.stateDir, 'master/settings.json', { voice: { voiceId: 'abcdefghij' }, session: { sessionId: 'x', provider: 'claude', startedAt: '' } });
  await write(a.stateDir, 'master/elevenlabs-key.json', { apiKey: 'eleven-key-1' });
  await a.groups.set({ cwd: '/work/shop', title: 'Shop', pinned: true });
  await a.exclusions.add('/work/private');
  await a.decisions.update({ apiKey: 'jev-key-1234' });
  const file = await a.service.export(PASS);
  assert.match(file.name, /^tower-backup-studio-[0-9a-f]{6}-\d{8}T\d{6}Z\.towerbackup$/);
  assert.doesNotMatch(file.text, /xoxp-1|jev-key|eleven-key/);

  const b = await computer(t);
  await write(b.stateDir, 'permissions.json', { version: 1, rules: [{ id: 'old' }], requests: [{ id: 'b-request' }], codex: [{ path: '/b/rules' }] });
  await b.groups.set({ cwd: '/elsewhere', title: 'Gone', pinned: false });
  await assert.rejects(b.service.check(file.text, 'wrong passphrase'), /암호가 맞지 않거나/);
  const preview = await b.service.check(file.text, PASS);
  assert.deepEqual(preview.parts, ['triggers', 'permissions', 'slack', 'skills', 'decisions', 'projectGroups', 'remoteExclusions', 'master', 'backup']);
  const report = await b.service.apply(preview.id);
  await assert.rejects(b.service.apply(preview.id), /만료/, 'a checked backup is applied once');
  assert.equal(report.status, 'waiting-worker');
  assert.deepEqual(report.applied, ['projectGroups', 'remoteExclusions', 'decisions', 'backup', 'master']);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(b.groups.list(), [{ cwd: '/work/shop', title: 'Shop', pinned: true }]);
  assert.deepEqual(b.exclusions.list(), ['/work/private']);
  assert.equal(b.decisions.overview().keyHint, '…1234');
  assert.deepEqual(b.master, [{ voice: { voiceId: 'abcdefghij' }, voiceKey: 'eleven-key-1' }], 'the master session binding stays this computer’s');
  assert.equal(b.handoffs.length, 1, 'the worker is asked to hand over');
  assert.deepEqual(JSON.parse(await readFile(join(report.before!, 'permissions.json'), 'utf8')).rules, [{ id: 'old' }], 'replaced files are kept aside');
  assert.equal(((await stat(join(b.stateDir, 'restore', 'pending-worker.json'))).mode & 0o777), 0o600);
  // A worker on the other side of the restore sees the backup's exclusions as newer than its own copy.
  const worker = new RemoteExclusionStore(b.stateDir);
  await worker.start();
  assert.deepEqual(worker.list(), ['/work/private']);

  // The next worker takes its part before its services start.
  const taken = await takeWorkerRestore(b.stateDir);
  assert.ok(taken);
  assert.deepEqual(taken.restore.skills?.guidance, 'Be brief.');
  const permissions = JSON.parse(await readFile(join(b.stateDir, 'permissions.json'), 'utf8'));
  assert.deepEqual(permissions, { version: 1, requests: [{ id: 'b-request' }], codex: [{ path: '/b/rules' }], rules: [{ id: 'r1' }], autoReview: { enabled: true } });
  assert.deepEqual(JSON.parse(await readFile(join(b.stateDir, 'slack-automation.json'), 'utf8')), { rules: [{ id: 'rule' }], workflows: [] }, 'work under way stays on its computer');
  assert.equal(JSON.parse(await readFile(join(b.stateDir, 'slack-connection.json'), 'utf8')).userToken, 'xoxp-1');
  await taken.finish({ parts: ['triggers', 'skills'], errors: [], skills: { restored: [], skipped: [] } });
  assert.equal(await readPendingWorker(b.stateDir), undefined);
  const done = await readReport(b.stateDir);
  assert.equal(done?.status, 'applied');
  assert.deepEqual(done?.worker.sort(), ['permissions', 'skills', 'slack', 'triggers']);
  assert.equal(await takeWorkerRestore(b.stateDir), undefined, 'a later worker has nothing to take');
});

test('a waiting restore can be cancelled, and a different Slack account never replaces one with work under way', async t => {
  const a = await computer(t);
  await write(a.stateDir, 'slack-connection.json', { enabled: true, userToken: 'xoxp-a', account: { teamId: 'T', userId: 'A' } });
  const text = (await a.service.export(PASS)).text;
  const b = await computer(t);
  await write(b.stateDir, 'slack-connection.json', { enabled: true, userToken: 'xoxp-b', account: { teamId: 'T', userId: 'B' } });
  await write(b.stateDir, 'slack-automation.json', { rules: [], workflows: [{ id: 'w', status: 'running' }] });
  const waiting = await b.service.apply((await b.service.check(text, PASS)).id);
  await assert.rejects(b.service.cancel('another'), /기다리는 복원이 없습니다/, 'only the restore the page shows is cancelled');
  assert.equal((await b.service.cancel(waiting.id)).status, 'cancelled');
  assert.equal(await readPendingWorker(b.stateDir), undefined);
  await assert.rejects(b.service.cancel(waiting.id), /기다리는 복원이 없습니다/);
  await b.service.apply((await b.service.check(text, PASS)).id);
  const taken = await takeWorkerRestore(b.stateDir);
  await taken!.finish({ parts: [], errors: [] });
  assert.equal(JSON.parse(await readFile(join(b.stateDir, 'slack-connection.json'), 'utf8')).userToken, 'xoxp-b');
  assert.match((await readReport(b.stateDir))!.errors.join(' '), /진행 중인 Slack 작업/);
  const before = (await readdir(join(b.stateDir, 'restore'))).filter(name => name.startsWith('before-'));
  assert.ok(before.length >= 1 && before.length <= 3);
});

test('automatic backups go to the bucket when due, keep only the newest of this computer, and never show secrets', async t => {
  const bucket = await fakeBucket(t);
  const clock = { now: Date.parse('2026-09-30T00:00:00Z') };
  const a = await computer(t, { now: () => clock.now });
  const settings = { enabled: true, intervalHours: 24, keep: 2, passphrase: PASS, remote: { endpoint: bucket.endpoint, bucket: 'bucket', prefix: 'tower/', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret-key' } };
  await assert.rejects(a.service.saveSettings({ ...settings, remote: { ...settings.remote, endpoint: 'http://example.com' } }), /https/);
  const overview = await a.service.saveSettings(settings);
  assert.equal(JSON.stringify(overview).includes('secret-key'), false);
  assert.equal(JSON.stringify(overview).includes(PASS), false);
  assert.equal(overview.settings.remote.secretSet, true);
  await a.service.test();
  // Another computer, one whose name starts the same, and one with the same name: none of theirs is removed.
  const others = ['tower/tower-backup-other-abcdef-20260101T000000Z.towerbackup', 'tower/tower-backup-studio-pro-abcdef-20260101T000000Z.towerbackup', 'tower/tower-backup-studio-000000-20260101T000000Z.towerbackup'];
  for (const key of others) bucket.objects.set(key, { body: Buffer.from('x'), at: '2026-01-01T00:00:00Z' });
  for (let day = 0; day < 3; day++) { await a.service.upload(); clock.now += 24 * 60 * 60 * 1000; }
  const own = [...bucket.objects.keys()].filter(key => !others.includes(key)).sort();
  assert.deepEqual(others.filter(key => bucket.objects.has(key)), others);
  assert.equal(own.length, 2, 'only the newest two of its own are kept');
  assert.match(own[0]!, /^tower\/tower-backup-studio-[0-9a-f]{6}-20261001T000000Z\.towerbackup$/);
  assert.match(own[1]!, /-20261002T000000Z\.towerbackup$/);
  const status = (await a.service.overview()).status;
  assert.equal(status.lastSuccessAt, '2026-10-02T00:00:00.000Z');
  assert.equal(status.lastKey, own[1]);
  // What was uploaded restores with the saved passphrase.
  const downloaded = await a.service.download(own[1]);
  assert.ok((await a.service.check(downloaded.text, PASS)).parts.includes('backup'));
  await assert.rejects(a.service.download('elsewhere/x.towerbackup'), /찾을 수 없습니다/);
  assert.equal((await a.service.remote()).length, 5);
  // A failure is recorded and does not clear the last success.
  await a.service.saveSettings({ ...settings, remote: { ...settings.remote, accessKeyId: 'WRONG', secretAccessKey: '' } });
  await assert.rejects(a.service.upload(), /403/);
  const failed = (await a.service.overview()).status;
  assert.match(failed.lastError!, /403/);
  assert.equal(failed.lastSuccessAt, '2026-10-02T00:00:00.000Z');
});

test('an automatic backup runs when due, and a failed one is tried again only after a while', async t => {
  const bucket = await fakeBucket(t);
  const clock = { now: Date.parse('2026-09-30T00:00:00Z') };
  const a = await computer(t, { now: () => clock.now });
  const settings = { enabled: false, intervalHours: 6, keep: 10, passphrase: PASS, remote: { endpoint: bucket.endpoint, bucket: 'bucket', prefix: '', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret-key' } };
  await a.service.saveSettings(settings);
  await a.service.runIfDue();
  assert.equal(bucket.objects.size, 0, 'nothing while it is off');
  await a.service.saveSettings({ ...settings, enabled: true });
  await a.service.runIfDue();
  assert.equal(bucket.objects.size, 1, 'the first one right away');
  clock.now += 5 * 60 * 60 * 1000;
  await a.service.runIfDue();
  assert.equal(bucket.objects.size, 1);
  clock.now += 60 * 60 * 1000;
  await a.service.saveSettings({ ...settings, enabled: true, remote: { ...settings.remote, accessKeyId: 'WRONG', secretAccessKey: '' } });
  await a.service.runIfDue();
  const attempts = () => bucket.seen.filter(line => line.startsWith('PUT')).length;
  assert.equal(attempts(), 2, 'due again after six hours; it fails');
  clock.now += 10 * 60 * 1000;
  await a.service.runIfDue();
  assert.equal(attempts(), 2, 'not every ten minutes after a failure');
  clock.now += 30 * 60 * 1000;
  await a.service.saveSettings({ ...settings, enabled: true });
  await a.service.runIfDue();
  assert.equal(bucket.objects.size, 2);
});

test('a restore of fast-judgment settings is never overwritten by a change that was already under way', async t => {
  const a = await computer(t);
  const change = a.decisions.update({ apiKey: 'first-key-0000' });
  const restore = a.decisions.restore({ provider: 'jev', apiKey: 'restored-key-9999', features: {} });
  await Promise.all([change, restore]);
  assert.equal(a.decisions.overview().keyHint, '…9999');
  const again = new DecisionService(a.stateDir);
  await again.start();
  assert.equal(again.overview().keyHint, '…9999');
  await assert.rejects(a.decisions.restore({ provider: 'nobody' }), /올바르지 않습니다/);
});

test('a restore applied while a worker is still applying an earlier one is kept for the next worker, never lost', async t => {
  const a = await computer(t);
  const text = (await a.service.export(PASS)).text;
  const b = await computer(t);
  const first = await b.service.apply((await b.service.check(text, PASS)).id);
  const taken = await takeWorkerRestore(b.stateDir);
  assert.equal(taken?.restore.id, first.id);
  await assert.rejects(b.service.cancel(first.id), /이미 복원을 적용하고/, 'a part being applied cannot be cancelled');
  // The owner restores again while that worker is still busy with the first one; a cancel of the first sent at the
  // same moment never touches the second.
  const secondCheck = await b.service.check(text, PASS);
  const [second, cancelled] = await Promise.all([b.service.apply(secondCheck.id), b.service.cancel(first.id).then(() => 'cancelled', () => 'refused')]);
  assert.equal(cancelled, 'refused');
  await taken!.finish({ parts: [], errors: [] });
  const report = await readReport(b.stateDir);
  assert.equal(report?.id, second.id);
  assert.equal(report?.status, 'waiting-worker', 'the first worker never marks the second restore done');
  assert.equal((await readPendingWorker(b.stateDir))?.id, second.id);
  const next = await takeWorkerRestore(b.stateDir);
  assert.equal(next?.restore.id, second.id);
  await next!.finish({ parts: [], errors: [] });
  assert.equal((await readReport(b.stateDir))?.status, 'applied');
});
