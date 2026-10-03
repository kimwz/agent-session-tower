import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

/** The repository root, for gates that read the source tree. */
export const root = join(import.meta.dirname, '..', '..');

/** Every `.ts`/`.tsx` file under the given folders, keyed by repo-relative path with `/` separators. */
export async function sourceFiles(dirs: readonly string[] = ['server', 'shared', 'client/src']): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.set(path, await readFile(join(root, path), 'utf8'));
    }
  };
  for (const dir of dirs) await walk(dir.split('\\').join('/'));
  return files;
}

/** A TypeScript syntax tree, so gates match code and never text inside strings or comments. */
export function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
