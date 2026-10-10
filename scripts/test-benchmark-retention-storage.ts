/** Hosted disposable fixture only. No native sessions, production state, or speedup claim. */
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { empty } from '../server/triggers/state.js';
import { performance } from 'node:perf_hooks';
import { retentionBuild, protectedOld124, currentProductProfile } from '../tests/server/storage/fixtures/retention-build.js';
import type { StorageClient } from '../server/storage/client.js';
import { RetentionStore } from '../server/sessions/retention/store.js';
import { RunHistory } from '../server/runs/run-history.js';
import { canonical, runHash, type RunDocuments } from '../server/runs/storage-codec.js';
import { journalDocument, observationDocument, retentionHash } from '../server/sessions/retention/storage-codec.js';

const out = process.argv[2];
if (!out) throw new Error('Supply a hosted CI output JSON path. This benchmark creates only disposable fixture data.');
const root = await mkdtemp(join(tmpdir(), 'tower-retention-benchmark-'));
let client: StorageClient | undefined;
const oldLegacy=await protectedOld124();
const journal = journalDocument({ version: 1, migratedAt: 1234, entries: Array.from({ length: 2000 }, (_, index) => ({ id: `op-${index}`, phase: 'blocked-provider', candidate: { ids: [`codex:fixture-${index}`] }, error: '', extra: 'x'.repeat(2048) })), policies: [] });
const observations = observationDocument({ version: 1, entries: [] });
async function seed(path: string) {
  await mkdir(path, { mode: 0o700 }); await mkdir(join(path, 'retention'), { mode: 0o700 });
  await writeFile(join(path, 'retention', 'journal.json'), JSON.stringify(journal), { mode: 0o600 });
  await writeFile(join(path, 'retention-observations.json'), JSON.stringify(observations), { mode: 0o600 });
}
// Current SQL candidate uses the same existing offline CLI and full old backup binding as delivery.
async function activateCurrentSql(stateDir:string,label:string) {
  const old=await oldLegacy.storage.openStorage({stateDir,bundle:oldLegacy.bundle()});
  const prepared=await old.prepare({allowMigration:true});await old.close();
  if(prepared.schema.kind==='empty') throw new Error('Old fixture did not prepare SQL.');
  await mkdir(join(stateDir,'retention'),{recursive:true,mode:0o700});
  for(const [name,value] of Object.entries({'runs.json':[],'created-sessions.json':[],'run-instructions.json':{},'trigger-engine.json':empty(),
    'permissions.json':{version:1,rules:[],requests:[],codex:[]},'retention/journal.json':{version:1,migratedAt:1234,entries:[],policies:[]},'retention-observations.json':{version:1,entries:[]}})) {
    try {await writeFile(join(stateDir,name),JSON.stringify(value),{mode:0o600,flag:'wx'});}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;}
  }
  const final=await retentionBuild('1.125.0',join(root,`${label}-candidate`),true,true,true,await currentProductProfile());
  const context=final.storage.storageBuildContext(final.bundle());if(!context.ok) throw new Error('Current SQL SDK held.');
  const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const entry=join(oldLegacy.packageRoot,'bin/agent-session-tower.mjs'),contract=join(oldLegacy.directory,'storage-contract.json');
  const input=join(root,`${label}-activation.json`);
  await writeFile(input,JSON.stringify({format:'tower-offline-owner',backupRoot:join(root,`${label}-full-backup`),activation:{format:'tower-offline-activation',version:1,activationId:`benchmark-${label}`,stateDir,
    storageId:prepared.schema.storageId,build:context.identity,manifest:context.manifest,targets:['core',...context.manifest.domains.map(d=>d.scope)],domains:[],phase:'pending',
    oldArtifact:{identity:oldLegacy.contract.identity,entry:{path:entry,sha256:hash(await readFile(entry))},contract:{path:contract,sha256:hash(await readFile(contract))}}}}),{mode:0o600});
  const start=performance.now();await final.storage.runOfflineStorageCommand(['activate','--state-dir',stateDir,'--input',input]);
  const migrationMs=performance.now()-start;
  const sdk=await final.storage.openStorage({stateDir,bundle:final.bundle()});await sdk.prepare({allowMigration:false});
  return {sdk,migrationMs,identity:sdk.identity};
}
async function workload(store: Pick<RetentionStore,'get'|'putIfUnchanged'|'removeMetadata'|'setPolicy'|'list'|'policy'>) {
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
  const jsonDir = join(root, 'runs-json'), sqlDir = join(root, 'runs-sql');
  for (const path of [jsonDir, sqlDir]) {
    await mkdir(path, { mode: 0o700 });
    for (const [kind, name] of [['runs', 'runs.json'], ['created', 'created-sessions.json'], ['instructions', 'run-instructions.json']] as const) await writeFile(join(path, name), JSON.stringify(data[kind]), { mode: 0o600 });
  }
  const {sdk,migrationMs,identity}=await activateCurrentSql(sqlDir,'runs');
  try {
    const sample = async (history: Pick<RunHistory,'readCreated'|'restore'|'flush'>,save:(live:Map<string,import('../shared/types.js').Run>,changed:import('../shared/types.js').Run)=>void) => {
      const startup = performance.now(); await history.readCreated(); const restored = await history.restore(); const startupMs = performance.now() - startup;
      const writesMs: number[] = [], live = new Map(restored.map(run => [run.id, run]));
      for (let index = 0; index < 10; index++) {
        const changed = live.get(data.runs[index].id)!; changed.output = `sample-${index}`;
        const start = performance.now(); save(live,changed); await history.flush(); writesMs.push(performance.now() - start);
      }
      return { startupMs, writesMs, projectionSha256: runHash(canonical(await history.restore())) };
    };
    const jsonHistory=new oldLegacy.RunHistory(jsonDir), sqlHistory=new RunHistory(sqlDir,sdk);
    const json=await sample(jsonHistory,live=>jsonHistory.save(live,[...live.values()],'[]',new Set()));
    const sqlite=await sample(sqlHistory,(_live,changed)=>sqlHistory.saveRows({runs:[changed],deleted:[],created:[],deletedCreated:[],retained:new Set()}));
    if (json.projectionSha256 !== sqlite.projectionSha256) throw new Error('Runs JSON/SQL workload projections differ.');
    return { candidateIdentity:identity,input: { runs: data.runs.length, sourceBytes: Buffer.byteLength(JSON.stringify(data)) }, json, sqlite, migrationMs, conclusion: 'Small disposable sample only; no net-benefit claim.' };
  } finally { await sdk.close(); }
}
try {
  const legacyDir = join(root, 'json'), sqlDir = join(root, 'sql'); await seed(legacyDir); await seed(sqlDir);
  const legacy = new oldLegacy.RetentionStore(join(legacyDir, 'retention')), jsonStartup = performance.now(); await legacy.start();
  const jsonStartupMs = performance.now() - jsonStartup;
  const json = await workload(legacy);
  const current=await activateCurrentSql(sqlDir,'retention');client=current.sdk;const migrationMs=current.migrationMs;
  const sql = new RetentionStore(join(sqlDir, 'retention'), { storage: client }), sqlStartup = performance.now(); await sql.start();
  const sqliteStartupMs = performance.now() - sqlStartup;
  const sqlite = await workload(sql);
  if (json.projectionSha256 !== sqlite.projectionSha256) throw new Error('JSON/SQL workload projections differ.');
  const runs = await runsSample();
  await writeFile(out, JSON.stringify({ runs, candidateIdentity:current.identity,oldBaseline: { packageSHA256: oldLegacy.receipt.packageSHA256, identity: oldLegacy.contract.identity, members: 714 }, version: 1, runtime: process.version, input: { entries: 2000, journalBytes: Buffer.byteLength(JSON.stringify(journal)) }, json: { ...json, startupMs: jsonStartupMs }, sqlite: { ...sqlite, startupMs: sqliteStartupMs }, migrationMs,
    netBenefitEvidence: { measured: ['raw FULL/fsynced write samples', 'same workload projection', 'one-time import/backup elapsed'], unmeasuredCosts: ['A/B releases and reviewed artifact protection', 'common manifest and preparation evidence maintenance', 'chain/pin and update barrier fixture maintenance', 'source backup disk and operation receipt/staging growth', 'current export/restore and recovery fixture maintenance'], conclusion: 'Raw measurements only; no speedup/net-benefit claim. Parent evaluates complete lifecycle cost before expanding #84.' } }, null, 2));
} finally { await client?.close(); await rm(root, { recursive: true, force: true }); }
