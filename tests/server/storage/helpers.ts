import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { storageBundleFromArtifact, type CapturedStorageBundle, type StorageBundleCapture } from '../../../server/storage/bundle.js';
import { openStorage, type StorageClient, type StorageClientOptions } from '../../../server/storage/client.js';
import { StorageCommandError } from '../../../server/storage/contract.js';
import { storageManifest } from '../../../server/storage/schema.js';
import { bundleStorageThread } from '../../../server/storage/thread-bundle.mjs';
import { fixtureSchema, fixtureSchemaA, plainSchema } from './fixtures/fixture-domain.js';

export const FIXTURE_ENTRY = fileURLToPath(new URL('./fixtures/fixture-thread.ts', import.meta.url));
/** Release A of the fixture domain (no cutover), with the same tables and contracts. */
export const FIXTURE_A_ENTRY = fileURLToPath(new URL('./fixtures/fixture-thread-a.ts', import.meta.url));
export const fixtureManifest = storageManifest([fixtureSchema, plainSchema]);
export const fixtureManifestA = storageManifest([fixtureSchemaA, plainSchema]);

/** The database files in a state directory. */
export const DATABASE = 'state.sqlite';
export const databasePath = (dir: string, suffix: '' | '-wal' | '-shm' = '') => join(dir, `${DATABASE}${suffix}`);

const captureEntry = (entry: string) => bundleStorageThread(entry).then(artifact => storageBundleFromArtifact(JSON.stringify(artifact), 'artifact') as CapturedStorageBundle);
let fixture: Promise<CapturedStorageBundle> | undefined;
let fixtureA: Promise<CapturedStorageBundle> | undefined;
/** The fixture thread (fixture and plain domains), bundled once per test process like a build would. */
export function fixtureBundle(): Promise<CapturedStorageBundle> {
  return fixture ??= captureEntry(FIXTURE_ENTRY);
}
export function fixtureBundleA(): Promise<CapturedStorageBundle> {
  return fixtureA ??= captureEntry(FIXTURE_A_ENTRY);
}

/** A bundle text whose first line states the hash of the rest, as thread-bundle.mjs writes it. */
export function statedSource(body: string): { source: string; sourceHash: string } {
  const sourceHash = createHash('sha256').update(body).digest('hex');
  return { source: `var __TOWER_STORAGE_SOURCE_HASH__ = ${JSON.stringify(sourceHash)};\n${body}`, sourceHash };
}
export const bundleBody = (bundle: CapturedStorageBundle) => bundle.source.slice(bundle.source.indexOf('\n') + 1);
/** A bundle made from changed thread code, consistent with its own hash, as a mixed-up build would produce. */
export function alteredBundle(bundle: CapturedStorageBundle, change: (body: string) => string): StorageBundleCapture {
  const body = change(bundleBody(bundle));
  if (body === bundleBody(bundle)) throw new Error('The change did not alter the bundle.');
  return storageBundleFromArtifact(JSON.stringify({ format: 'tower-storage-thread-bundle/2', ...statedSource(body) }), 'artifact');
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

/** Asserts a StorageCommandError with these fields. */
export const rejectsWith = (promise: Promise<unknown>, expected: Partial<Record<'phase' | 'code' | 'disposition' | 'retryable' | 'commandId', unknown>>) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof StorageCommandError, String(error));
    for (const [key, value] of Object.entries(expected)) assert.equal((error as unknown as Record<string, unknown>)[key], value, `${key}: ${(error as Error).message}`);
    return true;
  });

/** Ends a process that holds the database without closing it, as a crash or power loss would: its WAL and shm stay. */
export async function crashWith(database: string, sql: string): Promise<void> {
  const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(database)}); db.exec(${JSON.stringify(sql)}); process.kill(process.pid, 'SIGKILL');`;
  await new Promise<void>(resolve => execFile(process.execPath, ['-e', script], () => resolve()));
}
