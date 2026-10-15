import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
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

/** Every kind of script a gate reads: TypeScript and JavaScript, as ES modules or CommonJS. */
export const SCRIPT_FILE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/;

/**
 * Every script git tracks under the given folders (any SCRIPT_FILE extension, at any depth), keyed by repo-relative
 * path with `/` separators. Only tracked files: what a test leaves in the tree while it runs (a generated fixture) is
 * not part of the source, so a gate's answer never depends on what runs beside it. Without git the tree is walked.
 */
export async function scriptFiles(dirs: readonly string[]): Promise<Map<string, string>> {
  let paths: string[];
  try {
    const { stdout } = await promisify(execFile)('git', ['ls-files', '-z', '--', ...dirs], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    paths = stdout.split('\0').filter(path => SCRIPT_FILE.test(path));
  } catch {
    const walked: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
        if (entry.name === 'node_modules') continue;
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) await walk(path);
        else if (SCRIPT_FILE.test(entry.name)) walked.push(path);
      }
    };
    for (const dir of dirs) await walk(dir.split('\\').join('/'));
    paths = walked;
  }
  const files = new Map<string, string>();
  // A tracked file deleted in the working tree is not read.
  for (const path of paths) { const text = await readFile(join(root, path), 'utf8').catch(() => undefined); if (text !== undefined) files.set(path, text); }
  return files;
}

/** A syntax tree, so gates match code and never text inside strings or comments. */
export function parse(path: string, text: string): ts.SourceFile {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * How often code names `name`: as an identifier, or as a string used as a property name (`{ 'name': … }`,
 * `x['name']`, `{ name } = …` included), never in other strings or comments.
 */
export function mentions(path: string, text: string, name: string): number {
  if (!text.includes(name)) return 0;
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) ? node.text === name : ts.isStringLiteralLike(node) && node.text === name && propertyName(node)) count++;
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  return count;
}

/** A string in the place of a property name: a key, `{ ['name']: … }`, `x['name']`, `{ 'name': y } = …` or `T['name']`. */
function propertyName(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  if (ts.isComputedPropertyName(parent)) return true;
  if (ts.isElementAccessExpression(parent)) return parent.argumentExpression === node;
  if (ts.isBindingElement(parent)) return parent.propertyName === node;
  if (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
    || ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) return parent.name === node;
  return ts.isLiteralTypeNode(parent) && ts.isIndexedAccessTypeNode(parent.parent);
}

/** Relative module specifiers of one file (imports, re-exports, `import()`, `import type`, `require()`), resolved to repo paths without extension. */
export function relativeImports(path: string, text: string): string[] {
  const found: string[] = [];
  const add = (specifier: string) => { if (specifier.startsWith('.')) found.push(posix.normalize(posix.join(posix.dirname(path), specifier)).replace(SCRIPT_FILE, '')); };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) add(node.moduleReference.expression.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  return found;
}

/** A test file, which the runner loads as a test: `*.test.ts`, `*.test.mjs` and the like. */
export const isTestFile = (path: string) => /\.test\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/.test(path);
