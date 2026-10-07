// Bundles the storage thread into one self-contained script, the way every build captures it: scripts/build-server.mjs
// writes it next to the compiled server (dist/server/storage/generated/thread-bundle.json) and fixes the hash its worker
// expects (dist/server/storage/build-identity.js), scripts/build-executable.mjs defines both into the standalone
// executable, and a development checkout (tsx) bundles it in memory when the worker starts. The worker runs the
// captured text with `new Worker(source, { eval: true })`, so no build depends on a JS entry file staying in place
// while it runs. Plain JavaScript because the build scripts run without tsx.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORAGE_BUNDLE_FORMAT = 'tower-storage-thread-bundle/2';
/** The identifier build-executable.mjs defines to the bundle artifact's JSON text. */
export const STORAGE_BUNDLE_DEFINE = '__TOWER_STORAGE_THREAD_BUNDLE__';
/** The identifier build-executable.mjs defines to the source hash the worker expects (see build-identity.ts). */
export const STORAGE_EXPECTED_HASH_DEFINE = '__TOWER_STORAGE_EXPECTED_SOURCE_HASH__';
/** The variable the bundle's first line sets to its own source hash, which the thread reports in its hello. */
export const STORAGE_SOURCE_HASH_VARIABLE = '__TOWER_STORAGE_SOURCE_HASH__';
/** Where build-server.mjs puts the artifact, relative to the compiled output folder. */
export const STORAGE_BUNDLE_ARTIFACT = 'server/storage/generated/thread-bundle.json';
/** The compiled module build-server.mjs replaces with the expected hash, relative to the compiled output folder. */
export const STORAGE_BUILD_IDENTITY_MODULE = 'server/storage/build-identity.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const STORAGE_THREAD_ENTRY = join(root, 'server/storage/thread/main.ts');

/**
 * Answers `{ format, source, sourceHash }`. `source` is one line `var __TOWER_STORAGE_SOURCE_HASH__ = "<hash>";`
 * followed by the bundled thread, and `sourceHash` is the sha256 of everything after that line. The same sources give
 * the same text (paths in it are relative to the repository), so the hash names the thread code. `entry` lets tests
 * bundle a thread with fixture domains.
 */
export async function bundleStorageThread(entry = STORAGE_THREAD_ENTRY) {
  const result = await build({
    entryPoints: [entry], absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22',
    sourcemap: false, legalComments: 'none', logLevel: 'silent', charset: 'utf8',
  });
  const body = result.outputFiles[0].text;
  // The thread may require Node built-ins only: an eval worker has no folder to resolve packages from.
  const outside = [...body.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map(match => match[1]).filter(name => !name.startsWith('node:'));
  if (outside.length) throw new Error(`The storage thread bundle requires modules other than node: built-ins: ${[...new Set(outside)].join(', ')}`);
  const sourceHash = createHash('sha256').update(body).digest('hex');
  return { format: STORAGE_BUNDLE_FORMAT, source: `var ${STORAGE_SOURCE_HASH_VARIABLE} = ${JSON.stringify(sourceHash)};\n${body}`, sourceHash };
}

/**
 * Writes the artifact under `outputRoot` (a dist/ or staging folder) and replaces the compiled build-identity module
 * there with the artifact's hash, so the compiled worker trusts exactly this artifact. Answers the artifact.
 */
export async function writeStorageThreadArtifact(outputRoot, entry) {
  const artifact = await bundleStorageThread(entry);
  const path = join(outputRoot, STORAGE_BUNDLE_ARTIFACT);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(artifact));
  const identity = join(outputRoot, STORAGE_BUILD_IDENTITY_MODULE);
  await mkdir(dirname(identity), { recursive: true });
  await writeFile(identity, `export const BUILD_STORAGE_SOURCE_HASH = ${JSON.stringify(artifact.sourceHash)};\n`);
  return { path, artifact };
}

/** esbuild `define` entries that put the artifact and the hash the worker expects into a bundled server (the standalone executable). */
export async function storageThreadDefine(entry) {
  const artifact = await bundleStorageThread(entry);
  return { [STORAGE_BUNDLE_DEFINE]: JSON.stringify(JSON.stringify(artifact)), [STORAGE_EXPECTED_HASH_DEFINE]: JSON.stringify(artifact.sourceHash) };
}
