import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve, sep } from 'node:path';
import type { StorageClient } from '../../../server/storage/client.js';
import { importRetention } from '../../../server/sessions/retention/storage-transfer.js';
import { recordPreparationEvidence } from '../../../server/link/storage-update.js';
import { retentionBuild } from '../storage/fixtures/retention-build.js';

const fixtures = new Map<string, { client: StorageClient; held: boolean; stateDir: string }>();
/** Real shared SDK/thread and released retention commands; missing SDK is a failure. */
export async function prepareActualStorage(root: string, migratedAt = Date.UTC(2026, 8, 1)): Promise<void> {
  const stateDir = join(root, 'actual-retention-storage');
  await mkdir(stateDir, { mode: 0o700 });
  const a = await retentionBuild('1.120.2', join(root, 'actual-retention-a'));
  const b = await retentionBuild('1.121.0', join(root, 'actual-retention-b'));
  const ac = await a.storage.openStorage({ stateDir, bundle: a.bundle() });
  try {
    const prepared = await ac.prepare({ allowMigration: true });
    const preflight = await a.storage.preflightStorage({ stateDir, bundle: a.bundle() });
    await recordPreparationEvidence(stateDir, { context: ac.context!, preflight, prepared, gate: await ac.gate('core') });
  } finally { await ac.close(); }
  await mkdir(join(stateDir, 'retention'), { mode: 0o700 });
  await writeFile(join(stateDir, 'retention', 'journal.json'), JSON.stringify({ version: 1, migratedAt, entries: [], policies: [] }), { mode: 0o600 });
  await writeFile(join(stateDir, 'retention-observations.json'), JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
  const evidenceParent = join(stateDir, 'storage-migrations'); await mkdir(evidenceParent, { mode: 0o700 });
  const client = await b.storage.openStorage({ stateDir, bundle: b.bundle() });
  try {
    await client.prepare({ allowMigration: false });
    const preflight = await b.storage.preflightStorage({ stateDir, bundle: b.bundle() });
    await importRetention({ storage: client, stateDir, evidenceParent, update: { stateDir, managed: false, build: { version: b.version, manifest: b.manifest, preflight } }, commandId: 'fixture-first-import' });
    const fixture = { client, held: false, stateDir }, gate = client.gate.bind(client);
    client.gate = async scope => fixture.held ? { open: false, reasons: ['fixture SQL write held'] } : gate(scope);
    fixtures.set(resolve(root), fixture);
  } catch (error) { await client.close(); throw error; }
}
function fixture(path: string) {
  const absolute = resolve(path);
  for (const [root, value] of fixtures) if (absolute === root || absolute.startsWith(root + sep)) return value;
  throw new Error(`Actual retention storage was not prepared for ${path}`);
}
export function actualStorage(path: string): StorageClient { return fixture(path).client; }
export function holdActualStorage(path: string, held: boolean): void { fixture(path).held = held; }
export async function closeActualStorage(root: string): Promise<void> {
  const value = fixtures.get(resolve(root));
  if (value) { await value.client.close(); fixtures.delete(resolve(root)); }
}

/** Corrupt only isolated fixture SQL metadata, with its actual writer closed. */
export async function corruptActualObservations(path: string): Promise<void> {
  const value = fixture(path);
  await value.client.close();
  const db = new DatabaseSync(join(value.stateDir, 'state.sqlite'));
  try { db.prepare("UPDATE retention_metadata SET json = ? WHERE kind = 'observations'").run('{broken fixture'); }
  finally { db.close(); }
  await value.client.reopen(); await value.client.prepare({ allowMigration: false });
}
