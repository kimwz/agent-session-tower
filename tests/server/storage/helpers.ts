import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { storageBundleFromArtifact, type CapturedStorageBundle, type StorageBundleCapture } from '../../../server/storage/bundle.js';
import { openStorage, type StorageClient, type StorageClientOptions } from '../../../server/storage/client.js';
import { storageManifest } from '../../../server/storage/schema.js';
import { bundleStorageThread } from '../../../server/storage/thread-bundle.mjs';
import { fixtureSchema, plainSchema } from './fixtures/fixture-domain.js';

export const FIXTURE_ENTRY = fileURLToPath(new URL('./fixtures/fixture-thread.ts', import.meta.url));
export const fixtureManifest = storageManifest([fixtureSchema, plainSchema]);

let fixture: Promise<CapturedStorageBundle> | undefined;
/** The fixture thread (fixture and plain domains), bundled once per test process like a build would. */
export function fixtureBundle(): Promise<CapturedStorageBundle> {
  return fixture ??= bundleStorageThread(FIXTURE_ENTRY).then(artifact => storageBundleFromArtifact(JSON.stringify(artifact), 'artifact') as CapturedStorageBundle);
}
/** A bundle made from changed source text, consistent with its own hash, as a mixed-up build would produce. */
export function alteredBundle(bundle: CapturedStorageBundle, change: (source: string) => string): StorageBundleCapture {
  const source = change(bundle.source);
  if (source === bundle.source) throw new Error('The change did not alter the bundle.');
  return storageBundleFromArtifact(JSON.stringify({ format: 'tower-storage-thread-bundle/1', source, sourceHash: createHash('sha256').update(source).digest('hex') }), 'artifact');
}

/** A fresh owner-only state directory, removed after the test. */
export async function stateDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tower-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Opens a fixture-thread client and closes it after the test. */
export async function openFixture(t: TestContext, dir: string, options: Partial<StorageClientOptions> = {}): Promise<StorageClient> {
  const client = await openStorage({ stateDir: dir, bundle: await fixtureBundle(), manifest: fixtureManifest, ...options });
  t.after(() => client.close());
  return client;
}

export interface FileFacts { sha256: string; size: number; mode: number; mtimeMs: number; ino: number }
/** Every file and folder under `dir` with its bytes and metadata, to prove nothing changed. */
export async function filesUnder(dir: string): Promise<Record<string, FileFacts | 'dir' | 'link'>> {
  const facts: Record<string, FileFacts | 'dir' | 'link'> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = await lstat(path);
    const key = relative(dir, path);
    if (info.isSymbolicLink()) facts[key] = 'link';
    else if (info.isDirectory()) facts[key] = 'dir';
    else facts[key] = { sha256: createHash('sha256').update(await readFile(path)).digest('hex'), size: info.size, mode: info.mode & 0o777, mtimeMs: info.mtimeMs, ino: info.ino };
  }
  return facts;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
