import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { retentionBuild } from '../storage/fixtures/retention-build.js';
import { recordPreparationEvidence } from '../../../server/link/storage-update.js';
import { RunsRepository } from '../../../server/runs/storage-repository.js';
import { RunHistory } from '../../../server/runs/run-history.js';
import { RunManager } from '../../../server/runs/manager.js';
import { canonical, documentsHash, parseRunDocuments, rowsOf, RUN_SOURCE_BYTES, type RunDocuments } from '../../../server/runs/storage-codec.js';
import { importRuns, exportRuns, restoreRunsStorage, workerLegacyFiles } from '../../../server/runs/storage-transfer.js';
import { RemoteRequestLedger } from '../../../server/remote/request-ledger.js';
import type { Run, Session } from '../../../shared/types.js';
import type { PermissionRequest } from '../../../shared/permissions.js';
import { until } from '../../helpers/until.ts';

async function folder(t: TestContext) {
  const path = await realpath(await mkdtemp(join(tmpdir(),'tower-runs-fixture-')));
  t.after(() => rm(path,{ recursive: true, force: true })); return path;
}
function documents(cwd: string): RunDocuments {
  const id = '10000000-0000-4000-8000-000000000001', sessionId = 'codex:monitor-10000000-0000-4000-8000-000000000002';
  const session: Session = { id: sessionId, nativeId: '', provider: 'codex', title: 'Fixture', cwd, project: 'fixture', status: 'idle', statusReason: '', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', lastMessage: '', messageCount: 0, isSubagent: false, resumable: false, creationPending: true };
  return { runs: [{ id,sessionId,prompt: 'fixture',status: 'queued',createdAt: session.createdAt,output: '', needsInstructions: true, keepQueued: true, extra: { raw: ['preserved'] } } as unknown as Run], created: [{ session,runId: id,confirmed: false,origin: { kind: 'owner', untrustedInput: false } }], instructions: { [id]: { text: 'Required fixture instructions', required: true } } };
}
async function sources(stateDir: string, data: RunDocuments) {
  for (const [key,name] of [['runs','runs.json'],['created','created-sessions.json'],['instructions','run-instructions.json']] as const) await writeFile(join(stateDir,name),JSON.stringify(data[key]),{ mode: 0o600 });
  const evidenceParent = join(stateDir,'runs-storage-migrations'); await mkdir(evidenceParent,{ mode: 0o700 }); return evidenceParent;
}
async function prepared(t: TestContext) {
  const stateDir = await folder(t), a = await retentionBuild('1.122.0',await folder(t)), b = await retentionBuild('1.123.0',await folder(t));
  const ac = await a.storage.openStorage({ stateDir,bundle: a.bundle() });
  const prepare = await ac.prepare({ allowMigration: true });
  const preflight = await a.storage.preflightStorage({ stateDir,bundle: a.bundle() });
  await recordPreparationEvidence(stateDir,{ context: ac.context!,preflight,prepared: prepare,gate: await ac.gate('core') });
  await ac.close();
  const open = async (build: typeof a, fault = 'normal') => {
    const client = await build.storage.openStorage({ stateDir,bundle: build.bundle(fault) });
    t.after(() => client.close()); await client.prepare({ allowMigration: false }); return client;
  };
  return { stateDir,a,b,open };
}

test('actual runs A refuses first import; B authority survives absent/stale JSON; A reader/writer/export/restore', async t => {
  const f = await prepared(t), data = documents(f.stateDir), evidenceParent = await sources(f.stateDir,data);
  const ac = await f.open(f.a), ar = new RunsRepository(ac);
  await assert.rejects(ar.importPrepared(data,'a'.repeat(64),'a-refusal'),/no cutover/);
  const aUpdate = { stateDir: f.stateDir,managed: false,build: { version: f.a.version,manifest: f.a.manifest,preflight: await f.a.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.a.bundle() }) } };
  await assert.rejects(importRuns({ storage: ac,repository: ar,stateDir: f.stateDir,evidenceParent,commandId: 'a-import',update: aUpdate }),/no cutover/);
  assert.equal((await ac.receipt('a-refusal-begin')).found,false);
  await ac.close();
  const bc = await f.open(f.b), br = new RunsRepository(bc);
  const update = { stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle() }) } };
  const evidence = await importRuns({ storage: bc,repository: br,stateDir: f.stateDir,evidenceParent,commandId: 'b-import',update });
  assert.deepEqual((await br.exportCurrent()).documents,data);
  assert.equal((await bc.receipt('b-import-commit')).found,true);
  const manifest = JSON.parse(await readFile(join(evidence.directory,'manifest.json'),'utf8'));
  assert.equal(manifest.canonicalSha256,documentsHash(data));
  await bc.close();
  await rm(join(f.stateDir,'runs.json')); await writeFile(join(f.stateDir,'run-instructions.json'),'{bad');
  const current = await f.open(f.a), repository = new RunsRepository(current), history = new RunHistory(f.stateDir,current);
  assert.deepEqual(await history.readCreated(),data.created);
  const restored = await history.restore(); assert.equal(restored[0].status,'queued'); assert.equal(restored[0].instructions?.text,data.instructions[data.runs[0].id].text);
  const run = data.runs[0], required = { text: 'Only instructions changed',required: true };
  await repository.markers(run,{ needsInstructions: true,keepQueued: true },required,data.instructions[run.id],'instructions-only');
  assert.equal((await repository.exportCurrent()).documents.instructions[run.id].text,required.text);
  await repository.markers(run,{ needsInstructions: true,keepQueued: true },required,data.instructions[run.id],'instructions-only');
  await assert.rejects(repository.markers(run,{ needsInstructions: true,keepQueued: true },{ text: 'different',required: true },data.instructions[run.id],'instructions-only'),/conflicts/);
  const compatible = new RunHistory(f.stateDir,current);
  await compatible.readCreated();
  const ready = await compatible.restore(), live = new Map(ready.map(value => [value.id,value]));
  live.get(run.id)!.instructions = { text: 'Compatibility instructions only',required: true };
  compatible.carried.delete(run.id);
  compatible.save(live,ready.map(({ instructions: _private,...value }) => value),JSON.stringify(data.created),new Set());
  await compatible.flush();
  const compatibleData = (await repository.exportCurrent()).documents;
  assert.equal(compatibleData.instructions[run.id].text,'Compatibility instructions only');
  assert.equal((compatibleData.runs[0] as unknown as { keepQueued?: boolean }).keepQueued,undefined);
  const saved = await exportRuns(repository,evidenceParent,'current-export');
  await repository.output(compatibleData.runs[0],'new output','output-change');
  await restoreRunsStorage(repository,saved.directory,'restore-current');
  assert.equal((await repository.exportCurrent()).documents.runs[0].output,'');
  await restoreRunsStorage(repository,saved.directory,'restore-current');
  await assert.rejects(repository.restore({ ...data,runs: [] },'restore-current'),/conflicts/);
  const remove = rowsOf((await repository.exportCurrent()).documents);
  await repository.deleteRows(remove,'delete-dependencies');
  assert.deepEqual((await repository.exportCurrent()).documents,{ runs: [],created: [],instructions: {} });
  await repository.admit({ run: data.runs[0],created: data.created[0],instructions: data.instructions[run.id] },'single-admission');
  assert.deepEqual((await repository.exportCurrent()).documents,data);
  await repository.admit({ run: data.runs[0],created: data.created[0],instructions: data.instructions[run.id] },'single-admission');
  await assert.rejects(repository.admit({ run: { ...data.runs[0],prompt: 'different' },created: data.created[0],instructions: data.instructions[run.id] },'single-admission'),/conflicts/);
  const receipt = await current.write('runs','commit',{ intent: 'delete-dependencies' },'delete-dependencies-commit');
  assert.equal(receipt.replayed,true);
  await assert.rejects(current.write('runs','commit',{ intent: 'other' },'delete-dependencies-commit'),/different|conflict|payload/i);
});

test('actual malformed/missing state and unknown authority marker never become empty JSON fallback', async t => {
  for (const damage of ['missing','unknown','orphan','malformed','marker-only'] as const) {
    const f = await prepared(t), client = await f.open(f.b), repo = new RunsRepository(client), data = documents(f.stateDir);
    await repo.importPrepared(data,'a'.repeat(64),`import-${damage}`); await client.close();
    const db = new DatabaseSync(join(f.stateDir,'state.sqlite'));
    if (damage === 'missing') db.exec('DELETE FROM runs_state');
    if (damage === 'unknown') db.exec("UPDATE domain_imports SET reader_contract = 99 WHERE domain = 'runs'");
    if (damage === 'malformed') db.exec("UPDATE runs_rows SET json = '{bad' WHERE kind = 'run'");
    if (damage === 'marker-only') db.exec('DELETE FROM runs_state; DELETE FROM runs_rows');
    if (damage === 'orphan') db.exec("DELETE FROM domain_imports WHERE domain = 'runs'");
    db.close();
    const reopened = await f.open(f.a);
    await assert.rejects(new RunHistory(f.stateDir,reopened).readCreated());
  }
});

test('raw runs validation retains unknown fields/markers and rejects malformed, missing and unknown markers', () => {
  const data = documents('/fixture'), raw = { runs: Buffer.from(JSON.stringify(data.runs)),created: Buffer.from(JSON.stringify(data.created)),instructions: Buffer.from(JSON.stringify(data.instructions)) };
  assert.deepEqual(parseRunDocuments(raw),data);
  assert.throws(() => parseRunDocuments({ ...raw,runs: Buffer.from('{bad') }));
  assert.throws(() => parseRunDocuments({ ...raw,runs: Buffer.from(JSON.stringify([{ ...data.runs[0],keepQueued: 'unknown' }])) }));
  assert.throws(() => parseRunDocuments({ ...raw,created: Buffer.from('null') }));
  assert.throws(() => parseRunDocuments({ ...raw,runs: Buffer.alloc(RUN_SOURCE_BYTES + 1) }));
});

for (const fault of ['before','after-native-hold','runs-refuse-compensation-loss']) test(`actual ${fault} response loss holds manager attachments/placeholder/remote ledger and provider until receipt resolution`, async t => {
  const f = await prepared(t), initial = await f.open(f.b), repo = new RunsRepository(initial);
  await repo.importPrepared({ runs: [],created: [],instructions: {} },'a'.repeat(64),'empty-import'); await initial.close();
  const client = await f.open(f.a,fault);
  let starts = 0;
  const manager = new RunManager({ stateDir: f.stateDir,storage: client,getSession: () => undefined,refreshSessions: async () => {},findExecutable: async () => '/fixture/codex',
    spawnProcess: () => { starts++; throw new Error('Fixture forbids native launch'); } });
  await manager.start();
  const ledger = new RemoteRequestLedger(f.stateDir); await ledger.start();
  const now = Date.now().toString(16).padStart(12,'0'), requestId = `${now.slice(0,8)}-${now.slice(8)}-7123-8abc-0123456789ab`;
  let attempts = 0;
  const execute = async () => { attempts++; return manager.create({ provider: 'codex',cwd: f.stateDir,prompt: 'native-hold-response-lost', attachments: [{ name: 'proof.txt',mimeType: 'text/plain',data: Buffer.from('preserve attachments').toString('base64') }] },{ instructions: { text: 'required',required: true },trustWorkspace: false }); };
  await assert.rejects(ledger.once('controllerfixture','create',requestId,{},execute,value => ({ kind: 'run',runId: value.run.id }),() => undefined), (error: { disposition?: string }) => error.disposition === 'uncertain');
  const pending = manager.pendingAdmission()!;
  assert.ok(pending.commandId); assert.equal(manager.list().length,1); assert.equal(manager.sessionList([]).length,1); assert.equal(starts,0);
  const runId = manager.list()[0].id, attachmentId = manager.list()[0].attachments![0].id;
  assert.ok((await manager.attachment(attachmentId)).content);
  const held = await manager.attachment(attachmentId);
  await assert.rejects(manager.flushState(),(error: { disposition?: string }) => error.disposition === 'uncertain');
  await assert.rejects(ledger.once('controllerfixture','create',requestId,{},execute,value => ({ kind: 'run',runId: value.run.id }),() => undefined),/확실하지/);
  assert.equal(attempts,1); assert.equal(starts,0);
  assert.deepEqual(await manager.attachment(attachmentId),held,'unknown keeps prepared attachment files');
  await client.reopen(); await client.prepare({ allowMigration: false });
  manager.releaseStorage();
  assert.deepEqual(manager.pendingAdmission(),pending,'SDK prepare/release does not settle the original identity');
  assert.equal(starts,0);
  assert.equal((await client.receipt(pending.commandId)).found,fault !== 'before');
  manager.holdStorage();
  assert.deepEqual(await manager.resolveAdmission(pending.commandId),{ disposition: fault === 'before' ? 'not-committed' : 'committed',runIds: [runId] });
  assert.equal(manager.list().length,fault === 'before' ? 0 : 1);
  assert.equal(starts,0,'resolution does not execute a provider');
  if (fault === 'runs-refuse-compensation-loss') {
    assert.ok((await manager.attachment(attachmentId)).content);
    assert.equal(manager.sessionList([]).length,1);
    await assert.rejects(ledger.once('controllerfixture','create',requestId,{},execute,value => ({ kind: 'run',runId: value.run.id }),() => undefined),/확실하지/);
    assert.equal(attempts,1);
  }
  manager.holdStorage(); await manager.close();
});

for (const fault of ['before','after-native-hold']) test(`actual permission continuation ${fault} stays held across reopen and never reinserts absent reservations`, async t => {
  const f = await prepared(t), initial = await f.open(f.b), data = documents(f.stateDir);
  const parent: Run = { id: data.runs[0].id,sessionId: data.runs[0].sessionId,prompt: 'Parent',output: '',createdAt: data.runs[0].createdAt,status: 'completed',finishedAt: data.runs[0].createdAt };
  await new RunsRepository(initial).importPrepared({ runs: [parent],created: [],instructions: {} },'a'.repeat(64),'permission-parent');
  await initial.close();
  const client = await f.open(f.a,fault);
  let starts = 0;
  const manager = new RunManager({ stateDir: f.stateDir,storage: client,holdUntilReady: true,getSession: () => ({ ...data.created[0].session,creationPending: false }),refreshSessions: async () => {},
    findExecutable: async () => '/fixture/codex',spawnProcess: () => { starts++; throw new Error('Fixture forbids native launch'); } });
  await manager.start();
  const request: PermissionRequest = { id: '10000000-0000-4000-8000-000000000003',sessionId: parent.sessionId,runId: parent.id,status: 'approved',
    rule: { kind: 'command',value: 'fixture',providers: ['codex'],scope: 'project',cwd: f.stateDir },reason: 'Fixture',cwd: f.stateDir,createdAt: parent.createdAt };
  await assert.rejects(manager.permissionDecision(request,'native-hold-response-lost'),(error: { disposition?: string }) => error.disposition === 'uncertain');
  const pending = manager.pendingAdmission()!;
  await client.reopen(); await client.prepare({ allowMigration: false });
  manager.releaseStorage(); manager.markReady();
  assert.deepEqual(manager.pendingAdmission(),pending); assert.equal(starts,0);
  await assert.rejects(manager.flushState(),(error: { disposition?: string }) => error.disposition === 'uncertain');
  assert.equal(starts,0);
  manager.holdStorage();
  assert.deepEqual(await manager.resolveAdmission(pending.commandId),{ disposition: fault === 'before' ? 'not-committed' : 'committed',runIds: [request.id] });
  await manager.flushState();
  const current = await new RunsRepository(client).exportCurrent();
  assert.equal(current.documents.runs.some(run => run.id === request.id),fault !== 'before');
  assert.equal(manager.list().some(run => run.id === request.id),fault !== 'before');
  assert.equal(starts,0);
  await manager.close();
});

for (const wrapUp of [false,true]) test(`actual ${wrapUp ? 'update wrap-up global flush' : 'repeated steer'} loss preserves target-only delivery after target end and drain give-up`, async t => {
  const f = await prepared(t), initial = await f.open(f.b);
  await new RunsRepository(initial).importPrepared({ runs: [],created: [],instructions: {} },'a'.repeat(64),'steer-empty'); await initial.close();
  const client = await f.open(f.a,wrapUp ? 'after-native-hold' : 'after-steer-hold'), session = { ...documents(f.stateDir).created[0].session,nativeId: '10000000-0000-4000-8000-000000000002',resumable: true,creationPending: false,status: 'completed' as const };
  let inserts = 0, starts = 0, finish!: () => void, endTarget!: () => void, output!: (text: string) => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const manager = new RunManager({ stateDir: f.stateDir,storage: client,getSession: () => session,refreshSessions: async () => {},findExecutable: async () => '/fixture/codex',
    spawnProcess: () => { throw new Error('Fixture forbids native launch'); },openCodexStdio: async config => {
      starts++; output = config.onOutput; endTarget = () => { config.onFinished({ status: 'completed' }); finish(); };
      return ({
      start: async () => { config.onStarted?.('fixture'); },done,close: finish,cancel: async () => { config.onFinished({ status: 'cancelled' }); finish(); },
      respondToApproval: async () => {},canSteer: () => true,steer: async () => { inserts++; } }); } });
  await manager.start();
  const parent = await manager.enqueue(session.id,'Parent');
  await until(() => manager.list().find(run => run.id === parent.id)?.status === 'running');
  const instruction = wrapUp ? undefined : await manager.enqueue(session.id,'Insert');
  manager.beginUpdateDrain(Date.now() + 60_000,() => false);
  const write = client.write.bind(client);
  let entered!: () => void, release!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  client.write = async <T>(...args: Parameters<typeof client.write>) => {
    if (args[0] === 'runs' && args[1] === 'commit') { entered(); await wait; }
    return write<T>(...args);
  };
  if (wrapUp) {
    // Lose a real concurrent parent write while the wrap-up waits on the global flush.
    output('native-hold-response-lost');
    await saving;
    manager.driveUpdateDrain();
  }
  const queued = instruction ?? manager.list().find(run => run.updateWrapUp)!;
  assert.ok(queued);
  let successes = 0;
  const first = manager.steer(queued.id,{ targetRunId: parent.id }), firstResult = first.then(() => { successes++; },error => error);
  await saving;
  const repeat = manager.steer(queued.id), repeatResult = repeat.then(() => { successes++; },error => error);
  assert.equal(first,repeat); assert.equal(successes,0); assert.equal(inserts,0);
  release();
  const error = await firstResult;
  assert.equal(await repeatResult,error); assert.equal(error.disposition,'uncertain');
  const pending = manager.pendingAdmission()!;
  await assert.rejects(manager.steer(queued.id),(next: unknown) => next === error);
  assert.deepEqual(manager.pendingAdmission(),pending); assert.equal(successes,0); assert.equal(inserts,0);
  client.write = write;
  endTarget();
  assert.equal(manager.list().find(run => run.id === parent.id)?.status,'completed');
  await client.reopen(); await client.prepare({ allowMigration: false }); manager.holdStorage();
  await manager.resolveAdmission(pending.commandId);
  const unsent = manager.list().find(run => run.id === queued.id)!;
  assert.equal(unsent.status,'error'); assert.equal(unsent.steering?.targetRunId,parent.id);
  assert.match(unsent.error!,/not sent/);
  manager.releaseStorage(); manager.endUpdateDrain();
  await until(() => !manager.busy());
  // Await the normal pump explicitly so zero launches is checked after drain release.
  await (manager as unknown as { pump(): Promise<void> }).pump();
  await manager.flushState();
  assert.equal(starts,1,'only the original target provider exists'); assert.equal(inserts,0,'no insertion or reinsertion');
  await manager.close();
});

test('exact legacy source probes classify every domain independently', async t => {
  const stateDir = await folder(t);
  assert.equal(await workerLegacyFiles(stateDir,'runs'),'absent');
  await writeFile(join(stateDir,'created-sessions.json'),'[]');
  assert.equal(await workerLegacyFiles(stateDir,'runs'),'present');
  assert.equal(await workerLegacyFiles(stateDir,'retention'),'absent');
  assert.equal(await workerLegacyFiles(stateDir,'future'),'present');
});

test('actual 64MiB source allowance uses SDK chunks; a stale dependency fails the entire receipt TX', async t => {
  const f = await prepared(t), client = await f.open(f.b), repository = new RunsRepository(client), data = documents(f.stateDir);
  const base = Buffer.byteLength(JSON.stringify(data.runs));
  data.runs[0].output = 'x'.repeat(RUN_SOURCE_BYTES - base);
  assert.equal(Buffer.byteLength(JSON.stringify(data.runs)),RUN_SOURCE_BYTES);
  const raw = { runs: Buffer.from(JSON.stringify(data.runs)),created: Buffer.from(JSON.stringify(data.created)),instructions: Buffer.from(JSON.stringify(data.instructions)) };
  parseRunDocuments(raw);
  await repository.importPrepared(data,'a'.repeat(64),'large-source');
  assert.equal((await repository.exportCurrent()).documents.runs[0].output.length,data.runs[0].output.length);
  const before = await repository.exportCurrent(), run = before.rows.find(row => row.kind === 'run')!, instruction = before.rows.find(row => row.kind === 'instruction')!;
  await assert.rejects(repository.update([{ ...run,previous: run.json,remove: true },{ ...instruction,previous: '{}',remove: true }],'delete','atomic-refusal'),/changed/);
  assert.equal((await client.receipt('atomic-refusal-commit')).found,false);
  assert.equal((await repository.exportCurrent()).sha256,before.sha256,'failed later dependency leaves the earlier deletion uncommitted');
});

test('actual old schema refuses runs preparation rather than treating authority as legacy JSON', async t => {
  const f = await prepared(t), old = await retentionBuild('1.121.0',await folder(t));
  const client = await old.storage.openStorage({ stateDir: f.stateDir,bundle: old.bundle() });
  try {
    assert.equal(client.status().state,'unavailable'); assert.equal(client.status().failure?.code,'unknown-schema');
    await assert.rejects(client.prepare({ allowMigration: false }));
  } finally { await client.close(); }
});

test('actual B raw importer refuses missing dependency without creating empty authority or evidence', async t => {
  const f = await prepared(t), data = documents(f.stateDir), evidenceParent = await sources(f.stateDir,data), client = await f.open(f.b), repository = new RunsRepository(client);
  await rm(join(f.stateDir,'run-instructions.json'));
  const update = { stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle() }) } };
  await assert.rejects(importRuns({ storage: client,repository,stateDir: f.stateDir,evidenceParent,commandId: 'missing-source',update }),/ENOENT/);
  assert.equal((await repository.head()).authority,null);
  assert.equal((await client.receipt('missing-source-commit')).found,false);
});
