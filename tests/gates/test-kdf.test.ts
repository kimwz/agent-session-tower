import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { parse, root, sourceFiles } from '../helpers/source-scan.js';

/**
 * The vault tests' fast password hash never reaches anything real: only server/secrets/crypto.ts (which defines it) and
 * tests/helpers/fast-kdf.ts name the Argon2id replacement, and only test files import that helper, never server code,
 * shared helpers or the fixture generators whose vaults must open in production.
 */
const HOOK = 'replaceArgon2ForTests';
const HOOK_FILES = ['server/secrets/crypto.ts', 'tests/helpers/fast-kdf.ts'];
const HELPER = 'tests/helpers/fast-kdf';

/** Identifiers named `name` in code (not strings or comments). */
function names(path: string, text: string, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => { if (ts.isIdentifier(node) && node.text === name) count++; ts.forEachChild(node, visit); };
  visit(parse(path, text));
  return count;
}

/** Relative module specifiers of one file, resolved to repo paths without extension. */
function imports(path: string, text: string): string[] {
  const found: string[] = [];
  const add = (specifier: string) => { if (specifier.startsWith('.')) found.push(posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.(js|ts)$/, '')); };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  return found;
}

test('only crypto.ts and the fast-kdf helper name the Argon2id replacement, and only test files import that helper', async () => {
  const files = await sourceFiles(['server', 'shared', 'client/src', 'scripts', 'tests']);
  assert.ok(files.has('server/secrets/crypto.ts') && files.has(`${HELPER}.ts`));
  const naming = [...files].filter(([path, text]) => text.includes(HOOK) && names(path, text, HOOK) > 0).map(([path]) => path).sort();
  assert.deepEqual(naming, [...HOOK_FILES].sort());
  const importing = [...files].filter(([path, text]) => text.includes('fast-kdf') && imports(path, text).includes(HELPER)).map(([path]) => path);
  assert.ok(importing.length > 0);
  assert.deepEqual(importing.filter(path => !path.endsWith('.test.ts')), [], 'fast-kdf is imported by test files only');
  for (const name of (await readdir(join(root, 'scripts'))).filter(name => /\.[cm]?js$/.test(name))) {
    const text = await readFile(join(root, 'scripts', name), 'utf8');
    assert.ok(!text.includes(HOOK) && !text.includes('fast-kdf'), `scripts/${name}`);
  }
});
