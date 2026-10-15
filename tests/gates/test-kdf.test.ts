import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { isTestFile, mentions, parse, relativeImports, scriptFiles } from '../helpers/source-scan.js';

/**
 * The tests' fast password hashes never reach anything real: only the module that owns a hash names its test-only
 * replacement, next to the one helper that installs it (server/secrets/crypto.ts and tests/helpers/fast-kdf.ts for the
 * vault's Argon2id; server/auth/store.ts, server/backup/crypto.ts and tests/helpers/fast-scrypt.ts for the sign-in and
 * backup scrypt), and only test files import those helpers, never server code, shared helpers, scripts or the fixture
 * generators whose vaults and backups must open in production.
 *
 * The same goes for tests/helpers/skip-fsync.ts, which turns file flushes into no-ops for one test process: test files
 * only, and never a test of what a disk keeps (the durability tests below, or any test that watches flushes itself).
 *
 * Every script is read, whatever its extension (.ts, .tsx, .mts, .js, .mjs, .cjs …) and however deep.
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
/** This gate names the hooks itself, in its lists and fixtures. */
const SELF = 'tests/gates/test-kdf.test.ts';
const DIRS = ['server', 'shared', 'client/src', 'scripts', 'tests'];

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

/** Who names `hook`, apart from this gate. */
const naming = (files: Map<string, string>, hook: string) => [...files].filter(([path, text]) => path !== SELF && mentions(path, text, hook) > 0).map(([path]) => path).sort();
/** Who imports `helper` (a repo path without extension). */
const importing = (files: Map<string, string>, helper: string) => [...files].filter(([path, text]) => text.includes(helper.split('/').at(-1)!) && relativeImports(path, text).includes(helper)).map(([path]) => path).sort();

/** What the checks must refuse, as small files of every kind. */
const FIXTURES = new Map([
  ['scripts/fixture-build.mjs', "import { fastKdf } from '../tests/helpers/fast-kdf.js';\nimport '../tests/helpers/skip-fsync.js';\n"],
  ['scripts/fixture-old.cjs', "const fast = require('../tests/helpers/fast-scrypt.js');\nrequire('../tests/helpers/skip-fsync');\n"],
  ['server/fixture-hook.js', "export const hooks = { 'replaceArgon2ForTests': () => {} };\n"],
  ['server/deep/fixture-access.mts', "import * as crypto from '../secrets/crypto.js';\ncrypto['replaceAuthScryptForTests']?.();\n"],
  ['shared/fixture-type.tsx', "export type Hook = typeof import('../server/backup/crypto.js')['replaceBackupScryptForTests'];\nawait import('../tests/helpers/fast-kdf.js');\n"],
  ['tests/server/storage/durability.test.ts', "import '../../helpers/skip-fsync.js';\n"],
  ['tests/server/fixture-watch.test.mjs', "import '../helpers/skip-fsync.js';\nimport fs from 'node:fs';\nfs.fsyncSync(1);\n"],
]);

test('the checks below refuse every kind of script that names a hook or imports a fast helper, at any depth', () => {
  assert.deepEqual(naming(FIXTURES, 'replaceArgon2ForTests'), ['server/fixture-hook.js']);
  assert.deepEqual(naming(FIXTURES, 'replaceAuthScryptForTests'), ['server/deep/fixture-access.mts']);
  assert.deepEqual(naming(FIXTURES, 'replaceBackupScryptForTests'), ['shared/fixture-type.tsx']);
  assert.deepEqual(importing(FIXTURES, 'tests/helpers/fast-kdf'), ['scripts/fixture-build.mjs', 'shared/fixture-type.tsx']);
  assert.deepEqual(importing(FIXTURES, 'tests/helpers/fast-scrypt'), ['scripts/fixture-old.cjs']);
  const skipping = importing(FIXTURES, SKIP_FSYNC);
  assert.deepEqual(skipping, ['scripts/fixture-build.mjs', 'scripts/fixture-old.cjs', 'tests/server/fixture-watch.test.mjs', 'tests/server/storage/durability.test.ts']);
  assert.deepEqual(skipping.filter(path => !isTestFile(path)), ['scripts/fixture-build.mjs', 'scripts/fixture-old.cjs']);
  assert.deepEqual(skipping.filter(path => DURABILITY.includes(path)), ['tests/server/storage/durability.test.ts']);
  assert.deepEqual(flushNames('tests/server/fixture-watch.test.mjs', FIXTURES.get('tests/server/fixture-watch.test.mjs')!), ['fsyncSync']);
});

test('only the owning module and its fast helper name a password hash replacement, and only test files import those helpers', async () => {
  const files = await scriptFiles(DIRS);
  for (const [hook, owners] of Object.entries(HOOKS)) {
    for (const owner of owners) assert.ok(files.has(owner), owner);
    assert.deepEqual(naming(files, hook), [...owners].sort(), hook);
  }
  for (const helper of HELPERS) {
    const users = importing(files, helper);
    assert.ok(users.length > 0, helper);
    assert.deepEqual(users.filter(path => !isTestFile(path)), [], `${helper} is imported by test files only`);
  }
});

test('skip-fsync is imported by test files only, never by a durability test or a test that watches flushes', async () => {
  const files = await scriptFiles(DIRS);
  for (const path of DURABILITY) assert.ok(files.has(path), path);
  const users = importing(files, SKIP_FSYNC);
  assert.ok(users.length > 0);
  assert.deepEqual(users.filter(path => !isTestFile(path)), [], 'skip-fsync is imported by test files only');
  assert.deepEqual(users.filter(path => DURABILITY.includes(path)), [], 'durability tests keep real flushes');
  assert.deepEqual(users.map(path => [path, flushNames(path, files.get(path)!)]).filter(([, found]) => found.length > 0), [], 'a test that watches flushes keeps real ones');
});
