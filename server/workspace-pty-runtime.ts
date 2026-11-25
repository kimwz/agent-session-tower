import { createRequire } from 'node:module';
import { getAsset, isSea } from 'node:sea';
import { access, chmod, cp, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createPrivateTemporary } from './temporary/directories.js';
import { dirname, join } from 'node:path';
import type { TerminalSpawnOptions, WorkspacePty } from './workspace-terminals.js';

const require = createRequire(import.meta.url);
/** What Tower uses of node-pty and its prebuilt twin. Typed here, since either package may be absent where Tower is built. */
export interface PtyModule { spawn(file: string, args: string[], options: TerminalSpawnOptions): WorkspacePty }
/** A loaded module, and the helper it spawns through when that helper lives in a private temporary copy. */
export interface LoadedPty { module: PtyModule; helper?: string }
type Loaded = LoadedPty;

/** Loads once, and again when the private copy's helper has gone. Exported for tests. */
export function ptyLoader(load: () => Promise<Loaded>, helperPresent: (path: string) => Promise<boolean> = present): () => Promise<PtyModule> {
  let loading: Promise<Loaded> | undefined;
  const cached = (): Promise<Loaded> => {
    const current: Promise<Loaded> = loading ??= load().catch(error => { if (loading === current) loading = undefined; throw error; });
    return current;
  };
  return async () => {
    const current = cached();
    const loaded = await current;
    if (!loaded.helper || await helperPresent(loaded.helper)) return loaded.module;
    // macOS deletes temporary files nothing used for days, so a long-lived terminal host loses its private copy's
    // helper and could open no shell until restarted. Copy again.
    if (loading === current) loading = undefined;
    return (await cached()).module;
  };
}

/** Native PTY assets need real paths, even when Tower runs as a single executable. */
export const loadWorkspacePty = ptyLoader(() => load());

async function present(path: string): Promise<boolean> {
  // best-effort: a missing or non-executable helper is the answer itself.
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function privateRuntime(): Promise<Awaited<ReturnType<typeof createPrivateTemporary>>> {
  const temporary = await createPrivateTemporary('pty');
  const { directory } = temporary;
  await chmod(directory, 0o700);
  process.once('exit', () => { try { temporary.releaseOnExit(); } catch (error) { console.error('PTY temporary runtime cleanup failed:', error); } });
  return temporary;
}

async function load(): Promise<Loaded> {
  if (isSea()) {
    const temporary = await privateRuntime();
    const { directory } = temporary;
    try {
      const files = JSON.parse(getAsset('pty/manifest.json', 'utf8')) as string[];
      for (const file of files) {
        // The manifest is generated at build time, never supplied by a browser.
        if (file.startsWith('/') || file.split('/').some(part => part === '..')) throw new Error('Invalid embedded PTY path.');
        const destination = join(directory, file);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, Buffer.from(getAsset(`pty/${file}`)), { mode: file.endsWith('spawn-helper') ? 0o700 : 0o600 });
      }
      const helper = files.find(file => file.endsWith('spawn-helper'));
      return { module: require(join(directory, 'lib/index.js')), ...(helper ? { helper: join(directory, helper) } : {}) };
    } catch (error) { await temporary.release(); throw error; }
  }
  // node-pty is built where it is installed; where it could not be (Linux without a compiler), the same library with
  // prebuilt binaries takes its place.
  try { return await installed('node-pty'); }
  catch (error) {
    try { return await installed('@lydell/node-pty'); } catch { throw error; }
  }
}

async function installed(name: string): Promise<Loaded> {
  const entry = require.resolve(name);
  if (process.platform === 'darwin') {
    // Some npm distributions omit the executable bit on the macOS helper. Set it where Tower may write the
    // installation (its own runtime); a read-only installation gets a private copy instead.
    const root = dirname(dirname(entry));
    for (const native of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
      const helper = join(root, native, 'spawn-helper');
      try { await access(helper); } catch { continue; }
      if (await present(helper)) break;
      // best-effort: a read-only installation keeps its mode and gets the private copy below.
      try { await chmod(helper, 0o755); } catch { /* Read-only installation. */ }
      if (!await present(helper)) {
        const temporary = await privateRuntime();
        const { directory } = temporary;
        try {
          await cp(join(root, 'lib'), join(directory, 'lib'), { recursive: true });
          await cp(join(root, native), join(directory, native), { recursive: true });
          const copy = join(directory, native, 'spawn-helper');
          await chmod(copy, 0o700);
          return { module: require(join(directory, 'lib/index.js')), helper: copy };
        } catch (error) { await temporary.release(); throw error; }
      }
      break;
    }
  }
  return { module: require(entry) };
}
