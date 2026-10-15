import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import type { StorageClient } from '../../../server/storage/client.js';
import { requireDomainAuthority } from '../../../server/storage/initialize.js';
import { TriggersRepository } from '../../../server/triggers/storage-repository.js';
import { changesOf, rowsOf } from '../../../server/triggers/storage-codec.js';
import { empty, parseState, serializeState, type EngineState } from '../../../server/triggers/state.js';
import { triggerBackupOf } from '../../../server/triggers/backup.js';
import { currentStorage } from '../../helpers/current-storage.js';
import { faultBuild } from '../../helpers/fault-storage.js';

/**
 * The trigger owner's storage in `directory`: the current build (currentStorage, every domain authority present), or
 * `shared`'s client. A 'before'/'after' fault reopens the new storage with a fault build of its own, whose next commit
 * then ends its thread before or after committing.
 */
export async function actualStorage(t: TestContext, directory: string, shared?: { storage: StorageClient }, fault: 'normal' | 'before' | 'after' = 'normal') {
  const stateDir = await realpath(directory);
  let client: StorageClient;
  if (shared) {
    assert.equal(fault, 'normal', 'a fault fixture must exclusively own its SDK');
    client = shared.storage;
  } else if (fault === 'normal') {
    client = await currentStorage(stateDir);
    t.after(() => client.close());
  } else {
    await (await currentStorage(stateDir)).close();
    const build = await faultBuild(t);
    client = await build.storage.openStorage({ stateDir, bundle: build.bundle(fault) });
    t.after(() => client.close());
    await client.prepare({ allowMigration: false });
  }
  const repository = new TriggersRepository(client);
  /** Makes sure the triggers authority is there before an owner loads: a shared storage without one gets a fresh, empty one. */
  const bootstrap = async (_now: () => number) => {
    if (shared && !await repository.databaseAuthority()) {
      await repository.gate();
      await repository.importPrepared(empty(), 'b'.repeat(64), `fixture-${randomUUID()}`);
    }
    await requireDomainAuthority(client, 'triggers');
    return true;
  };
  const text = async () => serializeState((await repository.exportCurrent()).documents);
  // Fixture setup uses the own client's fenced row commands. It never rewrites stale runtime JSON.
  const replace = async (state: EngineState) => {
    const before = await repository.exportCurrent();
    const parsed = parseState(state, () => 0, false);
    assert.ok(parsed, 'fixture DTO must be valid; malformed SQL uses isolated damage');
    await repository.update(changesOf(before.rows, rowsOf(parsed)), 'settle', `fixture-${randomUUID()}`, before.head.revision!);
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
  return { stateDir, client, repository, bootstrap, text, replace, sql, failCommit, allowCommit, malformedLedger,
    backup: async () => triggerBackupOf(JSON.parse(await text())) };
}
export type ActualTriggerStorage = Awaited<ReturnType<typeof actualStorage>>;
