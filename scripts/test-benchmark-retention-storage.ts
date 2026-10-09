/** Hosted disposable fixture only. No native sessions, production state, or speedup claim. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { retentionBuild } from '../tests/server/storage/fixtures/retention-build.js';
import { recordPreparationEvidence } from '../server/link/storage-update.js';
import type { StorageClient } from '../server/storage/client.js';
import { RetentionStore } from '../server/sessions/retention/store.js';
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
try {
  const a = await retentionBuild('1.120.0', join(root, 'a-artifact')), b = await retentionBuild('1.121.0', join(root, 'b-artifact'));
  const legacyDir = join(root, 'json'), sqlDir = join(root, 'sql'); await seed(legacyDir); await seed(sqlDir);
  const legacy = new RetentionStore(join(legacyDir, 'retention')); await legacy.start();
  const json = await workload(legacy);
  client = await a.storage.openStorage({ stateDir: sqlDir, bundle: a.bundle() });
  const prepared = await client.prepare({ allowMigration: true });
  await recordPreparationEvidence(sqlDir, { context: client.context!, preflight: await a.storage.preflightStorage({ bundle: a.bundle(), stateDir: sqlDir }), prepared, gate: await client.gate('core') }); await client.close();
  client = await b.storage.openStorage({ stateDir: sqlDir, bundle: b.bundle() }); await client.prepare({ allowMigration: false });
  const evidenceParent = join(sqlDir, 'storage-migrations'); await mkdir(evidenceParent, { mode: 0o700 });
  const migrationStart = performance.now();
  await importRetention({ stateDir: sqlDir, evidenceParent, storage: client, update: { stateDir: sqlDir, managed: false, build: { version: b.version, manifest: b.manifest, preflight: await b.storage.preflightStorage({ bundle: b.bundle(), stateDir: sqlDir }) } } });
  const migrationMs = performance.now() - migrationStart;
  const sql = new RetentionStore(join(sqlDir, 'retention'), { storage: client }); await sql.start();
  const sqlite = await workload(sql);
  if (json.projectionSha256 !== sqlite.projectionSha256) throw new Error('JSON/SQL workload projections differ.');
  await writeFile(out, JSON.stringify({ version: 1, runtime: process.version, input: { entries: 2000, journalBytes: Buffer.byteLength(JSON.stringify(journal)) }, json, sqlite, migrationMs,
    netBenefitEvidence: { measured: ['raw FULL/fsynced write samples', 'same workload projection', 'one-time import/backup elapsed'], unmeasuredCosts: ['A/B releases and reviewed artifact protection', 'common manifest and preparation evidence maintenance', 'chain/pin and update barrier fixture maintenance', 'source backup disk and operation receipt/staging growth', 'current export/restore and recovery fixture maintenance'], conclusion: 'Raw measurements only; no speedup/net-benefit claim. Parent evaluates complete lifecycle cost before expanding #84.' } }, null, 2));
} finally { await client?.close(); await rm(root, { recursive: true, force: true }); }
