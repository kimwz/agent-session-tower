/** A Tower state folder kept as a fixture: each file's path under the folder and its bytes, base64. */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

export type StateSnapshot = Record<string, string>;

export async function snapshotState(stateDir: string): Promise<StateSnapshot> {
  const files: StateSnapshot = {};
  const walk = async (folder: string): Promise<void> => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[relative(stateDir, path)] = (await readFile(path)).toString('base64');
    }
  };
  await walk(stateDir);
  return files;
}

export async function writeState(stateDir: string, files: StateSnapshot): Promise<void> {
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(stateDir, name)), { recursive: true, mode: 0o700 });
    await writeFile(join(stateDir, name), Buffer.from(bytes, 'base64'), { mode: 0o600 });
  }
}
