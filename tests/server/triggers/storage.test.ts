import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { retentionBuild } from '../storage/fixtures/retention-build.js';
import { artifactStorageContract, evaluateStorageUpdate, preparationCheck, readPreparationEvidence, recordPreparationEvidence } from '../../../server/link/storage-update.js';
import { TriggersRepository } from '../../../server/triggers/storage-repository.js';
import { RunsRepository } from '../../../server/runs/storage-repository.js';
import { RetentionRepository } from '../../../server/sessions/retention/storage-repository.js';
import { bootstrapRuns } from '../../../server/runs/storage-transfer.js';
import { retentionBootstrap } from '../../../server/sessions/retention/storage-transfer.js';
import { bootstrapTriggers, exportTriggers, importTriggers, restoreTriggers } from '../../../server/triggers/storage-transfer.js';
import { TriggerStore } from '../../../server/triggers/store.js';
import { TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';
import { empty, pruneState, serializeState, type EngineState } from '../../../server/triggers/state.js';
import { ACCEPT_TRIGGER_BYTES, MAX_TRIGGER_BYTES, changesOf, documentsHash, logicalBytes, rowsOf, stateOf } from '../../../server/triggers/storage-codec.js';
import { collectTriggers } from '../../../server/backup/payload.js';
import { keepBefore, takeWorkerRestore, writePendingWorker } from '../../../server/backup/restore-files.js';
import { MAX_AUDIT } from '../../../server/triggers/limits.js';
import { triggerHash } from '../../../server/triggers/storage-codec.js';
import { triggerBackupOf } from '../../../server/triggers/backup.js';
import { TriggerSourceSchema, type Trigger, type TriggerEvent } from '../../../shared/triggers.js';

async function folder(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(),'tower-triggers-sql-')));
  t.after(() => rm(directory,{ recursive: true,force: true })); return directory;
}
const now = () => Date.parse('2026-10-10T00:00:00Z');
const id = '10000000-0000-4000-8000-000000000001';
function definition(): Trigger {
  return { id,revision: 2,name: '한 번',enabled: false,createdAt: '2026-10-01T00:00:00Z',updatedAt: '2026-10-01T00:00:00Z',createdBy: { kind: 'owner',via: 'ui' },updatedBy: { kind: 'owner',via: 'ui' },
    source: { kind: 'schedule',schedule: { type: 'once',at: '2026-12-01T00:00:00.000Z' },catchUp: 'latest' },
    handler: { kind: 'task',instructions: 'fixture',provider: 'codex',approvals: 'auto',target: { node: 'local',mode: 'folder',cwd: '/fixture' } },policy: { overlap: 'skip',maxEventsPerHour: 20 } };
}
function documents(): EngineState {
  const state = empty(), trigger = definition();
  state.triggers = [trigger]; state.tombstones = [{ ...trigger,id: 'tombstone' }];
  state.revisions = { 'map key\\"한': [trigger,{ ...trigger,revision: 1 }],empty: [] };
  state.onceConsumed = { deleted: { at: '2026-10-01T00:00:00Z' },[id]: { at: '2026-10-02T00:00:00Z',eventId: '20000000-0000-4000-8000-000000000001' } };
  state.cursors = { [id]: { anchorAt: 1,nextAt: 2 },tombstone: { anchorAt: 3,polling: { slot: 4,revision: 2,method: 'POST' } } };
  state.fired = { 'key "한': '2026-10-01T00:00:00Z',second: '2026-10-02T00:00:00Z' };
  state.audit = [{ id: 'audit',at: '2026-10-01T00:00:00Z',actor: { kind: 'owner',via: 'ui' },action: 'create',triggerId: id,triggerName: '한 번',summary: 'fixture' }];
  state.events = [{ id: 'event',triggerId: id,triggerName: '한 번',triggerRevision: 2,dedupKey: 'slot',occurredAt: '2026-10-01T00:00:00Z',receivedAt: '2026-10-01T00:00:00Z',updatedAt: '2026-10-01T00:00:00Z',summary: 'fixture',requestId: 'request',status: 'queued',kind: 'schedule',input: { untrustedInput: false,target: { node: 'local',mode: 'folder',cwd: '/fixture' },instructions: 'fixture',provider: 'codex',approvals: 'auto',overlap: 'skip' } }];
  state.trustedFolders = ['/first','/second','/first','한\\"'];
  state.recentFires = [{ at: now(),triggerId: id },{ at: now() + 1,triggerId: 'tombstone' }];
  state.secretGrants = { 'grant\\"한': [id,'tombstone'],second: [id] };
  return state;
}
async function fixture(t: TestContext) {
  const stateDir = await folder(t), a = await retentionBuild('1.124.0',await folder(t)), b = await retentionBuild('1.125.0',await folder(t));
  const open = async (build = b,fault = 'normal',migration = false) => {
    const client = await build.storage.openStorage({ stateDir,bundle: build.bundle(fault) }); t.after(() => client.close());
    await client.prepare({ allowMigration: migration }); return client;
  };
  const ac = await open(a,'normal',true), prepared = await ac.prepare({ allowMigration: false });
  await recordPreparationEvidence(stateDir,{ context: ac.context!,preflight: await a.storage.preflightStorage({ stateDir,bundle: a.bundle() }),prepared,gate: await ac.gate('core') });
  await ac.close();
  const client = await open(); const repository = new TriggersRepository(client);
  return { stateDir,a,b,open,client,repository };
}

test('typed trigger rows roundtrip all ordering, keys, independent ledger and exact legacy once projection bytes', () => {
  const state = documents(), rows = rowsOf(state), restored = stateOf(rows);
  assert.deepEqual(restored,state); assert.equal(serializeState(restored),serializeState(state));
  assert.equal(logicalBytes(rows),Buffer.byteLength(serializeState(state)));
  state.triggers = []; state.tombstones = []; state.revisions = {}; state.events = [];
  pruneState(state,now); assert.ok(state.onceConsumed.deleted); assert.ok(state.onceConsumed[id]);
  assert.deepEqual(stateOf(rowsOf(state)).onceConsumed,state.onceConsumed);
  assert.equal(logicalBytes(rowsOf(state)),Buffer.byteLength(serializeState(state)));
});

test('A cannot import, B actual SDK row commands commit with receipt, indexed paging, reopen, lossless export and restore on A', async t => {
  const f = await fixture(t), data = documents(); await f.client.close();
  const ac = await f.open(f.a), ar = new TriggersRepository(ac);
  await assert.rejects(ar.importPrepared(data,'a'.repeat(64),'a-import'),/no cutover/);
  await assert.rejects(importTriggers({ repository: ar,stateDir: f.stateDir,evidenceParent: f.stateDir,commandId: 'a-seal',update: {} as never,now }),/no cutover/);
  assert.equal((await ac.receipt('a-import-begin')).found,false); await ac.close();
  const bc = await f.open(), br = new TriggersRepository(bc);
  await br.importPrepared(data,'b'.repeat(64),'first-import');
  assert.equal((await bc.receipt('first-import-commit')).found,true);
  assert.deepEqual((await br.exportCurrent()).documents,data);
  const before = rowsOf(data), next = structuredClone(data); next.trustedFolders.reverse(); next.fired['key "한'] = '2026-10-03T00:00:00Z';
  // Ledger updates also change legacy projections in definitions whose revision-map key differs from their id.
  next.onceConsumed[id] = { at: '2026-10-04T00:00:00Z' };
  await br.update(changesOf(before,rowsOf(next)),'settle','typed-update');
  await br.update(changesOf(before,rowsOf(next)),'settle','typed-update');
  assert.equal((await br.exportCurrent()).head.revision,2,'verified receipt is replayed without another write');
  const conflict = structuredClone(data); conflict.trustedFolders.push('/conflict');
  await assert.rejects(br.update(changesOf(before,rowsOf(conflict)),'grow','typed-update'),/conflicts/);
  await bc.close();
  const db = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
  const size = db.prepare('SELECT logical_bytes FROM triggers_state').get() as { logical_bytes: number };
  assert.equal(size.logical_bytes,Buffer.byteLength(serializeState(next)));
  assert.match(JSON.stringify(db.prepare("EXPLAIN QUERY PLAN SELECT ordinal FROM triggers_rows WHERE kind = 'events' AND ordinal >= 0 ORDER BY ordinal LIMIT 32").all()),/triggers_order/); db.close();
  const current = await f.open(f.a), owner = new TriggersRepository(current);
  await writeFile(join(f.stateDir,'trigger-engine.json'),'{bad',{ mode: 0o600 });
  const store = new TriggerStore({ stateDir: f.stateDir,storage: current,now,limits: () => undefined,changed: () => {} });
  await store.load(() => {}); assert.deepEqual(store.state.onceConsumed,next.onceConsumed);
  await store.commit(state => { state.trustedFolders.push('/owner'); },'settle');
  assert.equal(await readFile(join(f.stateDir,'trigger-engine.json'),'utf8'),'{bad','SQL writes never read or overwrite stale JSON');
  const parent = join(f.stateDir,'exports'); await mkdir(parent,{ mode: 0o700 });
  const exported = await exportTriggers(owner,parent,'lossless');
  const original = (await owner.exportCurrent()).documents;
  assert.equal(await readFile(join(exported.directory,'trigger-engine.json'),'utf8'),serializeState(original));
  const changed = structuredClone(original); changed.trustedFolders.push('/other');
  await owner.update(changesOf(rowsOf(original),rowsOf(changed)),'grow','second-change');
  await restoreTriggers(owner,exported.directory,'restore');
  await restoreTriggers(owner,exported.directory,'restore');
  assert.deepEqual((await owner.exportCurrent()).documents,original);
  assert.equal(documentsHash((await owner.exportCurrent()).documents),documentsHash(original));
  const foreign = await fixture(t); await foreign.repository.importPrepared(original,'b'.repeat(64),'foreign-import');
  await assert.rejects(restoreTriggers(foreign.repository,exported.directory,'foreign-restore'),/another authority/);
  assert.equal((await foreign.client.receipt('foreign-restore-begin')).found,false);
});

function atBytes(bytes: number): EngineState {
  const state = empty(); state.trustedFolders = [''];
  state.trustedFolders[0] = 'x'.repeat(bytes - Buffer.byteLength(serializeState(state)));
  assert.equal(Buffer.byteLength(serializeState(state)),bytes); return state;
}
test('actual SDK logical JSON budget accepts exact cap, refuses growth, permits decrease and settle, accounting escaped keys and Unicode', async t => {
  const f = await fixture(t); let state = atBytes(ACCEPT_TRIGGER_BYTES);
  await f.repository.importPrepared(state,'b'.repeat(64),'budget-seed');
  const save = async (next: EngineState,kind: 'grow' | 'settle',id: string) => { await f.repository.update(changesOf(rowsOf(state),rowsOf(next)),kind,id); state = next; };
  // SQL itself accepts cap-exact grow and rejects cap+1; this is not merely a Store preflight check.
  await save(atBytes(ACCEPT_TRIGGER_BYTES - 1),'grow','below'); await save(atBytes(ACCEPT_TRIGGER_BYTES),'grow','exact');
  await assert.rejects(save(atBytes(ACCEPT_TRIGGER_BYTES + 1),'grow','over'),/logical history is full/);
  assert.equal((await f.client.receipt('over-commit')).found,false);
  assert.equal(logicalBytes(rowsOf((await f.repository.exportCurrent()).documents)),ACCEPT_TRIGGER_BYTES);
  await save(atBytes(MAX_TRIGGER_BYTES),'settle','settle-exact');
  await assert.rejects(save(atBytes(MAX_TRIGGER_BYTES + 1),'settle','settle-over'),/logical history is full/);
  await save(atBytes(MAX_TRIGGER_BYTES - 1),'grow','decrease-above-accept');
  await save(atBytes(ACCEPT_TRIGGER_BYTES),'grow','decrease-to-accept');
  const multibyte = documents(); assert.equal(logicalBytes(rowsOf(multibyte)),Buffer.byteLength(serializeState(multibyte)));
});

test('actual SDK unknown writes retain identity, forbid new ID replay and resolve fixed receipt across reopen', async t => {
  for (const fault of ['before','after']) {
    const f = await fixture(t), state = empty(); await f.repository.importPrepared(state,'b'.repeat(64),'unknown-seed'); await f.client.close();
    const client = await f.open(f.b,fault), owner = new TriggersRepository(client), next = structuredClone(state); next.trustedFolders = ['/new'];
    const changes = changesOf(rowsOf(state),rowsOf(next));
    await assert.rejects(owner.update(changes,'grow','fixed-identity'),error => (error as { disposition?: string }).disposition === 'unknown');
    assert.equal(owner.pending()?.id,'fixed-identity');
    await assert.rejects(owner.update(changes,'grow','new-id')); await client.reopen(); await client.prepare({ allowMigration: false });
    assert.equal((await client.receipt('new-id-begin')).found,false);
    assert.equal(await owner.resolvePending(),fault === 'after' ? 'committed' : 'not-committed');
    assert.deepEqual((await owner.exportCurrent()).documents.trustedFolders,fault === 'after' ? ['/new'] : []);
  }
});

test('A fallback holds seals, stages and unknown authority; malformed JSON never becomes an empty owner', async t => {
  const f = await fixture(t); await f.client.close(); const client = await f.open(f.a), owner = new TriggersRepository(client);
  assert.equal(await bootstrapTriggers(owner,f.stateDir),false); assert.equal((await owner.head()).authority,null);
  const statePath = join(f.stateDir,'trigger-engine.json'); await writeFile(statePath,'{broken once',{ mode: 0o600 });
  const store = new TriggerStore({ stateDir: f.stateDir,storage: client,now,limits: () => undefined,changed: () => {} });
  let recovered = 0; await assert.rejects(store.load(() => { recovered++; }),/preserved/); assert.equal(recovered,0);
  await assert.rejects(store.commit(() => undefined)); assert.equal(await readFile(statePath,'utf8'),'{broken once');
  const seals = join(f.stateDir,'triggers-storage-migrations'); await mkdir(seals,{ mode: 0o700 }); await writeFile(join(seals,'prior-seal'),'proof',{ mode: 0o600 });
  await assert.rejects(bootstrapTriggers(owner,f.stateDir),/seal exists/); await rm(join(seals,'prior-seal'));
  await client.write('triggers','begin',{ intent: 'stage',bytes: 1,sha256: 'a'.repeat(64),chunks: 1 },'stage-begin');
  await assert.rejects(bootstrapTriggers(owner,f.stateDir),/stages exist/);
  await client.close();
  const db = new DatabaseSync(join(f.stateDir,'state.sqlite')); db.prepare("INSERT INTO domain_imports VALUES ('triggers','database',1,?,99,1,?,?,?,1)").run('a'.repeat(64),'2026-10-10T00:00:00Z','1.125.0','a'.repeat(64)); db.close();
  const reopened = await f.open(f.a); await assert.rejects(new TriggersRepository(reopened).head(),/Unknown triggers authority/);
});

test('123 SQL authority -> whole A124 preparation -> B125 prerequisite uses real SDK evidence without changing the guard', async t => {
  const stateDir = await folder(t), previous = await retentionBuild('1.123.0',await folder(t)), a = await retentionBuild('1.124.0',await folder(t)), b = await retentionBuild('1.125.0',await folder(t));
  const pc = await previous.storage.openStorage({ stateDir,bundle: previous.bundle() }); await pc.prepare({ allowMigration: true });
  const runs = { runs: [],created: [],instructions: {} }, retention = { journal: { version: 1 as const,migratedAt: 1234,entries: [],policies: [] },observations: { version: 1 as const,entries: [] } };
  await new RunsRepository(pc).importPrepared(runs,'a'.repeat(64),'runs-123'); await new RetentionRepository(pc).importPrepared(retention,'a'.repeat(64),'retention-121');
  const previousAuthority = (await pc.inspect()).authority; await pc.close();
  // Use the fixture's trusted build context, not a forged preparation manifest.
  const previousContext = previous.storage.storageBuildContext(previous.bundle()); assert.ok(previousContext.ok);
  const previousArtifact = { state: 'contract' as const,contract: artifactStorageContract(previousContext,await previous.storage.preflightStorage({ stateDir,bundle: previous.bundle() })) };
  assert.equal(preparationCheck(b.manifest,previousArtifact).state,'prerequisite-required');
  assert.equal(preparationCheck(b.manifest,previousArtifact).prepare,'1.124.0');
  assert.equal(preparationCheck(a.manifest,previousArtifact).state,'not-required');
  const ac = await a.storage.openStorage({ stateDir,bundle: a.bundle() }); t.after(() => ac.close());
  const preflight = await a.storage.preflightStorage({ stateDir,bundle: a.bundle() });
  const update = { stateDir,managed: false,build: { version: a.version,manifest: a.manifest,preflight } };
  assert.equal((await evaluateStorageUpdate(update)).code,'no-cutover');
  const prepared = await ac.prepare({ allowMigration: true });
  assert.deepEqual(prepared.applied.map(row => row.scope),['triggers']);
  await recordPreparationEvidence(stateDir,{ context: ac.context!,preflight,prepared,gate: await ac.gate('core') });
  assert.deepEqual((await ac.inspect()).authority,previousAuthority);
  const rr = new RunsRepository(ac); await bootstrapRuns(rr,stateDir,async () => update)();
  const rb = retentionBootstrap(ac,stateDir,async () => update,false); await rb();
  assert.deepEqual((await rr.exportCurrent()).documents,runs);
  assert.deepEqual((await new RetentionRepository(ac).exportCurrent()).documents,retention);
  assert.equal(await bootstrapTriggers(new TriggersRepository(ac),stateDir),false);
  assert.equal((await ac.inspect()).authority.some(row => row.domain === 'triggers'),false);
  for (const domain of ['retention','runs','triggers']) { const evidence = await readPreparationEvidence(stateDir,domain); assert.equal(evidence.state,'present'); if (evidence.state === 'present') assert.deepEqual(evidence.evidence.manifest,a.manifest); }
  const context = ac.context!;
  assert.equal(preparationCheck(b.manifest,{ state: 'contract',contract: artifactStorageContract(context,preflight) }).state,'satisfied');
  await ac.close();
  const bc = await b.storage.openStorage({ stateDir,bundle: b.bundle() }); t.after(() => bc.close()); await bc.prepare({ allowMigration: false });
  assert.equal((await evaluateStorageUpdate({ stateDir,managed: false,build: { version: b.version,manifest: b.manifest,preflight: await b.storage.preflightStorage({ stateDir,bundle: b.bundle() }) } })).code,'direct-evidence');
});

test('SQL authority settings backup uses the worker owner DTO when trigger JSON is absent; no second DB reader', async t => {
  const f = await fixture(t), state = empty(); state.settings.maxConcurrentRuns = 3;
  await f.repository.importPrepared(state,'b'.repeat(64),'backup-seed');
  const service = new TriggerService({ stateDir: f.stateDir,storage: f.client,now,tickMs: 3_600_000,executor: { runs: () => [],session: () => undefined,getAutoPrompt: () => undefined } as never });
  t.after(() => service.close()); await service.start();
  await assert.rejects(readFile(join(f.stateDir,'trigger-engine.json')),{ code: 'ENOENT' });
  assert.deepEqual(await collectTriggers(() => service.backup()),triggerBackupOf(JSON.parse(serializeState(state))));
  await service.updateSettings({ ...state.settings,maxConcurrentRuns: 4 },{ kind: 'owner',via: 'ui' });
  assert.equal(((await collectTriggers(() => service.backup()))!.settings as { maxConcurrentRuns: number }).maxConcurrentRuns,4);
  for (const stale of [false,true]) {
    if (stale) await writeFile(join(f.stateDir,'trigger-engine.json'),'stale JSON',{ mode: 0o600 });
    const dto = await service.backup();
    const before = await keepBefore(f.stateDir,[],new Date(now() + Number(stale)),dto);
    assert.deepEqual(JSON.parse(await readFile(join(before,'trigger-backup.json'),'utf8')),dto);
    await assert.rejects(readFile(join(before,'trigger-engine.json')),{ code: 'ENOENT' });
  }
});

test('typed trigger commands respect common SDK owner fences and leave state and receipts unchanged on failure', async t => {
  const f = await fixture(t), state = empty(); await f.repository.importPrepared(state,'b'.repeat(64),'owner-seed');
  const other = await f.open(), owner = new TriggersRepository(other), next = structuredClone(state); next.trustedFolders = ['/other'];
  await assert.rejects(f.repository.update(changesOf(rowsOf(state),rowsOf(next)),'grow','stale-owner'),/owner|claimed|held/i);
  assert.equal((await other.receipt('stale-owner-commit')).found,false);
  assert.deepEqual((await owner.exportCurrent()).documents,state);
  const row = rowsOf(state)[0];
  await assert.rejects(owner.update([{ ...row,json: '{}',previous: 'wrong' }],'grow','wrong-prior'),/changed before/);
  assert.equal((await other.receipt('wrong-prior-commit')).found,false);
  assert.deepEqual((await owner.exportCurrent()).documents,state);
});

test('first-import SQL startup restore disables/deletes recovered queued coordinator before receipt completes: new coordinator/workflow zero', async t => {
  for (const remove of [false,true]) {
    const f = await fixture(t), state = empty(), trigger = definition();
    trigger.enabled = true; trigger.source = TriggerSourceSchema.parse({ kind: 'github',schedule: { type: 'interval',everySeconds: 300 },auth: { type: 'gh' },account: 'fixture',watch: { type: 'issues',repos: ['octo/app'],assignee: 'any',start: 'existing' } });
    state.triggers = [trigger]; state.cursors[id] = { anchorAt: now(),nextAt: now() + 300_000 };
    const event = documents().events[0]; event.input.handler = 'coordinator'; event.status = 'claimed'; event.triggerRevision = trigger.revision; state.events = [event];
    const source = Buffer.from(serializeState(state));
    await writeFile(join(f.stateDir,'trigger-engine.json'),source,{ mode: 0o600 });
    let coordinators = 0, workflows = 0;
    const executor = { runs: () => [],session: () => undefined,getAutoPrompt: () => undefined,coordinate: async () => { coordinators++; workflows++; return { workflowId: 'forbidden' }; } } as unknown as TriggerExecutor;
    const service = new TriggerService({ stateDir: f.stateDir,storage: f.client,now,tickMs: 3_600_000,executor }); t.after(() => service.close());
    const backup = { triggers: remove ? [] : [{ ...trigger,enabled: false }],settings: state.settings,trustedFolders: [],secretGrants: {},fired: {},github: {} };
    await service.bootstrapStorage(async () => ({ stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle() }) } }));
    const restored = await service.start({ restore: backup }); assert.deepEqual(restored.errors,[]);
    assert.deepEqual(await readFile(join(f.stateDir,'trigger-engine.json')),source);
    await service.tick(); assert.equal(service.event(event.id).status,'cancelled');
    assert.equal(coordinators,0); assert.equal(workflows,0);
    const current = (await f.repository.exportCurrent()).documents; assert.equal(current.events[0].status,'cancelled');
    const db = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
    assert.ok(Number((db.prepare("SELECT count(*) AS n FROM operation_receipts WHERE scope = 'triggers' AND command = 'commit'").get() as { n: number }).n) >= 2,'restore has a real atomic command receipt before markStarted'); db.close();
    service.close(); await service.settle();
    const reopened = new TriggerService({ stateDir: f.stateDir,storage: f.client,now,tickMs: 3_600_000,executor }); t.after(() => reopened.close());
    await reopened.start(); await reopened.tick(); assert.equal(reopened.event(event.id).status,'cancelled'); assert.equal(coordinators,0); assert.equal(workflows,0);
  }
});

test('lost SQL startup restore response holds engine admission until the fixed receipt is resolved, with no coordinator replay', async t => {
  const f = await fixture(t), state = empty(), trigger = definition(); trigger.enabled = true;
  state.triggers = [trigger]; state.cursors[id] = { anchorAt: now(),nextAt: now() + 300_000 };
  const event = documents().events[0]; event.input.handler = 'coordinator'; event.status = 'claimed'; state.events = [event];
  await f.repository.importPrepared(state,'b'.repeat(64),'lost-restore-seed'); await f.client.close();
  const client = await f.open(f.b,'after'); let calls = 0;
  const executor = { runs: () => [],session: () => undefined,getAutoPrompt: () => undefined,coordinate: async () => { calls++; return { workflowId: 'forbidden' }; } } as unknown as TriggerExecutor;
  const service = new TriggerService({ stateDir: f.stateDir,storage: client,now,tickMs: 3_600_000,executor }); t.after(() => service.close());
  await assert.rejects(service.start({ restore: { triggers: [],settings: state.settings,trustedFolders: [],secretGrants: {},fired: {},github: {} } }));
  await service.tick(); assert.equal(calls,0);
  await assert.rejects(service.backup(),/not ready|Cannot save|held/);
  await client.reopen(); await client.prepare({ allowMigration: false });
  const db = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
  const receipts = db.prepare("SELECT command_id FROM operation_receipts WHERE scope = 'triggers' AND command = 'commit'").all() as { command_id: string }[];
  assert.equal(receipts.length,2,'one seed and exactly one committed restore, with no new-ID replay'); db.close();
  assert.equal((await new TriggersRepository(client).exportCurrent()).documents.events[0].status,'cancelled');
  await service.tick(); assert.equal(calls,0,'reopening the SDK alone never resumes an uncertain owner');
});

test('prepared raw importer seals exact original before receipt and does not prune or reconcile a past once reservation', async t => {
  const f = await fixture(t), state = empty(), trigger = definition(); trigger.enabled = true; trigger.source.schedule = { type: 'once',at: '2026-10-01T00:00:00.000Z' };
  state.triggers = [trigger]; state.cursors[id] = { anchorAt: 1 }; state.recentFires = [{ at: 1,triggerId: id }]; state.onceConsumed.deleted = { at: '2020-01-01T00:00:00Z' };
  const source = Buffer.from(serializeState(state) + '\n'), path = join(f.stateDir,'trigger-engine.json'); await writeFile(path,source,{ mode: 0o600 });
  const parent = join(f.stateDir,'triggers-storage-migrations'); await mkdir(parent,{ mode: 0o700 });
  const update = { stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle() }) } };
  const sealed = await importTriggers({ repository: f.repository,stateDir: f.stateDir,evidenceParent: parent,commandId: 'raw-import',update,now });
  assert.deepEqual(await readFile(join(sealed.directory,'trigger-engine.json')),source);
  assert.deepEqual(await readFile(path),source); assert.equal((await f.client.receipt('raw-import-commit')).found,true);
  const current = (await f.repository.exportCurrent()).documents;
  assert.equal(current.triggers[0].enabled,true,'import is format decoding, not startup normalization');
  assert.deepEqual(current.recentFires,[{ at: 1,triggerId: id }],'import never prunes'); assert.deepEqual(current.onceConsumed,state.onceConsumed);
  await assert.rejects(importTriggers({ repository: f.repository,stateDir: f.stateDir,evidenceParent: parent,commandId: 'reimport',update,now }),/authority exists/);
});

test('SQL restore rejects lost once, fired, dispatch and cancellation evidence atomically', async t => {
  for (const evidence of ['onceConsumed','fired','dispatch','cancelled'] as const) {
    const f = await fixture(t), original = empty();
    original.triggers = [definition()]; original.events = [documents().events[0]];
    await f.repository.importPrepared(original,'b'.repeat(64),`boundary-seed-${evidence}`);
    const exported = await exportTriggers(f.repository,f.stateDir,`boundary-export-${evidence}`);
    const consumed = structuredClone(original);
    if (evidence === 'onceConsumed') consumed.onceConsumed[id] = { at: new Date(now()).toISOString() };
    if (evidence === 'fired') consumed.fired['manual once'] = new Date(now()).toISOString();
    if (evidence === 'dispatch') { consumed.events[0].status = 'running'; consumed.events[0].dispatch = { workflowId: 'existing-workflow' }; }
    if (evidence === 'cancelled') consumed.events[0].status = 'cancelled';
    await f.repository.update(changesOf(rowsOf(original),rowsOf(consumed)),'settle',`boundary-consume-${evidence}`);
    const before = await f.repository.exportCurrent();
    await assert.rejects(restoreTriggers(f.repository,exported.directory,`boundary-restore-${evidence}`),/execution evidence|dispatch or cancellation evidence/);
    assert.deepEqual(await f.repository.exportCurrent(),before);
    assert.equal((await f.client.receipt(`boundary-restore-${evidence}-commit`)).found,false);
    await f.client.close();
    const reopened = new TriggersRepository(await f.open());
    assert.deepEqual((await reopened.exportCurrent()).documents,consumed);
  }
});

test('not-committed SQL busy pending restore holds coordinator recovery until retry cancels it', async t => {
  for (const remove of [false,true]) {
    const f = await fixture(t), state = empty(), trigger = definition(); trigger.enabled = true;
    state.triggers = [trigger]; state.cursors[id] = { anchorAt: now(),nextAt: now() + 300_000 };
    const event = documents().events[0]; event.status = 'claimed'; event.input.handler = 'coordinator'; state.events = [event];
    await f.repository.importPrepared(state,'b'.repeat(64),`busy-seed-${remove}`);
    const backup = { triggers: remove ? [] : [{ ...trigger,enabled: false }],settings: state.settings,trustedFolders: [],secretGrants: {},fired: {},github: {} };
    const pending = join(f.stateDir,'restore','applying-worker.json');
    await writePendingWorker(f.stateDir,{ id: '11111111-1111-4111-8111-111111111111',files: {},triggers: backup });
    const taken = await takeWorkerRestore(f.stateDir); assert.ok(taken); assert.ok(taken.restore.triggers);
    const bytes = await readFile(pending);
    let coordinators = 0, workflows = 0;
    const executor = { runs: () => [],session: () => undefined,getAutoPrompt: () => undefined,coordinate: async () => { coordinators++; workflows++; return { workflowId: 'forbidden' }; } } as unknown as TriggerExecutor;
    const service = new TriggerService({ stateDir: f.stateDir,storage: f.client,now,tickMs: 3_600_000,executor }); t.after(() => service.close());
    const lock = new DatabaseSync(join(f.stateDir,'state.sqlite')); lock.exec('BEGIN IMMEDIATE');
    try { await assert.rejects(service.start({ restore: backup }),/Cannot save triggers/); }
    finally { lock.exec('ROLLBACK'); lock.close(); }
    await service.tick(); assert.equal(coordinators,0); assert.equal(workflows,0);
    assert.deepEqual(await readFile(pending),bytes); assert.deepEqual((await f.repository.exportCurrent()).documents,state);
    await service.start({ restore: backup }); await service.tick();
    assert.equal(service.event(event.id).status,'cancelled'); assert.equal(coordinators,0); assert.equal(workflows,0);
    assert.equal((await f.repository.exportCurrent()).documents.events[0].status,'cancelled');
    const db = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
    try { assert.equal(Number((db.prepare("SELECT count(*) AS n FROM operation_receipts WHERE scope = 'triggers' AND command = 'commit'").get() as { n: number }).n) >= 2,true); }
    finally { db.close(); }
    await taken.applied({ parts: ['triggers'],errors: [] });
    assert.equal(JSON.parse(await readFile(pending,'utf8')).triggers,undefined);
    await taken.finish({ parts: [],errors: [] }); await assert.rejects(readFile(pending),{ code: 'ENOENT' });
  }
});

test('raw import keeps MAX_AUDIT and larger audit bytes and ordering during old once decoding', async t => {
  for (const count of [MAX_AUDIT,MAX_AUDIT + 1]) {
    const f = await fixture(t), state = empty(), trigger = definition(); state.triggers = [trigger];
    state.audit = Array.from({ length: count },(_,n) => ({ id: `audit-${n}`,at: '2026-10-01T00:00:00Z',actor: { kind: 'owner' as const,via: 'ui' as const },action: 'create' as const,triggerId: id,triggerName: '한 번',summary: `원본 ${n}\\"` }));
    const raw = JSON.parse(serializeState(state)); raw.triggers[0].revision++;
    const source = Buffer.from(JSON.stringify(raw) + '\n'), path = join(f.stateDir,'trigger-engine.json'); await writeFile(path,source,{ mode: 0o600 });
    const update = { stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle() }) } };
    const sealed = await importTriggers({ repository: f.repository,stateDir: f.stateDir,evidenceParent: f.stateDir,commandId: `audit-import-${count}`,update,now: () => { throw new Error('raw importer must not read the execution clock'); } });
    assert.deepEqual(await readFile(path),source); assert.deepEqual(await readFile(join(sealed.directory,'trigger-engine.json')),source);
    const manifest = JSON.parse(await readFile(join(sealed.directory,'manifest.json'),'utf8'));
    assert.equal(manifest.files['trigger-engine.json'].sha256,triggerHash(source)); assert.equal(manifest.files['trigger-engine.json'].bytes,source.length);
    const imported = await f.repository.exportCurrent(); assert.equal(imported.sha256,documentsHash(imported.documents)); assert.deepEqual(imported.documents.audit,state.audit);
    assert.equal(JSON.stringify(imported.documents.audit),JSON.stringify(raw.audit)); assert.equal(imported.documents.triggers[0].enabled,false);
    const db = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
    try { assert.deepEqual(db.prepare("SELECT json FROM triggers_rows WHERE kind = 'audit' ORDER BY ordinal").all().map(row => JSON.parse(String(row.json))),raw.audit); }
    finally { db.close(); }
  }
});


test('old export cannot replay a manually consumed once after SQL reopen', async t => {
  const f = await fixture(t), state = empty(), trigger = definition(); trigger.enabled = true; state.triggers = [trigger];
  state.cursors[id] = { anchorAt: now(),nextAt: Date.parse('2026-12-01T00:00:00Z') };
  await f.repository.importPrepared(state,'b'.repeat(64),'manual-boundary-seed');
  const exported = await exportTriggers(f.repository,f.stateDir,'manual-boundary-export');
  let dispatches = 0;
  const executor = { runs: () => [],session: () => undefined,getAutoPrompt: () => undefined,create: async () => { dispatches++; throw new Error('fixture submitted once'); } } as unknown as TriggerExecutor;
  const service = new TriggerService({ stateDir: f.stateDir,storage: f.client,now,tickMs: 3_600_000,executor }); t.after(() => service.close());
  await service.start(); await service.run(id,{ kind: 'owner',via: 'ui' }); await service.tick();
  const before = await f.repository.exportCurrent(), submitted = dispatches;
  assert.ok(before.documents.onceConsumed[id]);
  await assert.rejects(restoreTriggers(f.repository,exported.directory,'manual-boundary-restore'),/execution evidence|dispatch or cancellation evidence/);
  assert.deepEqual(await f.repository.exportCurrent(),before); assert.equal((await f.client.receipt('manual-boundary-restore-commit')).found,false);
  service.close(); await service.settle(); await f.client.close();
  const client = await f.open(), reopened = new TriggerService({ stateDir: f.stateDir,storage: client,now,tickMs: 3_600_000,executor }); t.after(() => reopened.close());
  await reopened.start(); await assert.rejects(reopened.run(id,{ kind: 'owner',via: 'ui' }),/consumed|archiv/); await reopened.tick();
  assert.equal(dispatches,submitted,'restore/reopen/manual run submits zero additional work');
});

test('SQL restore refuses absent unfinished events after pruning and 30-day evidence expiry, without a commit or new dispatch on reopen', async t => {
  for (const status of ['queued', 'claimed', 'running'] as const) {
    const f = await fixture(t), original = empty();
    const oldAt = '2026-08-01T00:00:00.000Z';
    const event = { ...documents().events[0], id: `pruned-${status}`, status, occurredAt: oldAt, receivedAt: oldAt, updatedAt: oldAt };
    // A repeating definition has no once-consumption evidence that could mask the absence guard.
    original.triggers = [{ ...definition(), source: { kind: 'schedule', schedule: { type: 'interval', everySeconds: 3600 }, catchUp: 'latest' } }];
    original.events = [event, ...Array.from({ length: 500 }, (_, i) => ({ ...event, id: `finished-${i}`, requestId: `finished-request-${i}`, status: 'completed' as const }))];
    original.fired = { [event.dedupKey]: oldAt };
    original.recentFires = [{ triggerId: id, at: Date.parse(oldAt) }];
    await f.repository.importPrepared(original, 'b'.repeat(64), `pruned-seed-${status}`);
    const exported = await exportTriggers(f.repository, f.stateDir, `pruned-export-${status}`);
    const completed = structuredClone(original); completed.events[0].status = 'completed';
    pruneState(completed, now);
    assert.equal(completed.events.length, 500);
    assert.equal(completed.events.some(row => row.id === event.id), false);
    assert.deepEqual(completed.fired, {}); assert.deepEqual(completed.recentFires, []);
    await f.repository.update(changesOf(rowsOf(original), rowsOf(completed)), 'settle', `pruned-complete-${status}`);
    const before = await f.repository.exportCurrent();
    const committedReceipts = () => {
      const db = new DatabaseSync(join(f.stateDir, 'state.sqlite'), { readOnly: true });
      try { return db.prepare("SELECT * FROM operation_receipts WHERE scope = 'triggers' AND command = 'commit' ORDER BY command_id").all(); }
      finally { db.close(); }
    };
    const receipts = committedReceipts();
    await assert.rejects(restoreTriggers(f.repository, exported.directory, `pruned-restore-${status}`), /absent unfinished trigger event/);
    assert.deepEqual(await f.repository.exportCurrent(), before, 'rows, authority and revision remain unchanged');
    assert.deepEqual(committedReceipts(), receipts);
    assert.equal((await f.client.receipt(`pruned-restore-${status}-commit`)).found, false);
    await f.client.close();
    const client = await f.open();
    assert.deepEqual(await new TriggersRepository(client).exportCurrent(), before);
    let dispatches = 0;
    const forbidden = async () => { dispatches++; throw new Error('pruned event was dispatched'); };
    const executor = { runs: () => [], session: () => undefined, getAutoPrompt: () => undefined,
      create: forbidden, enqueue: forbidden, submitAutoPrompt: forbidden, coordinate: forbidden } as unknown as TriggerExecutor;
    const service = new TriggerService({ stateDir: f.stateDir, storage: client, now, tickMs: 3_600_000, executor });
    t.after(() => service.close());
    await service.start(); await service.tick(); await service.settle();
    assert.equal(dispatches, 0, 'pruned work creates no dispatch or coordinator after reopen');
  }
});

test('B owner bootstrap seals first import before load/recovery and keeps independent once consumption and raw source', async t => {
  const f = await fixture(t), state = documents();
  state.triggers[0].enabled = true;
  const source = Buffer.from(serializeState(state) + '\n'), path = join(f.stateDir,'trigger-engine.json');
  await writeFile(path,source,{ mode: 0o600 });
  const store = new TriggerStore({ stateDir: f.stateDir,storage: f.client,now,limits: () => undefined,changed: () => {} });
  const update = async () => ({ stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle() }) } });
  const first = store.bootstrapStorage(update);
  assert.equal(store.bootstrapStorage(update),first,'concurrent continuation callers share one first import');
  await first;
  const imported = await f.repository.exportCurrent();
  assert.equal(imported.head.revision,1); assert.equal(imported.documents.triggers[0].enabled,true,'import does not execute once normalization');
  assert.deepEqual(imported.documents.onceConsumed,state.onceConsumed);
  const db = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
  try { assert.equal((db.prepare("SELECT count(*) AS n FROM operation_receipts WHERE scope = 'triggers' AND command = 'commit'").get() as { n: number }).n,1); }
  finally { db.close(); }
  await store.load(loaded => { assert.equal(loaded.triggers[0].enabled,false,'only load reconciles consumed definitions'); });
  await store.commit(() => undefined,'settle');
  assert.deepEqual(store.state.onceConsumed,state.onceConsumed); assert.deepEqual(await readFile(path),source);
  await store.bootstrapStorage(async () => { throw new Error('SQL authority must precede update/source access'); });
});

test('B missing bootstrap evidence or missing source amid legacy history holds load, never saving an empty JSON owner', async t => {
  const f = await fixture(t), path = join(f.stateDir,'trigger-engine.json');
  const store = new TriggerStore({ stateDir: f.stateDir,storage: f.client,now,limits: () => undefined,changed: () => {} });
  let recovered = 0;
  await assert.rejects(store.load(() => { recovered++; }),/bootstrap evidence/);
  await assert.rejects(store.commit(() => undefined,'settle'),/bootstrap evidence/);
  assert.equal(recovered,0); assert.equal((await f.repository.head()).authority,null);
  await assert.rejects(readFile(path),{ code: 'ENOENT' });
  await mkdir(join(f.stateDir,'triggers-storage-migrations'),{ mode: 0o700 });
  const update = async () => ({ stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle() }) } });
  await assert.rejects(store.bootstrapStorage(update),/ENOENT/);
  assert.equal((await f.repository.head()).authority,null);
});

test('B source mutation after seal refuses commit, preserves both byte versions and holds subsequent bootstrap', async t => {
  const f = await fixture(t), path = join(f.stateDir,'trigger-engine.json'), original = Buffer.from(serializeState(documents()));
  await writeFile(path,original,{ mode: 0o600 });
  const replacement = Buffer.from(serializeState(empty()));
  const prepare = f.repository.importPrepared.bind(f.repository);
  f.repository.importPrepared = async (state,hash,id,verify) => prepare(state,hash,id,async () => { await writeFile(path,replacement); await verify?.(); });
  const update = { stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle() }) } };
  const parent = join(f.stateDir,'triggers-storage-migrations'); await mkdir(parent,{ mode: 0o700 });
  await assert.rejects(importTriggers({ repository: f.repository,stateDir: f.stateDir,evidenceParent: parent,commandId: 'source-race',update,now }),/changed after sealing/);
  assert.deepEqual(await readFile(join(parent,'source-race','trigger-engine.json')),original);
  assert.deepEqual(await readFile(path),replacement);
  assert.equal((await f.client.receipt('source-race-commit')).found,false); assert.equal((await f.repository.head()).authority,null);
  await assert.rejects(bootstrapTriggers(f.repository,f.stateDir,{ update: async () => update,now }),/seal exists/);
});

test('B first-import crash before/after commit holds the same owner until receipt resolution, without native replay', async t => {
  for (const fault of ['before','after']) {
    const f = await fixture(t), state = documents(), path = join(f.stateDir,'trigger-engine.json'), source = Buffer.from(serializeState(state));
    await writeFile(path,source,{ mode: 0o600 }); await f.client.close();
    const client = await f.open(f.b,fault);
    let effects = 0;
    const forbidden = async () => { effects++; throw new Error('unexpected dispatch'); };
    const service = new TriggerService({ stateDir: f.stateDir,storage: client,now,tickMs: 3_600_000,
      executor: { runs: () => [],session: () => undefined,getAutoPrompt: () => undefined,create: forbidden,coordinate: forbidden,enqueue: forbidden } as unknown as TriggerExecutor });
    t.after(() => service.close());
    const update = async () => ({ stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle(fault) }) } });
    await assert.rejects(service.bootstrapStorage(update),error => (error as { disposition?: string }).disposition === 'unknown');
    await assert.rejects(service.start()); await service.tick(); assert.equal(effects,0);
    await client.reopen(); await client.prepare({ allowMigration: false });
    await assert.rejects(service.bootstrapStorage(update),'SDK reopen alone cannot release uncertain owner');
    assert.equal(await service.resolveStorage(),fault === 'after' ? 'committed' : 'not-committed');
    if (fault === 'after') {
      await service.bootstrapStorage(async () => { throw new Error('committed authority must not evaluate JSON'); });
      assert.deepEqual((await new TriggersRepository(client).exportCurrent()).documents.onceConsumed,state.onceConsumed);
    } else await assert.rejects(service.bootstrapStorage(update),/seal exists/);
    await service.tick(); assert.equal(effects,0); assert.deepEqual(await readFile(path),source);
    const db = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
    try { assert.equal((db.prepare("SELECT count(*) AS n FROM operation_receipts WHERE scope = 'triggers' AND command = 'commit'").get() as { n: number }).n,fault === 'after' ? 1 : 0,'no new-ID import replay'); }
    finally { db.close(); }
  }
});

test('B bootstrap refuses unknown source version and unsafe source permissions without modifying source or granting authority', async t => {
  for (const unsafe of [false,true]) {
    const f = await fixture(t), path = join(f.stateDir,'trigger-engine.json');
    const bytes = Buffer.from(unsafe ? serializeState(documents()) : JSON.stringify({ ...empty(),version: 2 }));
    await writeFile(path,bytes,{ mode: unsafe ? 0o644 : 0o600 });
    const update = async () => ({ stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle() }) } });
    await assert.rejects(bootstrapTriggers(f.repository,f.stateDir,{ update,now }),unsafe ? /Unsafe trigger source/ : /Invalid trigger source/);
    assert.deepEqual(await readFile(path),bytes); assert.equal((await f.repository.head()).authority,null);
    const db = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
    try { assert.equal((db.prepare("SELECT count(*) AS n FROM operation_receipts WHERE scope = 'triggers'").get() as { n: number }).n,0); }
    finally { db.close(); }
  }
});

test('B genuinely absent trigger domain initializes once with sealed evidence, no legacy JSON authority', async t => {
  const f = await fixture(t);
  const update = async () => ({ stateDir: f.stateDir,managed: false,build: { version: f.b.version,manifest: f.b.manifest,preflight: await f.b.storage.preflightStorage({ stateDir: f.stateDir,bundle: f.b.bundle() }) } });
  assert.equal(await bootstrapTriggers(f.repository,f.stateDir,{ update,now }),true);
  const first = await f.repository.exportCurrent(); assert.deepEqual(first.documents,empty()); assert.equal(first.head.revision,1);
  assert.equal(await bootstrapTriggers(f.repository,f.stateDir,{ update: async () => { throw new Error('authority early return'); },now }),true);
  assert.deepEqual(await f.repository.exportCurrent(),first);
  await assert.rejects(readFile(join(f.stateDir,'trigger-engine.json')),{ code: 'ENOENT' });
});
