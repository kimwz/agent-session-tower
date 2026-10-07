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
let loading: Promise<PtyModule> | undefined;

/** Native PTY assets need real paths, even when Tower runs as a single executable. */
export function loadWorkspacePty(): Promise<PtyModule> {
  return loading ??= load().catch(error => { loading = undefined; throw error; });
}

async function privateRuntime(): Promise<Awaited<ReturnType<typeof createPrivateTemporary>>> {
  const temporary = await createPrivateTemporary('pty');
  const { directory } = temporary;
  await chmod(directory, 0o700);
  process.once('exit', () => { try { temporary.releaseOnExit(); } catch (error) { console.error('PTY temporary runtime cleanup failed:', error); } });
  return temporary;
}

async function load(): Promise<PtyModule> {
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
      return require(join(directory, 'lib/index.js'));
    } catch (error) { await temporary.release(); throw error; }
  }
  // node-pty is built where it is installed; where it could not be (Linux without a compiler), the same library with
  // prebuilt binaries takes its place.
  try { return await installed('node-pty'); }
  catch (error) {
    try { return await installed('@lydell/node-pty'); } catch { throw error; }
  }
}

async function installed(name: string): Promise<PtyModule> {
  const entry = require.resolve(name);
  if (process.platform === 'darwin') {
    // Some npm distributions omit the executable bit on the macOS helper.
    // Keep read-only/global installations untouched; prepare a private copy.
    const root = dirname(dirname(entry));
    for (const native of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
      const helper = join(root, native, 'spawn-helper');
      try { await access(helper); } catch { continue; }
      try { await access(helper, constants.X_OK); } catch {
        const temporary = await privateRuntime();
        const { directory } = temporary;
        try {
          await cp(join(root, 'lib'), join(directory, 'lib'), { recursive: true });
          await cp(join(root, native), join(directory, native), { recursive: true });
          await chmod(join(directory, native, 'spawn-helper'), 0o700);
          return require(join(directory, 'lib/index.js'));
        } catch (error) { await temporary.release(); throw error; }
      }
      break;
    }
  }
  return require(entry);
}
