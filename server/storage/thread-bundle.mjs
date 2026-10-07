// Bundles the storage thread into one self-contained script, the way every build captures it: scripts/build-server.mjs
// writes it next to the compiled server (dist/server/storage/generated/thread-bundle.json) and replaces the compiled
// build identity with the source it trusts (dist/server/storage/build-identity.js), scripts/build-executable.mjs
// bundles both into the standalone executable (storageThreadPlugin), and a development checkout (tsx) bundles it in
// memory when the worker starts. The worker runs the captured text with `new Worker(source, { eval: true })`, so no
// build depends on a JS entry file staying in place while it runs. Plain JavaScript because the build scripts run
// without tsx.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORAGE_BUNDLE_FORMAT = 'tower-storage-thread-bundle/2';
/** The variable the bundle's first line sets to its own source hash, which the thread reports in its hello. */
export const STORAGE_SOURCE_HASH_VARIABLE = '__TOWER_STORAGE_SOURCE_HASH__';
/** Where build-server.mjs puts the artifact, relative to the compiled output folder. */
export const STORAGE_BUNDLE_ARTIFACT = 'server/storage/generated/thread-bundle.json';
/** The compiled module build-server.mjs replaces with the source it trusts, relative to the compiled output folder. */
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
 * The text a build puts in place of server/storage/build-identity.ts: `{ contexts: [{ sourceHash, manifest? }], artifact? }`
 * (see BuildStorageIdentity there).
 */
export function buildIdentityModule(identity) {
  return `export const BUILD_STORAGE = ${JSON.stringify(identity)};\n`;
}

const BUILD_IDENTITY_SOURCE = /[\\/]server[\\/]storage[\\/]build-identity\.ts$/;
/** An esbuild plugin that compiles `moduleText` in place of server/storage/build-identity.ts; a build that never loads that module fails. */
export function buildIdentityPlugin(moduleText) {
  return {
    name: 'tower-storage-build-identity',
    setup(build) {
      let loaded = false;
      build.onLoad({ filter: BUILD_IDENTITY_SOURCE }, () => { loaded = true; return { contents: moduleText, loader: 'js' }; });
      build.onEnd(result => {
        if (!loaded && !result.errors.length) return { errors: [{ text: 'server/storage/build-identity.ts was not part of the build, so its storage identity could not be fixed.' }] };
        return undefined;
      });
    },
  };
}

/**
 * Writes the artifact under `outputRoot` (a dist/ or staging folder) and replaces the compiled build-identity module
 * there with the artifact's source, so the compiled worker trusts exactly this artifact. Answers the artifact.
 */
export async function writeStorageThreadArtifact(outputRoot, entry) {
  const artifact = await bundleStorageThread(entry);
  const path = join(outputRoot, STORAGE_BUNDLE_ARTIFACT);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(artifact));
  const identity = join(outputRoot, STORAGE_BUILD_IDENTITY_MODULE);
  await mkdir(dirname(identity), { recursive: true });
  await writeFile(identity, buildIdentityModule({ contexts: [{ sourceHash: artifact.sourceHash }] }));
  return { path, artifact };
}

/** The esbuild plugin a bundled server (the standalone executable) is built with: the thread text, and its source as the one this build trusts. */
export async function storageThreadPlugin(entry) {
  const artifact = await bundleStorageThread(entry);
  return buildIdentityPlugin(buildIdentityModule({ contexts: [{ sourceHash: artifact.sourceHash }], artifact: JSON.stringify(artifact) }));
}
