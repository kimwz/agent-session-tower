import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Leftover temporary files of an atomic write in `directory`, whatever their naming. */
export async function temporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter(name => /\.tmp$|^\.[^.]/.test(name));
}

/**
 * Puts a non-empty folder where `path` is saved, so the next atomic write creates its temporary file and then
 * fails to rename it into place. Answers a function that puts the saved file back.
 */
export async function blockRename(path: string): Promise<() => Promise<void>> {
  const aside = `${path}.aside`;
  await rename(path, aside).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  await mkdir(path);
  await writeFile(join(path, 'occupied'), '');
  return async () => {
    await rm(path, { recursive: true, force: true });
    await rename(aside, path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  };
}
