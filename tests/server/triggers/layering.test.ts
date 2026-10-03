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

/**
 * Where a file other than once.ts writes or aliases the ledger of an engine state, as `file:line text`.
 *
 * The ledger is recognised by its declaration (`onceConsumed` in `interface EngineState`), so access through a type
 * alias, `Pick` or other mapped type, or brackets with a string literal is found too. Below the ledger, a chain of
 * entry and field accesses (`ledger[id].at`) must not be assigned, updated or deleted. The ledger itself may only be
 * read element by element, copied by spread, listed with `Object.keys/entries/values`, handed to `readLedger`, or
 * compared; anything else (an alias, an argument, a destructured name) is reported. A state literal may set its own
 * ledger only in state.ts's `empty()`, and only to `{}`.
 *
 * Limits: an entry read by value (`const entry = ledger[id]`, `trigger.consumed = ledger[id]`) is an ordinary object
 * and its later writes are not followed; a computed key other than a string literal (`state[key]`) and destructuring
 * assignment to existing names (`({ onceConsumed: x } = state)`) are not recognised.
 */
export function ledgerWrites(checker: ts.TypeChecker, file: ts.SourceFile): string[] {
  const found: string[] = [];
  const declaredInEngineState = (symbol: ts.Symbol | undefined) => !!symbol?.declarations?.some(declaration =>
    ts.isPropertySignature(declaration) && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === 'EngineState');
  const ledgerOf = (type: ts.Type) => declaredInEngineState(type.getProperty('onceConsumed'));
  const ledger = (node: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(node) && node.name.text === 'onceConsumed' && ledgerOf(checker.getTypeAtLocation(node.expression)))
    || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'onceConsumed' && ledgerOf(checker.getTypeAtLocation(node.expression)));
  const at = (node: ts.Node) => `${file.fileName.slice(root.length + 1)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${node.getText(file).slice(0, 80)}`;
  const assigned = (node: ts.Node) => ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  const updated = (node: ts.Node) => ts.isDeleteExpression(node.parent) || ((ts.isPrefixUnaryExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent))
    && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.parent.operator));
  /** The node with the parentheses, `!` and `as` around it that do not change what it is. */
  const outer = (node: ts.Node): ts.Node => ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isSatisfiesExpression(node.parent) ? outer(node.parent) : node;
  /** The empty state: the object literal `empty` returns in state.ts, with an empty ledger. */
  const emptyLedger = (property: ts.PropertyAssignment) => {
    if (!file.fileName.endsWith(`${TRIGGERS}/state.ts`) || !ts.isObjectLiteralExpression(property.initializer) || property.initializer.properties.length) return false;
    let body: ts.Node = property.parent.parent;
    while (ts.isParenthesizedExpression(body)) body = body.parent;
    return ts.isArrowFunction(body) && ts.isVariableDeclaration(body.parent) && body.parent.name.getText(file) === 'empty' && ts.isVariableStatement(body.parent.parent.parent) && body.parent.parent.parent.parent === file;
  };
  const visit = (node: ts.Node): void => {
    if (ledger(node)) {
      const top = outer(node);
      const parent = top.parent;
      // A chain of entry and field accesses below the ledger, ending where it is used.
      let end: ts.Node = top;
      while ((ts.isElementAccessExpression(end.parent) || ts.isPropertyAccessExpression(end.parent)) && end.parent.expression === end) end = outer(end.parent);
      const copied = ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent);
      const listed = ts.isCallExpression(parent) && /^Object\.(keys|entries|values)$/.test(parent.expression.getText(file));
      // Only a saved file's ledger is handed on, as what once.readLedger copies from.
      const read = ts.isCallExpression(parent) && parent.expression.getText(file) === 'readLedger' && parent.arguments[0] === top;
      const compared = ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind);
      if (end !== top ? assigned(end) || updated(end) : !(copied || listed || read || compared)) found.push(at(node));
    }
    // A destructured ledger is an alias of it.
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && (node.propertyName ?? node.name).getText(file) === 'onceConsumed' && ledgerOf(checker.getTypeAtLocation(node.parent))) found.push(at(node));
    // A new state object that sets its own ledger, other than the empty state.
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText(file) === 'onceConsumed' && ts.isObjectLiteralExpression(node.parent)) {
      const contextual = checker.getContextualType(node.parent);
      if (contextual && ledgerOf(contextual) && !(ts.isPropertyAssignment(node) && emptyLedger(node))) found.push(at(node));
    }
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

/** What the ledger check finds in a fixture read in place of a file among the trigger modules (fixture.ts unless named). */
function fixtureWrites(source: string, base = 'fixture.ts'): string[] {
  const host = ts.createCompilerHost({});
  const name = join(root, TRIGGERS, base);
  const original = host.getSourceFile;
  host.getSourceFile = (file, version) => file === name ? ts.createSourceFile(file, source, version, true) : original.call(host, file, version);
  const checked = ts.createProgram([name], { strict: true, noEmit: true, types: [] }, host);
  return ledgerWrites(checked.getTypeChecker(), checked.getSourceFile(name)!).map(line => line.replace(/^\S+:\d+ /, ''));
}

test('the ledger check also finds bracket access, aliases by type or destructuring, entry writes and a ledger set outside empty()', () => {
  const source = `
interface EngineState { onceConsumed: Record<string, { at: string }>; triggers: unknown[] }
type Alias = EngineState;
declare const state: EngineState;
declare const aliased: Alias;
declare const picked: Pick<EngineState, 'onceConsumed'>;
state['onceConsumed']['a'] = { at: '' };
const viaBracket = state['onceConsumed'];
viaBracket['b'] = { at: '' };
const { onceConsumed } = state;
const { onceConsumed: renamed } = state;
aliased.onceConsumed['c'] = { at: '' };
picked.onceConsumed['d'] = { at: '' };
state.onceConsumed['e'].at = '';
const empty = (): EngineState => ({ onceConsumed: {}, triggers: [] });
const read = state['onceConsumed']['f'];
const listed = Object.keys(state['onceConsumed']);
(state.onceConsumed!)['g'] = { at: '' };
delete state['onceConsumed']['h'];
`;
  assert.deepEqual(fixtureWrites(source), [
    "state['onceConsumed']", "state['onceConsumed']", 'onceConsumed', 'onceConsumed: renamed', 'aliased.onceConsumed', 'picked.onceConsumed', 'state.onceConsumed', 'onceConsumed: {}', 'state.onceConsumed', "state['onceConsumed']",
  ]);
});

test('in state.ts only the empty() literal may set the ledger, and only to {}', () => {
  const source = `
interface EngineState { version: 1; onceConsumed: Record<string, { at: string }> }
export const empty = (): EngineState => ({ version: 1, onceConsumed: {} });
export const seeded = (): EngineState => ({ version: 1, onceConsumed: {} });
export function inner() { const empty = (): EngineState => ({ version: 1, onceConsumed: {} }); return empty; }
`;
  assert.deepEqual(fixtureWrites(source, 'state.ts'), ['onceConsumed: {}', 'onceConsumed: {}']);
  assert.deepEqual(fixtureWrites("interface EngineState { onceConsumed: Record<string, { at: string }> }\nexport const empty = (): EngineState => ({ onceConsumed: { a: { at: '' } } });", 'state.ts'), ["onceConsumed: { a: { at: '' } }"]);
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

test('no trigger module imports the engine or the service but the service itself', async () => {
  const files = await sourceFiles([TRIGGERS]);
  const upward = [...files].flatMap(([path, text]) => importEdges(path, text).filter(edge => /-> server\/triggers\/(engine|service)$/.test(edge) && !edge.startsWith(`${TRIGGERS}/service ->`)));
  assert.deepEqual(upward, []);
});

test('dispatch alone owns the claims being submitted and the close retries; polls alone the request locks', async () => {
  const files = await sourceFiles([TRIGGERS]);
  const owners = (name: string) => [...files].filter(([, text]) => new RegExp(`\\bthis\\.${name}\\b`).test(text)).map(([path]) => path).sort();
  assert.deepEqual(owners('submitting'), [`${TRIGGERS}/dispatch.ts`]);
  assert.deepEqual(owners('closeRetries'), [`${TRIGGERS}/dispatch.ts`]);
  assert.deepEqual(owners('closingIssues'), [`${TRIGGERS}/dispatch.ts`]);
  assert.deepEqual(owners('polling'), [`${TRIGGERS}/polls.ts`]);
});
