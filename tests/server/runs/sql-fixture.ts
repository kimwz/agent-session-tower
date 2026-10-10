import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import { RunManager as ProductionRunManager } from '../../../server/runs/manager.js';
import type { StorageClient } from '../../../server/storage/client.js';
import { retentionBuild } from '../storage/fixtures/retention-build.js';
import { recordPreparationEvidence } from '../../../server/link/storage-update.js';
import { RunsRepository } from '../../../server/runs/storage-repository.js';
import { RetentionRepository } from '../../../server/sessions/retention/storage-repository.js';
import type { RunDocuments } from '../../../server/runs/storage-codec.js';
import { TriggersRepository } from '../../../server/triggers/storage-repository.js';
import { empty, serializeState } from '../../../server/triggers/state.js';

let builds: Promise<{ a: Awaited<ReturnType<typeof retentionBuild>>; b: Awaited<ReturnType<typeof retentionBuild>>; directory: string }> | undefined;
function artifacts() {
  return builds ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tower-runs-sql-artifacts-'));
    const a = await retentionBuild('1.122.0', join(directory, 'a'));
    const b = await retentionBuild('1.125.0', join(directory, 'b'), true, false, true);
    return { a, b, directory };
  })();
}
after(async () => { if (builds) await rm((await builds).directory, { recursive: true, force: true }); });

/** Existing captured SDK/actual SQLite handlers; missing SDK is a failure, never a successful mock. */
const commandErrors = new WeakMap<StorageClient, typeof import('../../../server/storage/contract.js').StorageCommandError>();
export function fixtureCommandError(client: StorageClient) {
  const error = commandErrors.get(client);
  if (!error) throw new Error('Fixture SDK error class is not captured.');
  return error;
}
let faultBuild: ReturnType<typeof retentionBuild> | undefined;
export async function actualStorage(stateDir: string, initial?: RunDocuments, threadFault = false, onUnavailable?: import('../../../server/storage/client.js').StorageClientOptions['onUnavailable']) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const { a, b: normal, directory } = await artifacts();
  const b = threadFault ? await (faultBuild ??= retentionBuild('1.125.0', join(directory, 'thread-fault'), true, true, true, undefined, true)) : normal;
  let fresh = false;
  try { await stat(join(stateDir, 'state.sqlite')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; fresh = true; }
  // A122 must never reopen a final consumer DB whose additional domains it cannot read.
  if (fresh) {
    const preparation = await a.storage.openStorage({ stateDir, bundle: a.bundle() });
    try {
      const prepared = await preparation.prepare({ allowMigration: true });
      const preflight = await a.storage.preflightStorage({ stateDir, bundle: a.bundle() });
      await recordPreparationEvidence(stateDir, { context: preparation.context!, preflight, prepared, gate: await preparation.gate('core') });
    } finally { await preparation.close(); }
  }
  const client = await b.storage.openStorage({ stateDir, bundle: b.bundle(), onUnavailable });
  commandErrors.set(client, b.storage.StorageCommandError);
  try {
    await client.prepare({ allowMigration: true });
    const repository = new RunsRepository(client);
    if (!await repository.databaseAuthority()) await repository.importPrepared(initial ?? { runs: [], created: [], instructions: {} }, 'a'.repeat(64), 'runs-fixture-initial-import');
    else if (initial) throw new Error('Fixture initial import cannot overwrite an existing SQL authority.');
    return client;
  } catch (error) { await client.close(); throw error; }
}

/** Import only the missing runs authority on the consumer's existing shared SDK. */
export async function importFixtureRuns(client: StorageClient, initial: RunDocuments = { runs: [], created: [], instructions: {} }): Promise<void> {
  const repository = new RunsRepository(client);
  if (!await repository.databaseAuthority()) {
    await repository.importPrepared(initial, 'a'.repeat(64), 'runs-fixture-initial-import');
    const receipt = await client.receipt('runs-fixture-initial-import-commit');
    if (!receipt.found || receipt.receipt.scope !== 'runs' || !await repository.databaseAuthority()) throw new Error('Runs fixture import receipt/authority is missing.');
  }
}

/** Retention and observer fixtures share the runs SDK and its released SQL commands. */
export async function importFixtureRetention(client: StorageClient, migratedAt = Date.UTC(2026, 8, 1)): Promise<void> {
  const repository = new RetentionRepository(client);
  if (!await repository.databaseAuthority()) {
    await repository.importPrepared({
      journal: { version: 1, migratedAt, entries: [], policies: [] }, observations: { version: 1, entries: [] },
    }, 'a'.repeat(64), 'retention-fixture-initial-import');
    const receipt = await client.receipt('retention-fixture-initial-import-commit');
    if (!receipt.found || receipt.receipt.scope !== 'retention' || !await repository.databaseAuthority()) throw new Error('Retention fixture import receipt/authority is missing.');
  }
}

/** Fresh consumer state uses the released trigger owner on the common actual SDK. */
export async function importFixtureTriggers(client: StorageClient): Promise<void> {
  const repository = new TriggersRepository(client);
  if (!await repository.databaseAuthority()) {
    await repository.importPrepared(empty(), 'b'.repeat(64), 'triggers-fixture-initial-import');
    const receipt = await client.receipt('triggers-fixture-initial-import-commit');
    if (!receipt.found || receipt.receipt.scope !== 'triggers' || !await repository.databaseAuthority()) throw new Error('Triggers fixture import receipt/authority is missing.');
  }
}

/** Consumer fixtures run the production manager against an actual imported SQL authority. */
export class RunManager extends ProductionRunManager {
  private fixtureClient?: StorageClient;
  private bound: boolean;
  private fixtureClosed = false;
  constructor(private readonly fixtureOptions: ConstructorParameters<typeof ProductionRunManager>[0] & { fixtureInitial?: RunDocuments; fixtureThreadFault?: boolean; fixtureOnUnavailable?: import('../../../server/storage/client.js').StorageClientOptions['onUnavailable'] }) {
    super(fixtureOptions); this.bound = Boolean(fixtureOptions.storage);
  }
  override useStorage(storage: StorageClient): void { super.useStorage(storage); this.bound = true; }
  fixtureIsClosed(): boolean { return this.fixtureClosed; }
  sqlFixture(): StorageClient {
    const client = this.fixtureClient ?? this.fixtureOptions.storage;
    if (!client) throw new Error('Run fixture SQL has not started.');
    return client;
  }
  override async start(): Promise<void> {
    if (!this.bound) {
      if (!this.fixtureOptions.stateDir) throw new Error('Run fixture requires its isolated stateDir.');
      this.fixtureClient = await actualStorage(this.fixtureOptions.stateDir, this.fixtureOptions.fixtureInitial, this.fixtureOptions.fixtureThreadFault, this.fixtureOptions.fixtureOnUnavailable);
      this.useStorage(this.fixtureClient);
    }
    this.fixtureClosed = false;
    await super.start();
  }
  override async close(): Promise<void> {
    try { await super.close(); } finally { await this.fixtureClient?.close(); this.fixtureClosed = true; }
  }
}

export async function fixtureDocuments(manager: RunManager): Promise<RunDocuments> {
  const client = manager.sqlFixture();
  // Reopening the same fixture SDK is sequential with the closed manager; never a second writer.
  const closed = manager.fixtureIsClosed();
  if (closed) { await client.reopen(); await client.prepare({ allowMigration: false }); }
  try { return (await new RunsRepository(client).exportCurrent()).documents; }
  finally { if (closed) await client.close(); }
}

export async function fixtureReplaceRuns(manager: RunManager, runs: RunDocuments['runs']): Promise<void> {
  const client = manager.sqlFixture(), closed = manager.fixtureIsClosed();
  if (closed) { await client.reopen(); await client.prepare({ allowMigration: false }); }
  try {
    const repository = new RunsRepository(client), current = await repository.exportCurrent();
    await repository.restore({ ...current.documents, runs }, `fixture-restore-${randomUUID()}`);
  } finally { if (closed) await client.close(); }
}

export async function fixtureTriggerText(manager: RunManager): Promise<string> {
  const client = manager.sqlFixture(), closed = manager.fixtureIsClosed();
  if (closed) { await client.reopen(); await client.prepare({ allowMigration: false }); }
  try { return serializeState((await new TriggersRepository(client).exportCurrent()).documents); }
  finally { if (closed) await client.close(); }
}

/** A quiet fixture models the process exit after final handoff flush, before releasing its SDK lease.
 * Ordinary owner close cancels queued work; a stopped predecessor must preserve it for the successor.
 */
const stoppedFixtureWriters = new WeakSet<ProductionRunManager>();
export async function stopFixtureWriter(manager: ProductionRunManager): Promise<void> {
  const stopped = manager as unknown as {
    owned: Map<string, unknown>; bridged: Map<string, unknown>; stdio: Map<string, unknown>;
    stopping: boolean; pollTimer?: ReturnType<typeof setInterval>; notifyTimer?: ReturnType<typeof setTimeout>;
    cancelOutputPersist(): void;
  };
  if (stoppedFixtureWriters.has(manager)) return;
  manager.holdStorage();
  await manager.pauseAttachmentCleanup();
  await manager.flushState();
  if (stopped.owned.size || stopped.bridged.size || stopped.stdio.size) throw new Error('Only an exact quiet fixture writer can release its lease.');
  stopped.stopping = true;
  if (stopped.pollTimer) { clearInterval(stopped.pollTimer); stopped.pollTimer = undefined; }
  if (stopped.notifyTimer) { clearTimeout(stopped.notifyTimer); stopped.notifyTimer = undefined; }
  stopped.cancelOutputPersist();
  stoppedFixtureWriters.add(manager);
}
