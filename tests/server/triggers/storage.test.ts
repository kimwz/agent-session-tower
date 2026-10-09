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
import { triggerBackupOf } from '../../../server/triggers/backup.js';
import type { Trigger, TriggerEvent } from '../../../shared/triggers.js';

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

test('SQL startup restore disables/deletes recovered queued coordinator before receipt completes: new coordinator/workflow zero', async t => {
  for (const remove of [false,true]) {
    const f = await fixture(t), state = empty(), trigger = definition();
    trigger.enabled = true; trigger.source = { kind: 'github',schedule: { type: 'interval',everySeconds: 300 },auth: { type: 'gh' },account: 'fixture',watch: { type: 'issues',repos: ['octo/app'],assignee: 'fixture',start: 'existing' } };
    state.triggers = [trigger]; state.cursors[id] = { anchorAt: now(),nextAt: now() + 300_000 };
    const event = documents().events[0]; event.input.handler = 'coordinator'; event.status = 'claimed'; event.triggerRevision = trigger.revision; state.events = [event];
    await f.repository.importPrepared(state,'b'.repeat(64),`restore-seed-${remove}`);
    let coordinators = 0, workflows = 0;
    const executor = { runs: () => [],session: () => undefined,getAutoPrompt: () => undefined,coordinate: async () => { coordinators++; workflows++; return { workflowId: 'forbidden' }; } } as unknown as TriggerExecutor;
    const service = new TriggerService({ stateDir: f.stateDir,storage: f.client,now,tickMs: 3_600_000,executor }); t.after(() => service.close());
    const backup = { triggers: remove ? [] : [{ ...trigger,enabled: false }],settings: state.settings,trustedFolders: [],secretGrants: {},fired: {},github: {} };
    const restored = await service.start({ restore: backup }); assert.deepEqual(restored.errors,[]);
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
