import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve, sep } from 'node:path';
import type { StorageClient } from '../../../server/storage/client.js';
import { currentStorage } from '../../helpers/current-storage.js';

const fixtures = new Map<string, { client: StorageClient; held: boolean; stateDir: string }>();
/** The current build's storage (currentStorage), its retention journal begun at `migratedAt`; missing SDK is a failure. */
export async function prepareActualStorage(root: string, migratedAt = Date.UTC(2026, 8, 1)): Promise<void> {
  const stateDir = join(root, 'actual-retention-storage');
  await mkdir(stateDir, { mode: 0o700 });
  const client = await currentStorage(stateDir, { now: () => migratedAt });
  const fixture = { client, held: false, stateDir }, gate = client.gate.bind(client);
  client.gate = async scope => fixture.held ? { open: false, reasons: ['fixture SQL write held'] } : gate(scope);
  fixtures.set(resolve(root), fixture);
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
