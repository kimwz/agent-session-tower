import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { after, type TestContext } from 'node:test';
import type { StorageClient } from '../../../server/storage/client.js';
import { recordPreparationEvidence } from '../../../server/link/storage-update.js';
import { TriggersRepository } from '../../../server/triggers/storage-repository.js';
import { bootstrapTriggers, exportTriggers } from '../../../server/triggers/storage-transfer.js';
import { changesOf, rowsOf } from '../../../server/triggers/storage-codec.js';
import { empty, parseState, serializeState, type EngineState } from '../../../server/triggers/state.js';
import { triggerBackupOf } from '../../../server/triggers/backup.js';
import { retentionBuild } from '../storage/fixtures/retention-build.js';

type Build = Awaited<ReturnType<typeof retentionBuild>>;
type Normal = Pick<Build, 'storage' | 'manifest' | 'version'> & { bundle: () => ReturnType<Build['bundle']> };
const normalBuilds = new Map<'1.124.0' | '1.125.0', Promise<() => Promise<Normal>>>();
const normalOwners: Array<{ path: string; dev: number; ino: number }> = [];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
after(async () => {
  assert.ok(normalOwners.length <= 2);
  for (const owner of normalOwners) {
    const current = await lstat(owner.path);
    assert.equal(await realpath(owner.path), owner.path);
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, owner.dev); assert.equal(current.ino, owner.ino);
  }
  for (const owner of normalOwners) await rm(owner.path, { recursive: true, force: true });
});
async function normalBuild(version: '1.124.0' | '1.125.0'): Promise<Normal> {
  let pending = normalBuilds.get(version);
  if (!pending) {
    pending = (async () => {
      const path = await realpath(await mkdtemp(join(tmpdir(), 'tower-trigger-consumer-artifact-')));
      await chmod(path, 0o700);
      const owner = await lstat(path); normalOwners.push({ path, dev: owner.dev, ino: owner.ino });
      const built = await retentionBuild(version, path);
      const bundle = Object.freeze(built.bundle());
      const context = built.storage.storageBuildContext(bundle);
      assert.ok(context.ok); assert.equal(context.identity.appVersion, version);
      assert.equal(context.sourceHash, bundle.sourceHash); assert.deepEqual(context.manifest, built.manifest);
      if (version === '1.124.0') assert.equal(context.sourceHash, '5318990f15be1bbe73ba69c390c4b5ae32c7ee4ca61ba89f4d34241723936a0a');
      const capsule = Object.freeze({ storage: built.storage, manifest: context.manifest, version, bundle: () => bundle });
      const files = ['parent.mjs', 'manifest.json'].map(name => join(path, name));
      const hashes = await Promise.all(files.map(async file => hash(await readFile(file))));
      const sourceHash = hash(bundle.source);
      return async () => {
        assert.equal(hash(bundle.source), sourceHash);
        assert.deepEqual(await Promise.all(files.map(async file => hash(await readFile(file)))), hashes);
        assert.deepEqual(capsule.storage.storageBuildContext(bundle), context);
        return capsule;
      };
    })();
    normalBuilds.set(version, pending);
  }
  return (await pending)();
}

/** Same actual captured SDK/preparation pattern as storage.test.ts; owners share one live client. */
export async function actualStorage(t: TestContext, directory: string, shared?: {
  storage: StorageClient; captured: Awaited<ReturnType<typeof retentionBuild>>;
}, fault: 'normal' | 'before' | 'after' = 'normal') {
  const stateDir = await realpath(directory);
  const folder = async () => {
    const path = await realpath(await mkdtemp(join(tmpdir(), 'tower-trigger-consumer-artifact-')));
    t.after(() => rm(path, { recursive: true, force: true })); return path;
  };
  let client: StorageClient, b: Normal;
  let faultBuild: Build | undefined;
  if (shared) { client = shared.storage; b = shared.captured; }
  else {
    const a = fault === 'normal' ? await normalBuild('1.124.0') : await retentionBuild('1.124.0', await folder());
    b = fault === 'normal' ? await normalBuild('1.125.0') : (faultBuild = await retentionBuild('1.125.0', await folder()));
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
    client = await b.storage.openStorage({ stateDir, bundle: faultBuild!.bundle(fault) });
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
