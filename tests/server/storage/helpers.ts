import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { build } from 'esbuild';
import type { CapturedStorageBundle, StorageBuildContext } from '../../../server/storage/bundle.js';
import type { StorageClient, StorageClientOptions } from '../../../server/storage/client.js';
import type { StorageBuildManifest } from '../../../server/storage/contract.js';
import { storageManifest } from '../../../server/storage/schema.js';
import { buildIdentityModule, buildIdentityPlugin, bundleStorageThread, STORAGE_THREAD_ENTRY, type StorageThreadArtifact } from '../../../server/storage/thread-bundle.mjs';
import { fixtureSchema, fixtureSchemaA, plainSchema } from './fixtures/fixture-domain.js';
import type * as Parent from './fixtures/parent.js';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export const FIXTURE_ENTRY = here('./fixtures/fixture-thread.ts');
/** Release A of the fixture domain (no cutover), with the same tables and contracts. */
export const FIXTURE_A_ENTRY = here('./fixtures/fixture-thread-a.ts');
export const fixtureManifest = storageManifest([fixtureSchema, plainSchema]);
export const fixtureManifestA = storageManifest([fixtureSchemaA, plainSchema]);

const FAULTS = ['protocol', 'app-version', 'forged-manifest', 'source-hash', 'no-sqlite', 'exit-on-check', 'exit-on-open', 'change-on-check', 'change-exit-on-check', 'stall-on-check', 'swap-on-open'] as const;
export type FaultThread = typeof FAULTS[number];
/** Every thread source the fixture build trusts, each with the contract its thread must declare. */
const SOURCES: Record<'fixture' | 'fixture-a' | 'production' | FaultThread, [entry: string, manifest: StorageBuildManifest]> = {
  fixture: [FIXTURE_ENTRY, fixtureManifest],
  'fixture-a': [FIXTURE_A_ENTRY, fixtureManifestA],
  production: [STORAGE_THREAD_ENTRY, storageManifest()],
  ...Object.fromEntries(FAULTS.map(name => [name, [here(`./fixtures/faults/${name}.ts`), fixtureManifest]])) as Record<FaultThread, [string, StorageBuildManifest]>,
};
export type ThreadSource = keyof typeof SOURCES;

/**
 * The fixture parent: server/storage compiled (bundled) with build-identity.ts replaced by the fixed sources above,
 * as a server build replaces it with its one source. It is a module instance of its own: the storage this test process
 * imports from server/ directly still trusts nothing but a canonical capture. Built once per test process.
 */
async function fixtureParent(): Promise<{ storage: typeof Parent; artifacts: Record<ThreadSource, StorageThreadArtifact>; file: string }> {
  const artifacts = Object.fromEntries(await Promise.all(Object.entries(SOURCES).map(async ([name, [entry]]) => [name, await bundleStorageThread(entry)]))) as Record<ThreadSource, StorageThreadArtifact>;
  const contexts = (Object.keys(SOURCES) as ThreadSource[]).map(name => ({ sourceHash: artifacts[name].sourceHash, manifest: SOURCES[name][1] }));
  const out = mkdtempSync(join(tmpdir(), 'tower-storage-parent-'));
  process.once('exit', () => rmSync(out, { recursive: true, force: true }));
  const outfile = join(out, 'parent.mjs');
  await build({
    entryPoints: [here('./fixtures/parent.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    plugins: [buildIdentityPlugin(buildIdentityModule({ contexts }))],
  });
  return { storage: await import(pathToFileURL(outfile).href) as typeof Parent, artifacts, file: outfile };
}
const parent = await fixtureParent();
/** The storage of the fixture build: tests take every storage value (functions, classes, storageFs) from here. */
export const storage = parent.storage;
/** The compiled fixture parent, for a child process that must run as the same build. */
export const fixtureParentFile = parent.file;
export const artifactOf = (source: ThreadSource): StorageThreadArtifact => parent.artifacts[source];

/** A thread source of the fixture build, read through its artifact parser like a build reads its own. */
export function threadBundle(source: ThreadSource): CapturedStorageBundle {
  const bundle = storage.storageBundleFromArtifact(JSON.stringify(artifactOf(source)), 'artifact');
  assert.ok(bundle.ok, `${source}: ${!bundle.ok && bundle.failure.message}`);
  return bundle;
}
/** The fixture thread (fixture and plain domains). */
export const fixtureBundle = async () => threadBundle('fixture');
export const fixtureBundleA = async () => threadBundle('fixture-a');
/** The trusted context of a fixture build source, which recovery steps take. */
export function contextOf(source: ThreadSource = 'fixture'): StorageBuildContext {
  const context = storage.storageBuildContext(threadBundle(source));
  assert.ok(context.ok);
  return context;
}

/** The database files in a state directory. */
export const DATABASE = 'state.sqlite';
export const databasePath = (dir: string, suffix: '' | '-wal' | '-shm' = '') => join(dir, `${DATABASE}${suffix}`);

/** A bundle text whose first line states the hash of the rest, as thread-bundle.mjs writes it. */
export function statedSource(body: string): { source: string; sourceHash: string } {
  const sourceHash = createHash('sha256').update(body).digest('hex');
  return { source: `var __TOWER_STORAGE_SOURCE_HASH__ = ${JSON.stringify(sourceHash)};\n${body}`, sourceHash };
}
export const bundleBody = (bundle: { source: string }) => bundle.source.slice(bundle.source.indexOf('\n') + 1);
/** The artifact of changed thread code, consistent with its own hash, as a mixed-up or foreign build would produce. No build trusts it. */
export function rehashedArtifact(bundle: { source: string }, change: (body: string) => string): string {
  const body = change(bundleBody(bundle));
  if (body === bundleBody(bundle)) throw new Error('The change did not alter the bundle.');
  return JSON.stringify({ format: 'tower-storage-thread-bundle/2', ...statedSource(body) });
}

/** A fresh owner-only state directory, removed after the test. */
export async function stateDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tower-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Opens a client of the fixture build (the fixture thread unless `bundle` says otherwise) and closes it after the test. */
export async function openFixture(t: TestContext, dir: string, options: Partial<StorageClientOptions> = {}): Promise<StorageClient> {
  const client = await storage.openStorage({ stateDir: dir, bundle: threadBundle('fixture'), ...options });
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

/** Asserts a StorageCommandError of the fixture build with these fields. */
export const rejectsWith = (promise: Promise<unknown>, expected: Partial<Record<'phase' | 'code' | 'disposition' | 'retryable' | 'commandId', unknown>>) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof storage.StorageCommandError, String(error));
    for (const [key, value] of Object.entries(expected)) assert.equal((error as unknown as Record<string, unknown>)[key], value, `${key}: ${(error as Error).message}`);
    return true;
  });

/** Ends a process that holds the database without closing it, as a crash or power loss would: its WAL and shm stay. */
export async function crashWith(database: string, sql: string): Promise<void> {
  const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(database)}); db.exec(${JSON.stringify(sql)}); process.kill(process.pid, 'SIGKILL');`;
  await new Promise<void>(resolve => execFile(process.execPath, ['-e', script], () => resolve()));
}
