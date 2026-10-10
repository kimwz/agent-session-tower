import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { StorageClient } from '../../../server/storage/client.js';
import type { DomainWriteContext } from '../../../server/storage/domain.js';
import { runsDomain } from '../../../server/runs/storage-commands.js';
import { runsSchema } from '../../../server/runs/storage-schema.js';
import { RunsRepository } from '../../../server/runs/storage-repository.js';
import { canonical, runHash, type RunChange } from '../../../server/runs/storage-codec.js';
import { triggersSchema } from '../../../server/triggers/storage-schema.js';
import { rowsOf, logicalBytes, rowCost, triggerHash } from '../../../server/triggers/storage-codec.js';
import type { TriggerAdmissionLink } from '../../../server/triggers/storage-commands.js';
import { empty } from '../../../server/triggers/state.js';
import { restoreRuns } from '../../../server/runs/run-history.js';
import { RunManager } from './sql-fixture.js';
import { TriggersRepository } from '../../../server/triggers/storage-repository.js';
import { TriggerDispatch } from '../../../server/triggers/dispatch.js';
import { TriggerStore } from '../../../server/triggers/store.js';
import { retentionBuild } from '../storage/fixtures/retention-build.js';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

// Isolated SQL fixture and transport fault model. These are authored tests, not hosted runtime evidence.
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE storage_meta (key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE domain_imports (domain TEXT PRIMARY KEY,authority TEXT,generation INTEGER,reader_contract INTEGER,writer_contract INTEGER,manifest_sha256 TEXT,committed_at TEXT,app_version TEXT,source_hash TEXT,owner_epoch INTEGER);
    CREATE TABLE receipts (id TEXT PRIMARY KEY,payload TEXT,result TEXT);`);
  for (const schema of [runsSchema,triggersSchema]) for (const migration of schema.migrations) db.exec(migration.sql);
  const storageId = '10000000-0000-4000-8000-000000000001';
  db.prepare('INSERT INTO storage_meta VALUES (?,?)').run('storage_id',storageId);
  for (const domain of ['runs','triggers']) db.prepare('INSERT INTO domain_imports (domain,authority,generation,reader_contract,writer_contract,manifest_sha256,committed_at,app_version,source_hash,owner_epoch) VALUES (?,?,?,?,?,?,?,?,?,?)').run(domain,'database',1,1,1,'a'.repeat(64),'2026-10-01T00:00:00Z','1.125.0','b'.repeat(64),1);
  db.prepare('INSERT INTO runs_state VALUES (1,1)').run();
  const state = empty();
  const requestId = '40000000-0000-4000-8000-000000000001';
  state.events = [{ id: 'event',triggerId: 'trigger',triggerName: 'fixture',triggerRevision: 1,dedupKey: 'slot',occurredAt: '2026-10-01T00:00:00Z',receivedAt: '2026-10-01T00:00:00Z',updatedAt: '2026-10-01T00:00:00Z',summary: 'fixture',requestId,status: 'claimed',claimedAt: '2026-10-01T00:00:00Z',kind: 'manual',input: { target: { node: 'local',mode: 'session',sessionId: 'codex:fixture' },instructions: 'fixture',provider: 'codex',approvals: 'auto',untrustedInput: false,overlap: 'skip' } }];
  const rows = rowsOf(state);
  for (const row of rows) db.prepare('INSERT INTO triggers_rows VALUES (?,?,?,?,?,?,?)').run(row.kind,row.id,row.ordinal,row.json,0,row.kind === 'events' ? 'trigger' : null,row.kind === 'events' ? 'claimed' : null);
  db.prepare('INSERT INTO triggers_state VALUES (1,1,?)').run(logicalBytes(rows));
  // Seed row costs through the same codec; settings and event are the only fixture rows.
  for (const row of rows) db.prepare('UPDATE triggers_rows SET logical_bytes = ? WHERE kind = ? AND id = ?').run(rowCost(row,row.json),row.kind,row.id);
  const link: TriggerAdmissionLink = { storageId,generation: 1,revision: 1,eventId: 'event',requestId,eventSha256: triggerHash(rows.find(row => row.kind === 'events')!.json) };
  const run = { id: '20000000-0000-4000-8000-000000000001',sessionId: 'codex:fixture',prompt: 'fixture',status: 'queued',createdAt: '2026-10-01T00:00:00Z',output: '',autoPromptId: requestId,origin: { kind: 'trigger',eventId: 'event',triggerId: 'trigger' },attachments: [{ id: '30000000-0000-4000-8000-000000000001',name: 'fixture.txt',mimeType: 'text/plain',size: 1 }] };
  const changes = (): RunChange[] => [{ kind: 'run',id: run.id,json: canonical(run),previous: null }];
  let loseResponse = false;
  const writes: string[] = [], lookups: string[] = [];
  const receipt = (id: string) => {
    lookups.push(id);
    const row = db.prepare('SELECT payload,result FROM receipts WHERE id = ?').get(id) as { payload: string; result: string } | undefined;
    return row ? { found: true,receipt: { scope: 'runs',command: id.endsWith('-commit') ? 'commit' : id.endsWith('-begin') ? 'begin' : 'stage',payloadSha256: runHash(row.payload),result: { state: 'included',value: JSON.parse(row.result) } } } : { found: false };
  };
  const storage = {
    gate: async () => ({ open: true,reasons: [] }),receipt: async (id: string) => receipt(id),
    read: async (_scope: string,command: string) => {
      assert.equal(command,'head');
      return { revision: Number((db.prepare('SELECT revision FROM runs_state').get() as { revision: number }).revision),authority: { authority: 'database',generation: 1 } };
    },
    write: async (_scope: string,command: string,payload: unknown,id: string) => {
      writes.push(id);
      const previous = db.prepare('SELECT payload,result FROM receipts WHERE id = ?').get(id) as { payload: string; result: string } | undefined;
      if (previous) { assert.equal(previous.payload,JSON.stringify(payload)); return JSON.parse(previous.result); }
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const context = { domain: 'runs',commandId: id,ownerEpoch: 1,now: '2026-10-02T00:00:00Z',prepare: (sql: string) => db.prepare(sql),authority: { current: () => ({ generation: 1 }) } } as unknown as DomainWriteContext;
        const result = runsDomain.commands[command].run(context,payload);
        db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(id,JSON.stringify(payload),JSON.stringify(result));
        db.exec('COMMIT');
        committed = true;
        if (command === 'commit' && loseResponse) throw Object.assign(new Error('Lost commit response'),{ disposition: 'unknown' });
        return result;
      } catch (error) { if (!committed) db.exec('ROLLBACK'); throw error; }
    },
  } as unknown as StorageClient;
  const repository = new RunsRepository(storage);
  const event = () => JSON.parse((db.prepare("SELECT json FROM triggers_rows WHERE kind = 'events'").get() as { json: string }).json);
  return { db,run,link,changes,repository,event,writes,lookups,loseResponse: () => { loseResponse = true; } };
}

test('local session event, fresh run and fixed receipt commit together; duplicate returns receipt and payload conflicts refuse', async t => {
  const f = fixture(); t.after(() => f.db.close());
  await f.repository.update(f.changes(),'update','fixed',[f.link]);
  assert.equal(f.event().status,'running'); assert.equal(f.event().dispatch.runId,f.run.id);
  assert.deepEqual(JSON.parse((f.db.prepare("SELECT json FROM runs_rows WHERE kind = 'run'").get() as { json: string }).json).attachments,f.run.attachments);
  assert.equal((f.db.prepare('SELECT revision FROM triggers_state').get() as { revision: number }).revision,2);
  const count = f.writes.length;
  await f.repository.update(f.changes(),'update','fixed',[f.link]);
  assert.equal(f.writes.length,count);
  await assert.rejects(f.repository.update(f.changes(),'update','fixed',[{ ...f.link,requestId: 'other' }]),/conflicts/);
});

test('commit response loss leaves provider at zero; resolve only exact command/hash without replay', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.loseResponse(); let providers = 0;
  await assert.rejects((async () => { await f.repository.update(f.changes(),'update','lost',[f.link]); providers++; })(),/Lost/);
  assert.equal(providers,0); assert.equal(f.event().status,'running');
  const pending = f.repository.pending()!; assert.equal(pending.attemptedCommandId,'lost-commit');
  assert.equal(pending.attemptedPayloadSha256,runHash(JSON.stringify({ intent: 'lost' })));
  const count = f.writes.length;
  assert.equal(await f.repository.resolvePending(),'committed');
  assert.equal(f.writes.length,count); assert.equal(f.lookups.at(-1),'lost-commit'); assert.equal(providers,0);
});

test('crash after commit before provider never replays an ordinary queued trigger run on restoration', async t => {
  const f = fixture(); t.after(() => f.db.close());
  await f.repository.update(f.changes(),'update','crash',[f.link]);
  const saved = JSON.parse((f.db.prepare("SELECT json FROM runs_rows WHERE kind = 'run'").get() as { json: string }).json);
  assert.equal(restoreRuns([saved],new Map()).runs[0].status,'cancelled');
  assert.equal(f.event().status,'running'); assert.equal(f.event().dispatch.runId,saved.id);
});

for (const [name,patch] of [
  ['revision',{ revision: 2 }],['generation',{ generation: 2 }],['storage identity',{ storageId: 'foreign' }],['request',{ requestId: 'foreign' }],['event hash',{ eventSha256: '0'.repeat(64) }],
] as const) test(`invalid ${name} rolls back run, event and receipt`, async t => {
  const f = fixture(); t.after(() => f.db.close());
  await assert.rejects(f.repository.update(f.changes(),'update','refused',[{ ...f.link,...patch }]));
  assert.equal(f.event().status,'claimed'); assert.equal(f.db.prepare('SELECT 1 FROM runs_rows').get(),undefined);
  assert.equal(f.db.prepare("SELECT 1 FROM receipts WHERE id = 'refused-commit'").get(),undefined);
});

test('another run with the same request refuses without admitting a second run', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.db.prepare('INSERT INTO runs_rows VALUES (?,?,?,?,?,?)').run('run','other',0,canonical({ ...f.run,id: 'other' }),'queued',f.run.sessionId);
  await assert.rejects(f.repository.update(f.changes(),'update','duplicate',[f.link]),/already admitted/);
  assert.equal(f.event().status,'claimed');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM runs_rows').get() as { n: number }).n,1);
});

for (const guard of ['status','untrusted','remote','folder','coordinator','runs-authority','triggers-authority','budget'] as const) test(`${guard} guard refuses the entire linked transaction`, async t => {
  const f = fixture(); t.after(() => f.db.close());
  const event = f.event();
  if (guard === 'status') event.status = 'cancelled';
  if (guard === 'untrusted') event.input.untrustedInput = true;
  if (guard === 'remote') event.input.remote = { controllerId: 'controller' };
  if (guard === 'folder') event.input.target = { node: 'local',mode: 'folder',cwd: '/fixture' };
  if (guard === 'coordinator') event.input.handler = 'coordinator';
  const json = JSON.stringify(event);
  f.db.prepare("UPDATE triggers_rows SET json = ? WHERE kind = 'events'").run(json);
  if (guard.endsWith('-authority')) f.db.prepare("UPDATE domain_imports SET authority = 'legacy-exported' WHERE domain = ?").run(guard.split('-')[0]);
  if (guard === 'budget') f.db.prepare("UPDATE triggers_rows SET logical_bytes = 10000001 WHERE kind = 'settings'").run();
  await assert.rejects(f.repository.update(f.changes(),'update','guard',[{ ...f.link,eventSha256: triggerHash(json) }]));
  assert.equal(f.event().status,event.status); assert.equal(f.db.prepare('SELECT 1 FROM runs_rows').get(),undefined);
  assert.equal(f.db.prepare("SELECT 1 FROM receipts WHERE id = 'guard-commit'").get(),undefined);
});

test('unknown receipt with a different payload hash stays unresolved and cannot admit or replay', async t => {
  const f = fixture(); t.after(() => f.db.close()); f.loseResponse();
  await assert.rejects(f.repository.update(f.changes(),'update','unknown',[f.link]));
  const pending = f.repository.pending();
  f.db.prepare("UPDATE receipts SET payload = ? WHERE id = 'unknown-commit'").run(JSON.stringify({ intent: 'different' }));
  const count = f.writes.length;
  await assert.rejects(f.repository.resolvePending(),/hash conflict/);
  assert.equal(f.repository.pending(),pending); assert.equal(f.writes.length,count);
  await assert.rejects(f.repository.update(f.changes(),'update','new-id',[f.link]),/Lost/);
  assert.equal(f.writes.length,count);
});

for (const response of ['known','lost'] as const) test(`actual dispatch local trigger provider gate, readback and completion tracking: ${response} commit response`, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(),'tower-r4-admission-')));
  t.after(() => rm(directory,{ recursive: true,force: true }));
  const build = await retentionBuild('1.125.0',join(directory,'build'));
  await mkdir(join(directory,'state'),{ mode: 0o700 });
  const client = await build.storage.openStorage({ stateDir: join(directory,'state'),bundle: build.bundle() });
  t.after(() => client.close()); await client.prepare({ allowMigration: true });
  await new RunsRepository(client).importPrepared({ runs: [],created: [],instructions: {} },'a'.repeat(64),'runs-import');
  const state = empty(), requestId = '40000000-0000-4000-8000-000000000001';
  const session: Session = { id: 'codex:10000000-0000-4000-8000-000000000002',nativeId: '10000000-0000-4000-8000-000000000002',provider: 'codex',title: 'fixture',cwd: directory,project: 'fixture',status: 'completed',statusReason: '',createdAt: '2026-10-01T00:00:00Z',updatedAt: '2026-10-01T00:00:00Z',lastMessage: '',messageCount: 0,isSubagent: false,resumable: true };
  state.events = [{ id: 'event',triggerId: 'trigger',triggerName: 'fixture',triggerRevision: 1,dedupKey: 'slot',occurredAt: session.createdAt,receivedAt: session.createdAt,updatedAt: session.createdAt,summary: 'fixture',requestId,status: 'queued',kind: 'manual',input: { target: { node: 'local',mode: 'session',sessionId: session.id },instructions: 'fixture',provider: 'codex',approvals: 'auto',untrustedInput: false,overlap: 'skip' } }];
  await new TriggersRepository(client).importPrepared(state,'b'.repeat(64),'triggers-import');
  const store = new TriggerStore({ storage: client,stateDir: join(directory,'state'),now: () => Date.parse(session.createdAt),limits: () => undefined,changed: () => {} });
  await store.load(() => {});
  let providers = 0;
  const manager = new RunManager({ storage: client,stateDir: join(directory,'state'),getSession: () => session,refreshSessions: async () => {},holdUntilReady: true,findExecutable: async () => '/fixture/codex',
    spawnProcess: () => { providers++; throw new Error('Fixture forbids native process'); },openCodexStdio: async config => {
      providers++;
      return { start: async () => { config.onFinished({ status: 'completed' }); },done: Promise.resolve(),close: () => {},cancel: async () => {},respondToApproval: async () => {} };
    } });
  await manager.start();
  const dispatch = new TriggerDispatch(store, {
    enqueue: manager.enqueue.bind(manager),runs: () => manager.list(),session: () => session,getAutoPrompt: () => undefined,
    submitAutoPrompt: async () => { throw new Error('Fixture forbids Auto Prompt'); },
    create: async () => { throw new Error('Fixture forbids folder creation'); },
  }, () => Date.parse(session.createdAt), { isHeld: () => false,githubClient: async () => { throw new Error('Fixture forbids GitHub'); } });
  const write = client.write.bind(client);
  let entered!: () => void, release!: () => void, targetIntent: string | undefined;
  const saving = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  client.write = async <T>(...args: Parameters<typeof client.write>) => {
    if (args[0] === 'runs' && args[1] === 'stage') {
      const payload = args[2] as { intent: string; data: string };
      if (Buffer.from(payload.data,'base64').toString('utf8').includes('triggerLinks')) targetIntent = payload.intent;
    }
    if (args[0] === 'runs' && args[1] === 'commit' && (args[2] as { intent: string }).intent === targetIntent) {
      entered(); await held;
      const result = await write<T>(...args);
      if (response === 'lost') throw Object.assign(new Error('Lost linked commit response'),{ disposition: 'unknown' });
      return result;
    }
    return write<T>(...args);
  };
  const delivery = dispatch.dispatch();
  await saving; manager.markReady();
  await (manager as unknown as { pump(): Promise<void> }).pump(); assert.equal(providers,0);
  release(); await delivery; client.write = write;
  if (response === 'lost') {
    assert.ok(manager.pendingAdmission());
    await (manager as unknown as { pump(): Promise<void> }).pump(); assert.equal(providers,0);
  } else {
    await until(() => providers > 0);
  }
  // The actual outcome callback must preserve SQL running/runId even on response loss.
  assert.equal(store.state.events[0].status,'running');
  assert.equal(store.state.events[0].error,undefined);
  const saved = (await new TriggersRepository(client).exportCurrent()).documents.events[0];
  assert.equal(saved.status,'running'); assert.ok(saved.dispatch?.runId); assert.equal(store.state.events[0].dispatch?.runId,saved.dispatch?.runId);
  if (response === 'lost') {
    const count = providers, pending = manager.pendingAdmission()!;
    const resolved = await manager.resolveAdmission(pending.commandId);
    assert.equal(resolved.disposition,'committed');
    assert.equal(manager.pendingAdmission(),undefined);
    assert.equal(providers,count,'receipt resolution itself never launches a provider');
  }
  manager.releaseStorage();
  await until(() => manager.list().some(run => run.id === saved.dispatch?.runId && run.status === 'completed'));
  await (manager as unknown as { flush(): Promise<void> }).flush();
  await dispatch.track();
  const completed = (await new TriggersRepository(client).exportCurrent()).documents.events[0];
  assert.equal(completed.status,'completed');
  assert.equal(completed.dispatch?.runId,saved.dispatch?.runId);
  assert.equal(providers,1,'receipt recovery and tracking never replay the provider');
  await manager.close();
});
