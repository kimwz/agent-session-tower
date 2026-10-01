import { isSea, getAsset } from 'node:sea';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep, relative } from 'node:path';

/**
 * The same URL policy applies to filesystem builds and embedded executable assets. `name` is the file
 * actually read, relative to the UI root, so different URLs for one file share it.
 */
export async function readWebAsset(clientDir: string, path: string): Promise<{ content: Buffer; extension: string; name: string } | undefined> {
  const root = resolve(clientDir);
  let file = resolve(root, `.${path}`);
  if ((!file.startsWith(root + sep) && file !== root) || path.includes('\\') || path.includes('\0')) return undefined;
  if (path === '/' || !extname(path)) file = resolve(root, 'index.html');
  const name = relative(root, file).split(sep).join('/');
  try {
    if (isSea()) return { content: Buffer.from(getAsset(`web/${name}`)), extension: extname(file), name };
    if (!(await stat(file)).isFile()) return undefined;
    return { content: await readFile(file), extension: extname(file), name };
  } catch { return undefined; }
}
