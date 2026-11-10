import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { before, type TestContext } from 'node:test';
import { captureStorageBundle, type StorageBundleCapture } from '../../../server/storage/bundle.js';
import { StorageCommandError } from '../../../server/storage/contract.js';
import { openWorkerStorage } from '../../../server/storage/initialize.js';
import { preflightStorage } from '../../../server/storage/preflight.js';
import { readSnapshot } from '../../../server/storage/recovery.js';
import { retireStrandedStages, settleRunsRetirements, unsettledRunsRetirements } from '../../../server/storage/stranded-stages.js';
import type { StorageClient } from '../../../server/storage/client.js';
import { RunsRepository } from '../../../server/runs/storage-repository.js';
import { currentStorage } from '../../helpers/current-storage.js';

let bundle: StorageBundleCapture;
before(async () => { bundle = await captureStorageBundle(); });

const DATABASE = 'state.sqlite';
const STAGE_TABLES = ['runs', 'triggers', 'retention', 'remote', 'auto_prompt', 'automation_workflows'];
const SHA = 'a'.repeat(64);

async function currentStore(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tower-stranded-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await (await currentStorage(dir)).close();
  return dir;
}
async function start(dir: string) {
  const result = await openWorkerStorage({ stateDir: dir, bundle, preflight: await preflightStorage({ bundle, stateDir: dir }) });
  const status = result.database?.status();
  await result.database?.close();
  return { ...result, status };
}
function sql(dir: string, text: string): void {
  const db = new DatabaseSync(join(dir, DATABASE));
  try { db.exec(text); } finally { db.close(); }
}
function rows(path: string, table: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all(); } finally { db.close(); }
}
/** Every table but the claim and receipt bookkeeping, which each start changes. */
function committed(dir: string): Record<string, unknown[]> {
  const db = new DatabaseSync(join(dir, DATABASE), { readOnly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(row => row.name)
      .filter(name => !['storage_meta', 'operation_receipts'].includes(name) && !name.endsWith('_stages') && !name.endsWith('_stage_chunks'));
    return Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()]));
  } finally { db.close(); }
}
const stageRow = (table: string, intent: string, epoch: number, chunks = 1) =>
  `INSERT INTO ${table}_stages (intent, owner_epoch, bytes, sha256, chunks) VALUES ('${intent}', ${epoch}, 1, '${SHA}', ${chunks}); INSERT INTO ${table}_stage_chunks (intent, part, data) VALUES ('${intent}', 0, 'AA==');`;
const stageCount = (dir: string) => Object.fromEntries(STAGE_TABLES.map(table => [table, rows(join(dir, DATABASE), `${table}_stages`).length + rows(join(dir, DATABASE), `${table}_stage_chunks`).length]));
const none = Object.fromEntries(STAGE_TABLES.map(table => [table, 0]));

test('a stage an earlier worker left is kept in a snapshot and evidence, then removed; committed rows stay the same and the start is ready', async t => {
  const dir = await currentStore(t);
  sql(dir, stageRow('runs', 'left-at-reboot', 1));
  const before = committed(dir);
  const result = await start(dir);
  assert.equal(result.refusal, undefined, JSON.stringify(result.refusal));
  assert.ok(result.domains?.every(domain => domain.result === 'present'));
  assert.deepEqual(stageCount(dir), none);
  assert.deepEqual(committed(dir), before, 'no committed row changed');
  const retired = result.retired!;
  assert.deepEqual(retired.stages.map(stage => [stage.scope, stage.intent, stage.ownerEpoch, stage.sha256, stage.chunks, stage.staged]), [['runs', 'left-at-reboot', 1, SHA, 1, 1]]);
  // The snapshot verifies against its manifest and still holds the stage and its chunk.
  await readSnapshot(dir, retired.snapshotId);
  const copy = join(dir, 'storage-snapshots', retired.snapshotId, 'snapshot.db');
  assert.equal((rows(copy, 'runs_stages') as { intent: string }[])[0].intent, 'left-at-reboot');
  assert.equal(rows(copy, 'runs_stage_chunks').length, 1);
  const evidence = JSON.parse(await readFile(retired.evidence, 'utf8')) as { format: string; snapshotId: string; ownerEpoch: number; stages: { intent: string }[] };
  assert.deepEqual([evidence.format, evidence.snapshotId, evidence.stages.map(stage => stage.intent)], ['tower-stranded-stages', retired.snapshotId, ['left-at-reboot']]);
  assert.equal(evidence.ownerEpoch, result.status?.ownerEpoch);

  const again = await start(dir);
  assert.equal(again.refusal, undefined);
  assert.equal(again.retired, undefined, 'nothing left to retire');
});

test('stages left in all six staged domains are retired in one start with one snapshot', async t => {
  const dir = await currentStore(t);
  sql(dir, STAGE_TABLES.map((table, index) => stageRow(table, `left-${table}`, index % 2)).join(''));
  const result = await start(dir);
  assert.equal(result.refusal, undefined, JSON.stringify(result.refusal));
  assert.deepEqual(result.retired!.stages.map(stage => stage.scope).sort(), ['auto-prompt', 'automation-workflows', 'remote', 'retention', 'runs', 'triggers']);
  assert.deepEqual(stageCount(dir), none);
});

test('reboot reproduction: a worker killed between begin and commit leaves a stage the next start retires', async t => {
  const dir = await currentStore(t);
  // A runs write the way the repository makes one, cut off after its chunk: the process dies holding the WAL.
  const storage = await currentStorage(dir, { initialize: false });
  await storage.write('runs', 'begin', { intent: 'cut-off', bytes: 1, sha256: SHA, chunks: 1 }, 'cut-off-begin');
  await storage.write('runs', 'stage', { intent: 'cut-off', part: 0, data: 'AA==' }, 'cut-off-0');
  await storage.close();
  await new Promise<void>(resolve => execFile(process.execPath, ['-e',
    `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(join(dir, DATABASE))}); db.exec(${JSON.stringify(stageRow('triggers', 'in-wal', 1))}); process.kill(process.pid, 'SIGKILL');`], () => resolve()));
  const before = committed(dir);
  const result = await start(dir);
  assert.equal(result.refusal, undefined, JSON.stringify(result.refusal));
  assert.deepEqual(result.retired!.stages.map(stage => `${stage.scope}/${stage.intent}`).sort(), ['runs/cut-off', 'triggers/in-wal']);
  assert.deepEqual(committed(dir), before);
});

test('commit failure reproduction: a refused commit leaves its stage while the worker runs; the next start retires it', async t => {
  const dir = await currentStore(t);
  const storage = await currentStorage(dir, { initialize: false });
  const runs = new RunsRepository(storage);
  // A guarded change whose previous value is not there: the commit refuses inside its transaction.
  const failed = await runs.update([{ kind: 'created', id: 'gone', json: '{}', previous: '{"was":1}' }]).then(() => undefined, (error: unknown) => error);
  assert.ok(failed instanceof StorageCommandError && failed.disposition === 'not-committed', String(failed));
  assert.equal(rows(join(dir, DATABASE), 'runs_stages').length, 1, 'the stage outlives the refused commit');
  await storage.close();
  const before = committed(dir);
  const result = await start(dir);
  assert.equal(result.refusal, undefined, JSON.stringify(result.refusal));
  assert.equal(result.retired!.stages.length, 1);
  assert.deepEqual(committed(dir), before);
  assert.deepEqual(stageCount(dir), none);
});

test('a stage that cannot be preserved is not removed: the start stays held', async t => {
  const dir = await currentStore(t);
  sql(dir, stageRow('runs', 'unkept', 1));
  // The snapshot folder cannot be made: a plain file has its name.
  await writeFile(join(dir, 'storage-snapshots'), 'not a folder', { mode: 0o600 });
  const result = await start(dir);
  assert.deepEqual([result.refusal?.code, result.refusal?.state], ['stages-held', 'recovery-required']);
  assert.match(result.refusal!.reason, /snapshot or evidence could not be written/);
  assert.equal(rows(join(dir, DATABASE), 'runs_stages').length, 1);
});

test('discardStranded removes only named stages of an earlier epoch', async t => {
  const dir = await currentStore(t);
  sql(dir, stageRow('runs', 'old', 1));
  const storage = await currentStorage(dir, { initialize: false });
  t.after(() => storage.close());
  await storage.write('runs', 'begin', { intent: 'live', bytes: 1, sha256: SHA, chunks: 1 }, 'live-begin');
  const epoch = storage.status().ownerEpoch!;
  const refused = (stages: unknown, id: string) => assert.rejects(storage.write('runs', 'discardStranded', { stages }, id));
  await refused([{ intent: 'live', ownerEpoch: epoch, sha256: SHA }], 'd1');
  await refused([{ intent: 'old', ownerEpoch: 2, sha256: SHA }], 'd2');
  await refused([{ intent: 'old', ownerEpoch: 1, sha256: 'b'.repeat(64) }], 'd3');
  await refused([{ intent: 'old', ownerEpoch: 1, sha256: SHA }, { intent: 'live', ownerEpoch: epoch, sha256: SHA }], 'd4');
  assert.equal(rows(join(dir, DATABASE), 'runs_stages').length, 2, 'a refused command removes nothing');
  await storage.write('runs', 'discardStranded', { stages: [{ intent: 'old', ownerEpoch: 1, sha256: SHA }] }, 'd5');
  assert.deepEqual((rows(join(dir, DATABASE), 'runs_stages') as { intent: string }[]).map(row => row.intent), ['live']);
});

test('a retired runs stage stays marked for restore across starts until settled; other domains never mark', async t => {
  const dir = await currentStore(t);
  sql(dir, stageRow('triggers', 'only-triggers', 1));
  await start(dir);
  assert.deepEqual(await unsettledRunsRetirements(dir), [], 'a triggers stage asks nothing of runs restore');
  sql(dir, stageRow('runs', 'started-maybe', 1));
  const first = await start(dir);
  assert.deepEqual(await unsettledRunsRetirements(dir), [first.retired!.evidence]);
  // Another reboot before the worker saved its restore: the mark is still there for the next one.
  await start(dir);
  assert.deepEqual(await unsettledRunsRetirements(dir), [first.retired!.evidence]);
  await settleRunsRetirements([first.retired!.evidence]);
  assert.deepEqual(await unsettledRunsRetirements(dir), []);
  assert.equal(JSON.parse(await readFile(first.retired!.evidence, 'utf8')).stages[0].intent, 'started-maybe', 'settling keeps the evidence');
  await writeFile(join(dir, 'storage-recovery', 'stranded-stages', 'broken.json'), '{', { mode: 0o600 });
  assert.deepEqual((await unsettledRunsRetirements(dir)).map(path => path.split('/').pop()), ['broken.json'], 'an unreadable document counts as unsettled');
});

test('a removal that fails part way keeps the runs mark (written before any row goes) and the next start finishes it', async t => {
  const dir = await currentStore(t);
  sql(dir, stageRow('runs', 'first', 1) + stageRow('triggers', 'second', 1));
  const storage = await currentStorage(dir, { initialize: false });
  const failing = new Proxy(storage, { get(target, key) {
    if (key === 'write') return (scope: string, command: string, payload: unknown, id: string) => scope === 'triggers' && command === 'discardStranded'
      ? Promise.reject(new Error('injected')) : target.write(scope, command, payload, id);
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } }) as StorageClient;
  const authorities = new Map((await storage.inspect()).authority.map(authority => [authority.domain, authority]));
  await assert.rejects(retireStrandedStages(failing, dir, authorities), /injected/);
  await storage.close();
  assert.equal(rows(join(dir, DATABASE), 'runs_stages').length, 0);
  assert.equal(rows(join(dir, DATABASE), 'triggers_stages').length, 1);
  assert.equal((await unsettledRunsRetirements(dir)).length, 1, 'the runs removal is remembered although the call failed');
  const next = await start(dir);
  assert.equal(next.refusal, undefined, JSON.stringify(next.refusal));
  assert.deepEqual(next.retired!.stages.map(stage => stage.intent), ['second']);
  assert.equal((await unsettledRunsRetirements(dir)).length, 1);
});
