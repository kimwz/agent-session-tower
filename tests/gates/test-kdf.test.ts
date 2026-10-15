import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { parse, root, sourceFiles } from '../helpers/source-scan.js';

/**
 * The tests' fast password hashes never reach anything real: only the module that owns a hash names its test-only
 * replacement, next to the one helper that installs it (server/secrets/crypto.ts and tests/helpers/fast-kdf.ts for the
 * vault's Argon2id; server/auth/store.ts, server/backup/crypto.ts and tests/helpers/fast-scrypt.ts for the sign-in and
 * backup scrypt), and only test files import those helpers, never server code, shared helpers or the fixture
 * generators whose vaults and backups must open in production.
 *
 * The same goes for tests/helpers/skip-fsync.ts, which turns file flushes into no-ops for one test process: test files
 * only, and never a test of what a disk keeps (the durability tests below, or any test that watches flushes itself).
 */
const HOOKS: Record<string, string[]> = {
  'replaceArgon2ForTests': ['server/secrets/crypto.ts', 'tests/helpers/fast-kdf.ts'],
  'replaceAuthScryptForTests': ['server/auth/store.ts', 'tests/helpers/fast-scrypt.ts'],
  'replaceBackupScryptForTests': ['server/backup/crypto.ts', 'tests/helpers/fast-scrypt.ts'],
};
const HELPERS = ['tests/helpers/fast-kdf', 'tests/helpers/fast-scrypt'];
const SKIP_FSYNC = 'tests/helpers/skip-fsync';
/** Tests of what survives a crash or a failed flush; they need real flushes. */
const DURABILITY = [
  'tests/server/storage/durability.test.ts', 'tests/server/storage/recovery.test.ts', 'tests/server/storage/owner.test.ts',
  'tests/server/workspace-files.test.ts', 'tests/server/stores/private-json.test.ts', 'tests/server/permissions/storage-pending.test.ts',
  'tests/server/sessions/retention-storage.test.ts', 'tests/server/link/storage-offline-backup.test.ts', 'tests/server/runs/durable-runner.test.ts',
];
/** Names through which a test watches or fails flushes. */
const FLUSHES = new Set(['sync', 'datasync', 'syncDirectory', 'fsync', 'fdatasync', 'fsyncSync', 'fdatasyncSync']);

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

/** Flush calls a test makes, replaces or mocks: `x.sync()`, `x.sync = …`, `mock.method(x, 'sync', …)`, `{ fsync }` imports. */
function flushNames(path: string, text: string): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && FLUSHES.has(node.name.text)
      && ((ts.isCallExpression(node.parent) && node.parent.expression === node) || (ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken))) found.add(node.name.text);
    if (ts.isStringLiteral(node) && FLUSHES.has(node.text) && ts.isCallExpression(node.parent)) found.add(node.text);
    if (ts.isImportSpecifier(node) && FLUSHES.has(node.name.text)) found.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  return [...found];
}

test('only the owning module and its fast helper name a password hash replacement, and only test files import those helpers', async () => {
  const files = await sourceFiles(['server', 'shared', 'client/src', 'scripts', 'tests']);
  for (const [hook, owners] of Object.entries(HOOKS)) {
    for (const owner of owners) assert.ok(files.has(owner), owner);
    const naming = [...files].filter(([path, text]) => text.includes(hook) && names(path, text, hook) > 0).map(([path]) => path).sort();
    assert.deepEqual(naming, [...owners].sort(), hook);
  }
  for (const helper of HELPERS) {
    const importing = [...files].filter(([path, text]) => text.includes(posix.basename(helper)) && imports(path, text).includes(helper)).map(([path]) => path);
    assert.ok(importing.length > 0, helper);
    assert.deepEqual(importing.filter(path => !path.endsWith('.test.ts')), [], `${helper} is imported by test files only`);
  }
  for (const name of (await readdir(join(root, 'scripts'))).filter(name => /\.[cm]?js$/.test(name))) {
    const text = await readFile(join(root, 'scripts', name), 'utf8');
    for (const word of [...Object.keys(HOOKS), ...HELPERS.map(helper => posix.basename(helper))]) assert.ok(!text.includes(word), `scripts/${name}: ${word}`);
  }
});

test('skip-fsync is imported by test files only, never by a durability test or a test that watches flushes', async () => {
  const files = await sourceFiles(['server', 'shared', 'client/src', 'scripts', 'tests']);
  for (const path of DURABILITY) assert.ok(files.has(path), path);
  const importing = [...files].filter(([path, text]) => text.includes('skip-fsync') && imports(path, text).includes(SKIP_FSYNC)).map(([path]) => path);
  assert.ok(importing.length > 0);
  assert.deepEqual(importing.filter(path => !path.endsWith('.test.ts')), [], 'skip-fsync is imported by test files only');
  assert.deepEqual(importing.filter(path => DURABILITY.includes(path)), [], 'durability tests keep real flushes');
  assert.deepEqual(importing.map(path => [path, flushNames(path, files.get(path)!)]).filter(([, found]) => found.length > 0), [], 'a test that watches flushes keeps real ones');
});
