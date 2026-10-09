/** Hosted disposable fixture only. No native sessions, production state, or speedup claim. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { retentionBuild } from '../tests/server/storage/fixtures/retention-build.js';
import { recordPreparationEvidence } from '../server/link/storage-update.js';
import type { StorageClient } from '../server/storage/client.js';
import { RetentionStore } from '../server/sessions/retention/store.js';
import { bootstrapRuns } from '../server/runs/storage-transfer.js';
import { RunsRepository } from '../server/runs/storage-repository.js';
import { RunHistory } from '../server/runs/run-history.js';
import { canonical, runHash, type RunDocuments } from '../server/runs/storage-codec.js';
import { importRetention } from '../server/sessions/retention/storage-transfer.js';
import { journalDocument, observationDocument, retentionHash } from '../server/sessions/retention/storage-codec.js';

const out = process.argv[2];
if (!out) throw new Error('Supply a hosted CI output JSON path. This benchmark creates only disposable fixture data.');
const root = await mkdtemp(join(tmpdir(), 'tower-retention-benchmark-'));
let client: StorageClient | undefined;
const journal = journalDocument({ version: 1, migratedAt: 1234, entries: Array.from({ length: 2000 }, (_, index) => ({ id: `op-${index}`, phase: 'blocked-provider', candidate: { ids: [`codex:fixture-${index}`] }, error: '', extra: 'x'.repeat(2048) })), policies: [] });
const observations = observationDocument({ version: 1, entries: [] });
async function seed(path: string) {
  await mkdir(path, { mode: 0o700 }); await mkdir(join(path, 'retention'), { mode: 0o700 });
  await writeFile(join(path, 'retention', 'journal.json'), JSON.stringify(journal), { mode: 0o600 });
  await writeFile(join(path, 'retention-observations.json'), JSON.stringify(observations), { mode: 0o600 });
}
async function workload(store: RetentionStore) {
  const start = performance.now(), writes: number[] = [];
  for (let index = 0; index < 50; index++) {
    const before = performance.now(), row = store.get(`op-${index}`)!;
    await store.putIfUnchanged([{ previous: row, next: { ...row, error: `representative-${index}` } }], () => true);
    writes.push(performance.now() - before);
  }
  for (let index = 50; index < 100; index++) await store.removeMetadata([`op-${index}`]);
  for (let index = 0; index < 25; index++) await store.setPolicy({ id: `policy-${index}`, archiveRevision: index });
  return { elapsedMs: performance.now() - start, writesMs: writes, projectionSha256: retentionHash(JSON.stringify({ entries: store.list(), policies: Array.from({ length: 25 }, (_, index) => store.policy(`policy-${index}`)) })) };
}
async function runsSample() {
  const data: RunDocuments = { runs: Array.from({ length: 100 }, (_, index) => ({ id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, sessionId: `codex:fixture-${index}`, prompt: 'sample', status: 'completed', createdAt: '2026-10-01T00:00:00Z', output: 'x'.repeat(4096) })), created: [], instructions: {} };
  const a = await retentionBuild('1.122.0', join(root, 'runs-a')), b = await retentionBuild('1.123.0', join(root, 'runs-b'));
  const jsonDir = join(root, 'runs-json'), sqlDir = join(root, 'runs-sql');
  for (const path of [jsonDir, sqlDir]) {
    await mkdir(path, { mode: 0o700 });
    for (const [kind, name] of [['runs', 'runs.json'], ['created', 'created-sessions.json'], ['instructions', 'run-instructions.json']] as const) await writeFile(join(path, name), JSON.stringify(data[kind]), { mode: 0o600 });
  }
  let sdk = await a.storage.openStorage({ stateDir: sqlDir, bundle: a.bundle() });
  try {
    const prepared = await sdk.prepare({ allowMigration: true });
    await recordPreparationEvidence(sqlDir, { context: sdk.context!, prepared, preflight: await a.storage.preflightStorage({ stateDir: sqlDir, bundle: a.bundle() }), gate: await sdk.gate('core') });
  } finally { await sdk.close(); }
  sdk = await b.storage.openStorage({ stateDir: sqlDir, bundle: b.bundle() });
  try {
    await sdk.prepare({ allowMigration: false });
    const repository = new RunsRepository(sdk), migrationStart = performance.now();
    await bootstrapRuns(repository, sqlDir, async () => ({ stateDir: sqlDir, managed: false, build: { version: b.version, manifest: b.manifest, preflight: await b.storage.preflightStorage({ stateDir: sqlDir, bundle: b.bundle() }) } }))();
    const migrationMs = performance.now() - migrationStart;
    const sample = async (history: RunHistory) => {
      const startup = performance.now(); await history.readCreated(); const restored = await history.restore(); const startupMs = performance.now() - startup;
      const writesMs: number[] = [], live = new Map(restored.map(run => [run.id, run]));
      for (let index = 0; index < 10; index++) {
        live.get(data.runs[index].id)!.output = `sample-${index}`;
        const start = performance.now(); history.save(live, [...live.values()], '[]', new Set()); await history.flush(); writesMs.push(performance.now() - start);
      }
      return { startupMs, writesMs, projectionSha256: runHash(canonical([...live.values()])) };
    };
    const json = await sample(new RunHistory(jsonDir)), sqlite = await sample(new RunHistory(sqlDir, sdk));
    if (json.projectionSha256 !== sqlite.projectionSha256) throw new Error('Runs JSON/SQL workload projections differ.');
    return { input: { runs: data.runs.length, sourceBytes: Buffer.byteLength(JSON.stringify(data)) }, json, sqlite, migrationMs, conclusion: 'Small disposable sample only; no net-benefit claim.' };
  } finally { await sdk.close(); }
}
try {
  const a = await retentionBuild('1.120.2', join(root, 'a-artifact')), b = await retentionBuild('1.121.0', join(root, 'b-artifact'));
  const legacyDir = join(root, 'json'), sqlDir = join(root, 'sql'); await seed(legacyDir); await seed(sqlDir);
  const legacy = new RetentionStore(join(legacyDir, 'retention')), jsonStartup = performance.now(); await legacy.start();
  const jsonStartupMs = performance.now() - jsonStartup;
  const json = await workload(legacy);
  client = await a.storage.openStorage({ stateDir: sqlDir, bundle: a.bundle() });
  const prepared = await client.prepare({ allowMigration: true });
  await recordPreparationEvidence(sqlDir, { context: client.context!, preflight: await a.storage.preflightStorage({ bundle: a.bundle(), stateDir: sqlDir }), prepared, gate: await client.gate('core') }); await client.close();
  client = await b.storage.openStorage({ stateDir: sqlDir, bundle: b.bundle() }); await client.prepare({ allowMigration: false });
  const evidenceParent = join(sqlDir, 'storage-migrations'); await mkdir(evidenceParent, { mode: 0o700 });
  const migrationStart = performance.now();
  await importRetention({ stateDir: sqlDir, evidenceParent, storage: client, update: { stateDir: sqlDir, managed: false, build: { version: b.version, manifest: b.manifest, preflight: await b.storage.preflightStorage({ bundle: b.bundle(), stateDir: sqlDir }) } } });
  const migrationMs = performance.now() - migrationStart;
  const sql = new RetentionStore(join(sqlDir, 'retention'), { storage: client }), sqlStartup = performance.now(); await sql.start();
  const sqliteStartupMs = performance.now() - sqlStartup;
  const sqlite = await workload(sql);
  if (json.projectionSha256 !== sqlite.projectionSha256) throw new Error('JSON/SQL workload projections differ.');
  const runs = await runsSample();
  await writeFile(out, JSON.stringify({ runs, version: 1, runtime: process.version, input: { entries: 2000, journalBytes: Buffer.byteLength(JSON.stringify(journal)) }, json: { ...json, startupMs: jsonStartupMs }, sqlite: { ...sqlite, startupMs: sqliteStartupMs }, migrationMs,
    netBenefitEvidence: { measured: ['raw FULL/fsynced write samples', 'same workload projection', 'one-time import/backup elapsed'], unmeasuredCosts: ['A/B releases and reviewed artifact protection', 'common manifest and preparation evidence maintenance', 'chain/pin and update barrier fixture maintenance', 'source backup disk and operation receipt/staging growth', 'current export/restore and recovery fixture maintenance'], conclusion: 'Raw measurements only; no speedup/net-benefit claim. Parent evaluates complete lifecycle cost before expanding #84.' } }, null, 2));
} finally { await client?.close(); await rm(root, { recursive: true, force: true }); }
