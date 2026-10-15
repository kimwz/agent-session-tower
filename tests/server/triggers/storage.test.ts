import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStorage } from '../../../server/storage/client.js';
import type { StorageLimits } from '../../../server/storage/contract.js';
import { captureStorageBundle } from '../../../server/storage/bundle.js';
import { currentStorage } from '../../helpers/current-storage.js';
import { faultBuild, type FaultBuild } from '../../helpers/fault-storage.js';
import { TriggersRepository } from '../../../server/triggers/storage-repository.js';
import { RunsRepository } from '../../../server/runs/storage-repository.js';
import { canonical as runCanonical } from '../../../server/runs/storage-codec.js';
import { TriggerDefinitions } from '../../../server/triggers/definitions.js';
import { restoreFrom } from '../../../server/triggers/restore.js';
import { TriggerDispatch } from '../../../server/triggers/dispatch.js';
import { SecretStore } from '../../../server/triggers/secrets.js';
import { consumeOnce } from '../../../server/triggers/once.js';
import { TriggerStore } from '../../../server/triggers/store.js';
import { TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';
import { writeRows, empty, pruneState, serializeState, type EngineState } from '../../../server/triggers/state.js';
import { ACCEPT_TRIGGER_BYTES, MAX_TRIGGER_BYTES, changesOf, logicalBytes, rowsOf, stateOf } from '../../../server/triggers/storage-codec.js';
import { collectTriggers } from '../../../server/backup/payload.js';
import { keepBefore, takeWorkerRestore, writePendingWorker } from '../../../server/backup/restore-files.js';
import { MAX_AUDIT } from '../../../server/triggers/limits.js';
import { triggerBackupOf } from '../../../server/triggers/backup.js';
import type { Trigger } from '../../../shared/triggers.js';

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
/**
 * A current-build storage (currentStorage) without domain authorities, so each test imports the trigger state it
 * starts from. `open()` opens it again with the product build; `open(fault)` with a fault build of this test's own.
 */
async function actualStorage(t: TestContext, limits?: Partial<StorageLimits>) {
  const stateDir = await folder(t);
  let faults: Promise<FaultBuild> | undefined;
  const open = async (fault = 'normal') => {
    const build = fault === 'normal' ? undefined : await (faults ??= faultBuild(t));
    const client = build ? await build.storage.openStorage({ stateDir,bundle: build.bundle(fault) }) : await openStorage({ stateDir,bundle: await captureStorageBundle() });
    t.after(() => client.close());
    await client.prepare({ allowMigration: false }); return client;
  };
  const client = await currentStorage(stateDir,{ initialize: false,limits }); t.after(() => client.close());
  const repository = new TriggersRepository(client);
  return { stateDir,open,client,repository };
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

/** Most of the budget, in one row the budget saves below never rewrite. */
const PAD = ACCEPT_TRIGGER_BYTES - 4096;
/**
 * A state of exactly `bytes` serialized bytes: trusted folders made of the fixed padding row, an `extra` padding row
 * when given, and a short last row sized to the total. Saving one such state over another rewrites only the rows that
 * differ, so the cap is reached and crossed without writing the whole budget again for each step.
 */
function atBytes(bytes: number, extra = 0): EngineState {
  const state = empty(); state.trustedFolders = ['x'.repeat(PAD), ...(extra ? ['y'.repeat(extra)] : []), ''];
  const fill = bytes - Buffer.byteLength(serializeState(state));
  assert.ok(fill >= 0); state.trustedFolders[state.trustedFolders.length - 1] = 'z'.repeat(fill);
  assert.equal(Buffer.byteLength(serializeState(state)),bytes); return state;
}
test('actual SDK logical JSON budget accepts exact cap, refuses growth, permits decrease and settle, accounting escaped keys and Unicode', async t => {
  const f = await actualStorage(t); let state = atBytes(ACCEPT_TRIGGER_BYTES);
  await f.repository.importPrepared(state,'b'.repeat(64),'budget-seed');
  const save = async (next: EngineState,kind: 'grow' | 'settle',id: string) => { await f.repository.update(changesOf(rowsOf(state),rowsOf(next)),kind,id); state = next; };
  // SQL itself accepts cap-exact grow and rejects cap+1; this is not merely a Store preflight check.
  await save(atBytes(ACCEPT_TRIGGER_BYTES - 1),'grow','below'); await save(atBytes(ACCEPT_TRIGGER_BYTES),'grow','exact');
  await assert.rejects(save(atBytes(ACCEPT_TRIGGER_BYTES + 1),'grow','over'),/logical history is full/);
  assert.equal((await f.client.receipt('over-commit')).found,false);
  assert.equal(logicalBytes(rowsOf((await f.repository.exportCurrent()).documents)),ACCEPT_TRIGGER_BYTES);
  const extra = MAX_TRIGGER_BYTES - ACCEPT_TRIGGER_BYTES;
  await save(atBytes(MAX_TRIGGER_BYTES,extra),'settle','settle-exact');
  await assert.rejects(save(atBytes(MAX_TRIGGER_BYTES + 1,extra),'settle','settle-over'),/logical history is full/);
  await save(atBytes(MAX_TRIGGER_BYTES - 1,extra),'grow','decrease-above-accept');
  await save(atBytes(ACCEPT_TRIGGER_BYTES),'grow','decrease-to-accept');
  const multibyte = documents(); assert.equal(logicalBytes(rowsOf(multibyte)),Buffer.byteLength(serializeState(multibyte)));
});

for (const fault of ['before','after']) test(`actual SDK unknown writes (${fault} commit) retain identity, forbid new ID replay and resolve fixed receipt across reopen`, async t => {
  const f = await actualStorage(t), state = empty(); await f.repository.importPrepared(state,'b'.repeat(64),'unknown-seed'); await f.client.close();
  const client = await f.open(fault), owner = new TriggersRepository(client), next = structuredClone(state); next.trustedFolders = ['/new'];
  const changes = changesOf(rowsOf(state),rowsOf(next));
  await assert.rejects(owner.update(changes,'grow','fixed-identity'),error => (error as { disposition?: string }).disposition === 'unknown');
  assert.equal(owner.pending()?.id,'fixed-identity');
  await assert.rejects(owner.update(changes,'grow','new-id')); await client.reopen(); await client.prepare({ allowMigration: false });
  assert.equal((await client.receipt('new-id-begin')).found,false);
  assert.equal(await owner.resolvePending(),fault === 'after' ? 'committed' : 'not-committed');
  assert.deepEqual((await owner.exportCurrent()).documents.trustedFolders,fault === 'after' ? ['/new'] : []);
});

test('SQL authority settings backup uses the worker owner DTO when trigger JSON is absent; no second DB reader', async t => {
  const f = await actualStorage(t), state = empty(); state.settings.maxConcurrentRuns = 3;
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
  const f = await actualStorage(t), state = empty(); await f.repository.importPrepared(state,'b'.repeat(64),'owner-seed');
  const other = await f.open(), owner = new TriggersRepository(other), next = structuredClone(state); next.trustedFolders = ['/other'];
  await assert.rejects(f.repository.update(changesOf(rowsOf(state),rowsOf(next)),'grow','stale-owner'),/owner|claimed|held/i);
  assert.equal((await other.receipt('stale-owner-commit')).found,false);
  assert.deepEqual((await owner.exportCurrent()).documents,state);
  const row = rowsOf(state)[0];
  await assert.rejects(owner.update([{ ...row,json: '{}',previous: 'wrong' }],'grow','wrong-prior'),/changed before/);
  assert.equal((await other.receipt('wrong-prior-commit')).found,false);
  assert.deepEqual((await owner.exportCurrent()).documents,state);
});

test('lost SQL startup restore response holds engine admission until the fixed receipt is resolved, with no coordinator replay', async t => {
  const f = await actualStorage(t), state = empty(), trigger = definition(); trigger.enabled = true;
  state.triggers = [trigger]; state.cursors[id] = { anchorAt: now(),nextAt: now() + 300_000 };
  const event = documents().events[0]; event.input.handler = 'coordinator'; event.status = 'claimed'; state.events = [event];
  await f.repository.importPrepared(state,'b'.repeat(64),'lost-restore-seed'); await f.client.close();
  const client = await f.open('after'); let calls = 0;
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

test('SQL restore rejects lost once, fired, dispatch and cancellation evidence atomically', async t => {
  for (const evidence of ['onceConsumed','fired','dispatch','cancelled'] as const) {
    const f = await actualStorage(t), original = empty();
    original.triggers = [definition()]; original.events = [documents().events[0]];
    await f.repository.importPrepared(original,'b'.repeat(64),`boundary-seed-${evidence}`);
    const consumed = structuredClone(original);
    if (evidence === 'onceConsumed') consumed.onceConsumed[id] = { at: new Date(now()).toISOString() };
    if (evidence === 'fired') consumed.fired['manual once'] = new Date(now()).toISOString();
    if (evidence === 'dispatch') { consumed.events[0].status = 'running'; consumed.events[0].dispatch = { workflowId: 'existing-workflow' }; }
    if (evidence === 'cancelled') consumed.events[0].status = 'cancelled';
    await f.repository.update(changesOf(rowsOf(original),rowsOf(consumed)),'settle',`boundary-consume-${evidence}`);
    const before = await f.repository.exportCurrent();
    await assert.rejects(f.repository.restore(original,`boundary-restore-${evidence}`,before.head.authority!.generation),/execution evidence|dispatch or cancellation evidence/);
    assert.deepEqual(await f.repository.exportCurrent(),before);
    assert.equal((await f.client.receipt(`boundary-restore-${evidence}-commit`)).found,false);
    await f.client.close();
    const reopened = new TriggersRepository(await f.open());
    assert.deepEqual((await reopened.exportCurrent()).documents,consumed);
  }
});

test('not-committed SQL busy pending restore holds coordinator recovery until retry cancels it', async t => {
  for (const remove of [false,true]) {
    // A busy database refuses at once: the outside lock below is held until the refusal is seen.
    const f = await actualStorage(t,{ busyTimeoutMs: 0 }), state = empty(), trigger = definition(); trigger.enabled = true;
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

for (const status of ['queued', 'claimed', 'running'] as const) test(`SQL restore refuses an absent ${status} event after pruning and 30-day evidence expiry, without a commit or new dispatch on reopen`, async t => {
  const f = await actualStorage(t), original = empty();
  const oldAt = '2026-08-01T00:00:00.000Z';
  const event = { ...documents().events[0], id: `pruned-${status}`, status, occurredAt: oldAt, receivedAt: oldAt, updatedAt: oldAt };
  // A repeating definition has no once-consumption evidence that could mask the absence guard.
  original.triggers = [{ ...definition(), source: { kind: 'schedule', schedule: { type: 'interval', everySeconds: 3600 }, catchUp: 'latest' } }];
  original.events = [event, ...Array.from({ length: 500 }, (_, i) => ({ ...event, id: `finished-${i}`, requestId: `finished-request-${i}`, status: 'completed' as const }))];
  original.fired = { [event.dedupKey]: oldAt };
  original.recentFires = [{ triggerId: id, at: Date.parse(oldAt) }];
  await f.repository.importPrepared(original, 'b'.repeat(64), `pruned-seed-${status}`);
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
  await assert.rejects(f.repository.restore(original, `pruned-restore-${status}`, before.head.authority!.generation), /absent unfinished trigger event/);
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
});

test('actualStorage typed settings/cursor/once batches preserve unrelated rows, secrets and SQL logical budget', async t => {
  const f = await actualStorage(t), state = documents();
  state.onceConsumed = { deleted: { at: '2026-10-01T00:00:00Z' } };
  delete state.cursors[id].nextAt;
  await f.repository.importPrepared(state,'b'.repeat(64),'r6-row-seed');
  await writeFile(join(f.stateDir,'trigger-engine.json'),'{ stale JSON',{ mode: 0o600 });
  const store = new TriggerStore({ stateDir: f.stateDir,storage: f.client,now,limits: () => undefined,changed: () => {} });
  await store.load(() => {}); await store.flush();
  const baseline = await f.repository.exportCurrent(), event = store.state.events[0], tombstone = store.state.tombstones[0];
  const definitions = new TriggerDefinitions(store,new SecretStore(f.stateDir),now,() => undefined);
  await definitions.updateSettings({ ...store.state.settings,maxConcurrentRuns: 3 },{ kind: 'owner',via: 'ui' });
  assert.equal(store.state.events[0],event,'settings do not clone event input');
  assert.equal(store.state.tombstones[0],tombstone,'settings do not clone historical definitions');
  await store.mutate({ type: 'cursor',id },draft => { draft.cursors[id].lastSlot = 123; },'settle');
  await store.mutate({ type: 'fire',id },draft => { consumeOnce(draft,draft.triggers[0],'20000000-0000-4000-8000-000000000002',now); },'settle');
  const saved = await f.repository.exportCurrent();
  assert.equal(saved.documents.onceConsumed[id].eventId,'20000000-0000-4000-8000-000000000002');
  assert.deepEqual(saved.documents.onceConsumed.deleted,state.onceConsumed.deleted);
  assert.deepEqual(saved.documents.secretGrants,baseline.documents.secretGrants);
  assert.equal(saved.documents.settings.maxConcurrentRuns,3);
  assert.equal(saved.documents.triggers[0].enabled,false);
  assert.equal(await readFile(join(f.stateDir,'trigger-engine.json'),'utf8'),'{ stale JSON');
  const db = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
  try { assert.equal((db.prepare('SELECT logical_bytes FROM triggers_state').get() as { logical_bytes: number }).logical_bytes,Buffer.byteLength(serializeState(saved.documents))); }
  finally { db.close(); }
  await assert.rejects(definitions.setEnabled(id,true,saved.documents.triggers[0].revision,{ kind: 'owner',via: 'ui' }),/consumed/);
  const size = Buffer.byteLength(serializeState(saved.documents));
  const limited = new TriggerStore({ stateDir: f.stateDir,storage: f.client,now,limits: () => ({ acceptBytes: size,maxBytes: size + 2000 }),changed: () => {} });
  await limited.load(() => {}); await limited.flush();
  const beforeGrowth = await f.repository.exportCurrent();
  await assert.rejects(limited.mutate({ type: 'definition',id: '' },draft => { const index = draft.trustedFolders.length; draft.trustedFolders.push('x'.repeat(3000)); writeRows(draft,'trustedFolders',String(index)); }),{ kind: 'storage-full' });
  assert.deepEqual(await f.repository.exportCurrent(),beforeGrowth,'capacity refusal leaves ledger/settings/grants and receipt revision unchanged');
  await limited.mutate({ type: 'cursor',id },draft => { draft.cursors[id].lastError = 'x'.repeat(1000); },'settle');
  const settled = (await f.repository.exportCurrent()).documents;
  assert.deepEqual(settled.onceConsumed,saved.documents.onceConsumed);
  assert.deepEqual(settled.settings,saved.documents.settings);
  assert.deepEqual(settled.secretGrants,saved.documents.secretGrants);
  const held = new TriggerStore({ stateDir: f.stateDir,now,limits: () => undefined,changed: () => {} });
  await assert.rejects(held.load(() => assert.fail('missing SDK cannot recover')),/SQL authority/);
  await assert.rejects(held.mutate({ type: 'settings' },draft => { draft.settings.maxConcurrentRuns = 1; }),/SQL authority/);
});

for (const fault of ['before','after']) test(`actualStorage eventclaimed/runcommit lost reply (${fault} commit) refreshes the event revision; restart never submits an unknown admission again`, async t => {
  const f = await actualStorage(t), state = empty(), event = documents().events[0];
  event.requestId = '40000000-0000-4000-8000-000000000001';
  event.status = 'claimed'; event.input.target = { node: 'local',mode: 'session',sessionId: 'codex:fixture' };
  state.events = [event];
  await f.repository.importPrepared(state,'b'.repeat(64),'r6-event-seed');
  await new RunsRepository(f.client).importPrepared({ runs: [],created: [],instructions: {} },'b'.repeat(64),'r6-runs-seed');
  await f.client.close();
  const client = await f.open(fault), runs = new RunsRepository(client);
  const store = new TriggerStore({ stateDir: f.stateDir,storage: client,now,limits: () => undefined,changed: () => {} });
  await store.load(() => {});
  const link = await store.admissionLink(event.id); assert.ok(link);
  const run = { id: '30000000-0000-4000-8000-000000000001',sessionId: 'codex:fixture',prompt: 'fixture',status: 'queued',createdAt: new Date(now()).toISOString(),output: '',autoPromptId: event.requestId,origin: { kind: 'trigger',triggerId: event.triggerId,eventId: event.id } };
  let effects = 0;
  await assert.rejects((async () => { await runs.update([{ kind: 'run',id: run.id,json: runCanonical(run),previous: null }],'update','r6-fixed-admission',[link]); effects++; })(),error => (error as { disposition?: string }).disposition === 'unknown');
  assert.equal(effects,0);
  await assert.rejects(runs.update([{ kind: 'run',id: run.id,json: runCanonical(run),previous: null }],'update','r6-new-id',[link]));
  if (client.status().state === 'unavailable') { await client.reopen(); await client.prepare({ allowMigration: false }); }
  assert.equal(await runs.resolvePending(),fault === 'after' ? 'committed' : 'not-committed');
  assert.equal((await client.receipt('r6-new-id-begin')).found,false);
  const fixedReceipt = await client.receipt('r6-fixed-admission-commit');
  assert.equal(fixedReceipt.found,fault === 'after');
  if (fault === 'after') {
    await store.mutate({ type: 'events',ids: [event.id] },draft => { if (draft.events[0].status === 'claimed') draft.events[0].status = 'uncertain'; },'settle');
    assert.equal(store.state.events[0].status,'running','SQL revision refresh precedes stale outcome mutation');
    assert.equal(store.state.events[0].dispatch?.runId,run.id);
  }
  const reopened = new TriggerStore({ stateDir: f.stateDir,storage: client,now,limits: () => undefined,changed: () => {} });
  await reopened.load(draft => TriggerDispatch.recoverLoaded(draft,{ runs: () => [],getAutoPrompt: () => undefined }));
  // Assert the pending recovery projection; the fault fixture deliberately loses every subsequent commit too.
  assert.equal(reopened.state.events[0].status,fault === 'after' ? 'running' : 'uncertain');
  if (fault === 'before') await assert.rejects(reopened.flush(),/Cannot save triggers/);
  if (client.status().state === 'unavailable') { await client.reopen(); await client.prepare({ allowMigration: false }); }
  assert.equal(effects,0); assert.equal((await client.receipt('r6-fixed-admission-commit')).found,fault === 'after');
  assert.deepEqual(await client.receipt('r6-fixed-admission-commit'),fixedReceipt,'explicit SDK reopen only resolves the exact receipt, without replay');
  assert.equal((await client.receipt('r6-new-id-begin')).found,false);
});

test('explicit owner operations persist recovery, prune, audit eviction, deletion and restore with one commit per batch', async t => {
  const f = await actualStorage(t), state = empty(), trigger = definition();
  trigger.source = { kind: 'schedule',schedule: { type: 'interval',everySeconds: 3600 },catchUp: 'latest' };
  const second = { ...trigger,id: 'second' }, third = { ...trigger,id: 'third' };
  state.triggers = [trigger,second,third];
  state.cursors = { [id]: { anchorAt: 1 },second: { anchorAt: 2 },third: { anchorAt: 3 },orphan: { anchorAt: 4 } };
  const baseEvent = documents().events[0];
  state.events = [{ ...baseEvent,id: 'recover',status: 'claimed' },...Array.from({ length: 502 },(_,index) => ({ ...baseEvent,id: `finished-${index}`,status: 'completed' as const }))];
  state.fired = { expired: '2026-08-01T00:00:00Z' };
  state.recentFires = [{ at: 1,triggerId: id }]; state.secretGrants = { orphan: ['gone'] };
  state.audit = Array.from({ length: MAX_AUDIT },(_,index) => ({ id: `audit-${index}`,at: '2026-10-01T00:00:00Z',actor: { kind: 'owner' as const,via: 'ui' as const },action: 'settings' as const,triggerId: '',triggerName: '',summary: 'fixture' }));
  await f.repository.importPrepared(state,'b'.repeat(64),'r6-explicit-seed');
  const store = new TriggerStore({ stateDir: f.stateDir,storage: f.client,now,limits: () => undefined,changed: () => {} });
  await store.load(loaded => TriggerDispatch.recoverLoaded(loaded,{ runs: () => [],getAutoPrompt: () => undefined }));
  await store.flush();
  let saved = await f.repository.exportCurrent();
  assert.equal(saved.head.revision,2,'startup recovery and retention commit together');
  assert.equal(saved.documents.events.length,500);
  assert.equal(saved.documents.events.some(row => row.id === 'recover'),false,'recovered terminal claim may be pruned but never replayed');
  assert.deepEqual(saved.documents.fired,{}); assert.deepEqual(saved.documents.recentFires,[]);
  assert.equal(saved.documents.cursors.orphan,undefined); assert.deepEqual(saved.documents.secretGrants,{});
  const definitions = new TriggerDefinitions(store,new SecretStore(f.stateDir),now,() => undefined);
  const immutableEvent = saved.rows.find(row => row.kind === 'events')!;
  // An untouched finished event has no payload and short instructions; retention does not encode its summary.
  Object.defineProperty(store.state.events[0],'summary',{ enumerable: true,get: () => assert.fail('unrelated event JSON serialization') });
  await definitions.updateSettings({ ...store.state.settings,maxConcurrentRuns: 3 },{ kind: 'owner',via: 'ui' });
  saved = await f.repository.exportCurrent();
  assert.equal(saved.head.revision,3); assert.equal(saved.documents.audit.length,MAX_AUDIT);
  assert.equal(saved.documents.audit[0].id,'audit-1');
  assert.equal(saved.rows.find(row => row.kind === 'events' && row.id === immutableEvent.id)!.json,immutableEvent.json);
  await definitions.remove(second.id,second.revision,{ kind: 'owner',via: 'ui' });
  saved = await f.repository.exportCurrent();
  assert.equal(saved.head.revision,4); assert.deepEqual(saved.documents.triggers.map(row => row.id),[id,'third']);
  assert.deepEqual(saved.rows.filter(row => row.kind === 'triggers').map(row => row.ordinal),[0,1]);
  await definitions.restore(second.id,{ kind: 'owner',via: 'ui' });
  saved = await f.repository.exportCurrent();
  assert.equal(saved.head.revision,5); assert.deepEqual(saved.documents.triggers.map(row => row.id),[id,'third','second']);
  assert.deepEqual(saved.documents.tombstones,[]);
  const db = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
  try {
    assert.equal((db.prepare("SELECT count(*) AS n FROM operation_receipts WHERE scope = 'triggers' AND command = 'commit'").get() as { n: number }).n,5);
    assert.equal((db.prepare('SELECT logical_bytes FROM triggers_state').get() as { logical_bytes: number }).logical_bytes,Buffer.byteLength(serializeState(saved.documents)));
  } finally { db.close(); }
});

test('refused explicit delete batch rolls back removal, cancellation, tombstone, cursor and audit without publishing local memory', async t => {
  const f = await actualStorage(t), original = empty(), trigger = definition();
  trigger.source = { kind: 'schedule',schedule: { type: 'interval',everySeconds: 3600 },catchUp: 'latest' };
  original.triggers = [trigger,{ ...trigger,id: 'tail' }];
  original.cursors = { [id]: { anchorAt: 1 },tail: { anchorAt: 2 } }; original.events = documents().events;
  await f.repository.importPrepared(original,'b'.repeat(64),'r6-refuse-seed');
  await f.client.close();
  const db = new DatabaseSync(join(f.stateDir,'state.sqlite'));
  try { db.exec("CREATE TRIGGER r6_explicit_refusal BEFORE UPDATE ON triggers_state BEGIN SELECT RAISE(ABORT, 'r6 explicit refusal'); END;"); }
  finally { db.close(); }
  await f.client.reopen(); await f.client.prepare({ allowMigration: false });
  const before = await f.repository.exportCurrent();
  const store = new TriggerStore({ stateDir: f.stateDir,storage: f.client,now,limits: () => undefined,changed: () => {} });
  await store.load(() => {});
  const current = store.state, definitions = new TriggerDefinitions(store,new SecretStore(f.stateDir),now,() => undefined);
  await assert.rejects(definitions.remove(id,trigger.revision,{ kind: 'owner',via: 'ui' }),/r6 explicit refusal/);
  assert.equal(store.state,current,'SQL refusal never publishes the mutated draft');
  assert.deepEqual(store.state,original); assert.deepEqual(await f.repository.exportCurrent(),before);
  const read = new DatabaseSync(join(f.stateDir,'state.sqlite'),{ readOnly: true });
  try { assert.equal((read.prepare("SELECT count(*) AS n FROM operation_receipts WHERE scope = 'triggers' AND command = 'commit'").get() as { n: number }).n,1,'refused mixed row operations have no commit receipt'); }
  finally { read.close(); }
});

test('owner settings restore declares accepted additions and absent deletions while keeping SQL authority and execution evidence', async t => {
  const f = await actualStorage(t), state = empty(), first = definition();
  first.source = { kind: 'schedule',schedule: { type: 'interval',everySeconds: 3600 },catchUp: 'latest' };
  first.handler = { kind: 'task',instructions: 'fixture',provider: 'codex',approvals: 'auto',target: { node: 'local',mode: 'auto' } };
  const gone = { ...first,id: 'gone' }, added = { ...first,id: 'added' };
  state.triggers = [first,gone]; state.cursors = { [id]: { anchorAt: 1 },gone: { anchorAt: 2 } };
  state.fired = { retained: '2026-10-01T00:00:00Z' }; state.trustedFolders = ['/old','/other'];
  state.onceConsumed = { deleted: { at: '2026-10-01T00:00:00Z' } };
  state.events = [{ ...documents().events[0],triggerId: gone.id }];
  await f.repository.importPrepared(state,'b'.repeat(64),'r6-owner-restore-seed');
  const before = await f.repository.exportCurrent();
  const store = new TriggerStore({ stateDir: f.stateDir,storage: f.client,now,limits: () => undefined,changed: () => {} });
  await store.load(() => {});
  const secrets = new SecretStore(f.stateDir), definitions = new TriggerDefinitions(store,secrets,now,() => undefined);
  assert.deepEqual(await restoreFrom({ triggers: [first,added],settings: { ...state.settings,maxConcurrentRuns: 3 },trustedFolders: ['/restored'],
    onceConsumed: { incoming: { at: '2026-10-02T00:00:00Z' } },secretGrants: {},fired: { incoming: '2026-10-02T00:00:00Z' },github: {} },{ store,secrets,definitions,now }),[]);
  const saved = await f.repository.exportCurrent();
  assert.equal(saved.head.revision,before.head.revision! + 1,'all owner restore operations commit once');
  assert.deepEqual(saved.head.authority,before.head.authority,'settings restore does not change generation/manifest');
  assert.deepEqual(saved.documents.triggers.map(row => row.id),[id,'added']);
  assert.deepEqual(saved.documents.tombstones.map(row => row.id),['gone']);
  assert.equal(saved.documents.events[0].status,'cancelled');
  assert.deepEqual(saved.documents.trustedFolders,['/restored']); assert.equal(saved.documents.settings.maxConcurrentRuns,3);
  assert.deepEqual(saved.documents.onceConsumed,{ incoming: { at: '2026-10-02T00:00:00Z' },deleted: { at: '2026-10-01T00:00:00Z' } });
  assert.deepEqual(saved.documents.fired,{ incoming: '2026-10-02T00:00:00Z',retained: '2026-10-01T00:00:00Z' });
  assert.deepEqual(store.state,saved.documents,'only the successful SQL batch becomes local state');
});

