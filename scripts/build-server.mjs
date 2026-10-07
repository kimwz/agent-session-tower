// Compiles the server into a fresh folder and swaps it into dist/, so outputs of sources that moved or disappeared
// (tsc never deletes them, and dist/ is what gets packaged) are gone, while dist/server/index.js is never missing.
// A running worker starts every turn's tool servers from that file; a build that emptied dist/ first left turns
// starting in that window without their tools. A failed build leaves the previous one in place.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStorageThreadArtifact } from '../server/storage/thread-bundle.mjs';

const DIRECTORIES = ['shared', 'server'];

/**
 * Moves every built file over its predecessor, each rename replacing the old file in one step, then removes what the
 * new build no longer has. No file that both builds share is ever absent.
 */
export async function swapInto(dist, staging, directories = DIRECTORIES) {
  try {
    for (const name of directories) {
      const built = new Set();
      for (const file of await files(join(staging, name))) {
        built.add(file);
        await mkdir(dirname(join(dist, name, file)), { recursive: true });
        await rename(join(staging, name, file), join(dist, name, file));
      }
      for (const file of await files(join(dist, name))) if (!built.has(file)) await rm(join(dist, name, file), { force: true });
      await removeEmpty(join(dist, name));
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function files(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return entries.filter(entry => !entry.isDirectory()).map(entry => relative(directory, join(entry.parentPath, entry.name)));
}

async function removeEmpty(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await removeEmpty(join(directory, entry.name));
  if (!(await readdir(directory)).length) await rmdir(directory);
}

async function build() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dist = join(root, 'dist');
  await mkdir(dist, { recursive: true });
  // Inside dist/ so the renames stay on one filesystem.
  const staging = await mkdtemp(join(dist, '.build-'));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.server.json'), '--outDir', staging], { stdio: 'inherit' });
  if (result.status !== 0) {
    await rm(staging, { recursive: true, force: true });
    process.exit(result.status ?? 1);
  }
  // The storage thread as one script beside the compiled server, and the compiled build identity naming it as the one
  // source the worker trusts; a worker captures it once when it starts and refuses any other.
  try { await writeStorageThreadArtifact(staging); } catch (error) {
    await rm(staging, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  }
  await swapInto(dist, staging);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await build();
