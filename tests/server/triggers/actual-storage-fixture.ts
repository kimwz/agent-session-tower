import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import type { StorageClient } from '../../../server/storage/client.js';
import { recordPreparationEvidence } from '../../../server/link/storage-update.js';
import { TriggersRepository } from '../../../server/triggers/storage-repository.js';
import { bootstrapTriggers, exportTriggers } from '../../../server/triggers/storage-transfer.js';
import { changesOf, rowsOf } from '../../../server/triggers/storage-codec.js';
import { empty, parseState, serializeState, type EngineState } from '../../../server/triggers/state.js';
import { triggerBackupOf } from '../../../server/triggers/backup.js';
import { retentionBuild } from '../storage/fixtures/retention-build.js';

/** Same actual captured SDK/preparation pattern as storage.test.ts; owners share one live client. */
export async function actualStorage(t: TestContext, directory: string, shared?: {
  storage: StorageClient; captured: Awaited<ReturnType<typeof retentionBuild>>;
}, fault: 'normal' | 'before' | 'after' = 'normal') {
  const stateDir = await realpath(directory);
  const folder = async () => {
    const path = await realpath(await mkdtemp(join(tmpdir(), 'tower-trigger-consumer-artifact-')));
    t.after(() => rm(path, { recursive: true, force: true })); return path;
  };
  let client: StorageClient, b: Awaited<ReturnType<typeof retentionBuild>>;
  if (shared) { client = shared.storage; b = shared.captured; }
  else {
    const a = await retentionBuild('1.124.0', await folder());
    b = await retentionBuild('1.125.0', await folder());
    const ac = await a.storage.openStorage({ stateDir, bundle: a.bundle() });
    try {
      await ac.prepare({ allowMigration: true });
      const prepared = await ac.prepare({ allowMigration: false });
      await recordPreparationEvidence(stateDir, { context: ac.context!, preflight: await a.storage.preflightStorage({ stateDir, bundle: a.bundle() }), prepared, gate: await ac.gate('core') });
    } finally { await ac.close(); }
    client = await b.storage.openStorage({ stateDir, bundle: b.bundle() });
    t.after(() => client.close());
    await client.prepare({ allowMigration: false });
  }
  if (fault !== 'normal') {
    assert.equal(shared, undefined, 'fault fixture must exclusively own its SDK');
    const seed = new TriggersRepository(client);
    await bootstrapTriggers(seed, stateDir, { now: () => 0, update: async () => ({ stateDir, managed: false, build: { version: b.version, manifest: b.manifest, preflight: await b.storage.preflightStorage({ stateDir, bundle: b.bundle() }) } }) });
    await client.close();
    // Reuse the existing before/after captured artifact fault; never overlap own writers.
    client = await b.storage.openStorage({ stateDir, bundle: b.bundle(fault) });
    await client.prepare({ allowMigration: false });
  }
  const repository = new TriggersRepository(client);
  const update = async () => ({ stateDir, managed: false, build: { version: b.version, manifest: b.manifest,
    preflight: await b.storage.preflightStorage({ stateDir, bundle: b.bundle() }) } });
  const bootstrap = async (now: () => number) => {
    if (shared && !await repository.databaseAuthority()) {
      // External fixture already owns/imported its other domains on this SDK. Seed only fresh triggers.
      await repository.gate();
      await repository.importPrepared(empty(), 'b'.repeat(64), `fixture-${randomUUID()}`);
      return true;
    }
    return bootstrapTriggers(repository, stateDir, { update, now });
  };
  const text = async () => serializeState((await repository.exportCurrent()).documents);
  // Fixture setup uses the own client's fenced row commands. It never rewrites stale runtime JSON.
  const replace = async (state: EngineState) => {
    const before = await repository.exportCurrent();
    const parsed = parseState(state, () => 0, false);
    assert.ok(parsed, 'fixture DTO must be valid; malformed SQL uses isolated damage');
    await repository.update(changesOf(before.rows, rowsOf(parsed)), 'settle', `fixture-${randomUUID()}`, before.head.revision!);
  };
  const exportLegacy = async () => {
    const parent = join(stateDir, 'fixture-exports'); await mkdir(parent, { mode: 0o700, recursive: true });
    const exported = await exportTriggers(repository, parent, `fixture-${randomUUID()}`);
    const path = join(exported.directory, 'trigger-engine.json');
    assert.equal(await readFile(path, 'utf8'), await text(), 'current SQL export is lossless serialized JSON DTO');
    return path;
  };
  const raw = async (text: string) => {
    assert.equal(await repository.databaseAuthority(), false, 'raw source belongs strictly before first import');
    await writeFile(join(stateDir, 'trigger-engine.json'), text, { mode: 0o600 });
  };
  // Direct SQL damage/faults are confined to this disposable fixture, after its sole writer closes.
  const sql = async <T>(change: (db: DatabaseSync) => T): Promise<T> => {
    await client.close();
    const db = new DatabaseSync(join(stateDir, 'state.sqlite'));
    let result: T;
    try { result = change(db); } finally { db.close(); }
    await client.reopen(); await client.prepare({ allowMigration: false });
    return result;
  };
  const failCommit = () => sql(db => db.exec("CREATE TRIGGER fixture_trigger_commit_refusal BEFORE UPDATE ON triggers_state BEGIN SELECT RAISE(ABORT, 'fixture SQL commit refusal'); END;"));
  const allowCommit = () => sql(db => db.exec('DROP TRIGGER fixture_trigger_commit_refusal;'));
  const malformedLedger = (value: unknown) => sql(db => {
    db.prepare("INSERT INTO triggers_rows(kind,id,ordinal,json,logical_bytes) VALUES ('onceConsumed','fixture-damage',(SELECT count(*) FROM triggers_rows WHERE kind='onceConsumed'),?,0)").run(JSON.stringify(value));
  });
  return { stateDir, client, repository, update, bootstrap, text, replace, exportLegacy, raw, sql, failCommit, allowCommit, malformedLedger,
    backup: async () => triggerBackupOf(JSON.parse(await text())) };
}
export type ActualTriggerStorage = Awaited<ReturnType<typeof actualStorage>>;
