import { isSea, getAsset } from 'node:sea';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep, relative } from 'node:path';

/** The same URL policy applies to filesystem builds and embedded executable assets. */
export async function readWebAsset(clientDir: string, path: string): Promise<{ content: Buffer; extension: string } | undefined> {
  const root = resolve(clientDir);
  let file = resolve(root, `.${path}`);
  if ((!file.startsWith(root + sep) && file !== root) || path.includes('\\') || path.includes('\0')) return undefined;
  if (path === '/' || !extname(path)) file = resolve(root, 'index.html');
  try {
    if (isSea()) {
      const key = `web/${relative(root, file).split(sep).join('/')}`;
      return { content: Buffer.from(getAsset(key)), extension: extname(file) };
    }
    if (!(await stat(file)).isFile()) return undefined;
    return { content: await readFile(file), extension: extname(file) };
  } catch { return undefined; }
}
