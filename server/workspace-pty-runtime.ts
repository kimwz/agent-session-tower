import { createRequire } from 'node:module';
import { getAsset, isSea } from 'node:sea';
import { access, chmod, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { constants, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let loading: Promise<typeof import('node-pty')> | undefined;

/** Native PTY assets need real paths, even when Tower runs as a single executable. */
export function loadWorkspacePty(): Promise<typeof import('node-pty')> {
  return loading ??= load().catch(error => { loading = undefined; throw error; });
}

async function privateRuntime(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tower-pty-'));
  await chmod(directory, 0o700);
  process.once('exit', () => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows may still hold a loaded DLL. */ } });
  return directory;
}

async function load(): Promise<typeof import('node-pty')> {
  if (isSea()) {
    const directory = await privateRuntime();
    const files = JSON.parse(getAsset('pty/manifest.json', 'utf8')) as string[];
    for (const file of files) {
      // The manifest is generated at build time, never supplied by a browser.
      if (file.startsWith('/') || file.split('/').some(part => part === '..')) throw new Error('Invalid embedded PTY path.');
      const destination = join(directory, file);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, Buffer.from(getAsset(`pty/${file}`)), { mode: file.endsWith('spawn-helper') ? 0o700 : 0o600 });
    }
    return require(join(directory, 'lib/index.js'));
  }
  const entry = require.resolve('node-pty');
  if (process.platform === 'darwin') {
    // Some npm distributions omit the executable bit on the macOS helper.
    // Keep read-only/global installations untouched; prepare a private copy.
    const root = dirname(dirname(entry));
    for (const native of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
      const helper = join(root, native, 'spawn-helper');
      try { await access(helper); } catch { continue; }
      try { await access(helper, constants.X_OK); } catch {
        const directory = await privateRuntime();
        await cp(join(root, 'lib'), join(directory, 'lib'), { recursive: true });
        await cp(join(root, native), join(directory, native), { recursive: true });
        await chmod(join(directory, native, 'spawn-helper'), 0o700);
        return require(join(directory, 'lib/index.js'));
      }
      break;
    }
  }
  return require(entry);
}
