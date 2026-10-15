import { mkdir } from 'node:fs/promises';
import { captureStorageBundle } from '../../server/storage/bundle.js';
import { openStorage, type StorageClient, type StorageClientOptions } from '../../server/storage/client.js';
import { initializeStorageDomains } from '../../server/storage/initialize.js';

export interface CurrentStorageOptions {
  /** Create the missing domain authorities (default). False leaves a prepared storage with none. */
  initialize?: boolean;
  /** The clock of the retention journal's migratedAt, when initialize creates it. */
  now?: () => number;
  limits?: StorageClientOptions['limits'];
  onUnavailable?: StorageClientOptions['onUnavailable'];
}

/**
 * The current build's storage in `stateDir` (created owner-only when missing), the way tests use it: the process's
 * captured thread bundle (captureStorageBundle, bundled once per process from this checkout and then shared: it is
 * immutable compiled code) → openStorage → prepare({ allowMigration: true }) → initializeStorageDomains. Everything
 * else is the test's own: the database, the client (the caller closes it) and its thread. A failed start closes it.
 */
export async function currentStorage(stateDir: string, options: CurrentStorageOptions = {}): Promise<StorageClient> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const client = await openStorage({ stateDir, bundle: await captureStorageBundle(), limits: options.limits, onUnavailable: options.onUnavailable });
  try {
    const status = client.status();
    if (status.state !== 'ready') throw new Error(`The current storage did not open: ${status.failure?.code}: ${status.failure?.message}`);
    await client.prepare({ allowMigration: true });
    if (options.initialize ?? true) await initializeStorageDomains(client, stateDir, options.now ? { now: options.now } : {});
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
