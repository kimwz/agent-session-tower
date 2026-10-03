import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { importEdges } from '../../gates/import-boundaries.test.js';
import { root, sourceFiles } from '../../helpers/source-scan.js';

/**
 * The trigger engine's ownership rules, checked on its source:
 * - only once.ts writes the once consumption ledger (`EngineState.onceConsumed`): elsewhere it is only read, element by
 *   element or as a copy, never assigned, updated, deleted from or handed on under another name;
 * - limits.ts imports nothing, and state, once and audit refer to each other at runtime only downward
 *   (state → once → audit); the way back is `import type` only;
 * - store.ts writes the file only through serializeState.
 */
const TRIGGERS = 'server/triggers';

async function program(): Promise<ts.Program> {
  const files = (await readdir(join(root, TRIGGERS))).filter(name => name.endsWith('.ts')).map(name => join(root, TRIGGERS, name));
  return ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true, types: ['node'] });
}

/** Where a file other than once.ts writes or aliases the ledger of an engine state, as `file:line text`. */
export function ledgerWrites(checker: ts.TypeChecker, file: ts.SourceFile): string[] {
  const found: string[] = [];
  const engineState = (node: ts.Expression) => checker.getTypeAtLocation(node).getSymbol()?.getName() === 'EngineState';
  const at = (node: ts.Node) => `${file.fileName.slice(root.length + 1)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${node.getText(file).slice(0, 80)}`;
  const assigned = (node: ts.Node) => ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  const updated = (node: ts.Node) => ts.isDeleteExpression(node.parent) || ((ts.isPrefixUnaryExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent))
    && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.parent.operator));
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'onceConsumed' && engineState(node.expression)) {
      const parent = node.parent;
      // A read of one entry, a copy by spread, or a list of its keys or entries is a read; the entry itself must not be written.
      const element = ts.isElementAccessExpression(parent) && parent.expression === node;
      const copied = ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent);
      const listed = ts.isCallExpression(parent) && /^Object\.(keys|entries|values)$/.test(parent.expression.getText(file));
      // Only a saved file's ledger is handed on, as what once.readLedger copies from.
      const read = ts.isCallExpression(parent) && parent.expression.getText(file) === 'readLedger' && parent.arguments[0] === node;
      const compared = ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind);
      if (element ? assigned(parent) || updated(parent) : !(copied || listed || read || compared)) found.push(at(node));
    }
    // A new state object that sets its own ledger, other than the empty state.
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText(file) === 'onceConsumed' && ts.isObjectLiteralExpression(node.parent)
      && checker.getContextualType(node.parent)?.getSymbol()?.getName() === 'EngineState' && !(file.fileName.endsWith('/state.ts') && node.parent.getText(file).startsWith('{ version: 1, onceConsumed: {}'))) found.push(at(node));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test('only once.ts writes the once consumption ledger', async () => {
  const checked = await program();
  const checker = checked.getTypeChecker();
  const writes = checked.getSourceFiles().filter(file => file.fileName.startsWith(join(root, TRIGGERS)) && !file.fileName.endsWith('/once.ts')).flatMap(file => ledgerWrites(checker, file));
  assert.deepEqual(writes, []);
});

test('the ledger check finds assignments, updates, deletes and aliases, and lets reads through', () => {
  const source = `
interface EngineState { onceConsumed: Record<string, { at: string }>; triggers: unknown[] }
declare const state: EngineState;
state.onceConsumed = {};
state.onceConsumed['a'] = { at: '' };
state.onceConsumed['a'] ??= { at: '' };
delete state.onceConsumed['a'];
const ledger = state.onceConsumed;
const fresh: EngineState = { onceConsumed: {}, triggers: [] };
const read = state.onceConsumed['a'];
const copy = { ...state.onceConsumed };
const keys = Object.keys(state.onceConsumed);
const other = { onceConsumed: 1 }.onceConsumed;
const absent = state.onceConsumed === undefined;
declare function readLedger(saved: unknown, state: EngineState): boolean;
readLedger(state.onceConsumed, state);
declare function mutate(ledger: unknown): void;
mutate(state.onceConsumed);
`;
  const host = ts.createCompilerHost({});
  const name = join(root, TRIGGERS, 'fixture.ts');
  const original = host.getSourceFile;
  host.getSourceFile = (file, version) => file === name ? ts.createSourceFile(file, source, version, true) : original.call(host, file, version);
  const checked = ts.createProgram([name], { strict: true, noEmit: true, types: [] }, host);
  const lines = ledgerWrites(checked.getTypeChecker(), checked.getSourceFile(name)!).map(line => line.replace(/^\S+:\d+ /, ''));
  assert.deepEqual(lines, ['state.onceConsumed', 'state.onceConsumed', 'state.onceConsumed', 'state.onceConsumed', 'state.onceConsumed', 'onceConsumed: {}', 'state.onceConsumed']);
});

test('limits.ts is a leaf, and state, once and audit refer back to each other only as types', async () => {
  const files = await sourceFiles([TRIGGERS]);
  const runtime = (path: string) => {
    const text = files.get(path)!;
    const typeOnly = new Set([...text.matchAll(/^import type \{[^}]*\} from '(\.[^']+)'/gm)].map(match => match[1]!.replace(/\.js$/, '')));
    return importEdges(path, text).map(edge => edge.split(' -> ')[1]!).filter(to => !typeOnly.has(`./${to.split('/').pop()}`));
  };
  assert.deepEqual(importEdges(`${TRIGGERS}/limits.ts`, files.get(`${TRIGGERS}/limits.ts`)!), []);
  assert.ok(!runtime(`${TRIGGERS}/once.ts`).includes(`${TRIGGERS}/state`), 'once.ts reads the state type only');
  assert.ok(!runtime(`${TRIGGERS}/audit.ts`).some(to => [`${TRIGGERS}/state`, `${TRIGGERS}/once`].includes(to)), 'audit.ts is below state and once');
  assert.ok(!runtime(`${TRIGGERS}/store.ts`).includes(`${TRIGGERS}/service`));
});

test('the store writes the engine file only through serializeState', async () => {
  const text = (await sourceFiles([TRIGGERS])).get(`${TRIGGERS}/store.ts`)!;
  assert.match(text, /writePrivateJson\(this\.path, data\)/);
  assert.match(text, /const data = serializeState\(draft\);/);
  assert.doesNotMatch(text, /JSON\.stringify\(/, 'no other encoding of the state');
});
