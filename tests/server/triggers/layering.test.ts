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
const OPTIONS: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true, types: ['node'] };

async function program(): Promise<ts.Program> {
  const files = (await readdir(join(root, TRIGGERS))).filter(name => name.endsWith('.ts')).map(name => join(root, TRIGGERS, name));
  return ts.createProgram(files, OPTIONS);
}

/** What an expression holds of the ledger: the ledger itself, a new record holding its entries, or one entry. */
type Held = 'ledger' | 'copy' | 'entry';

/**
 * Where a file other than once.ts writes the ledger of an engine state or lets it or one of its entries escape, as
 * `file:line reason text`.
 *
 * The ledger is found by its declaration (`onceConsumed` in `interface EngineState`), through `.onceConsumed`, a
 * string-literal bracket, or a computed key whose type is the literal `'onceConsumed'` (also through type aliases and
 * mapped types such as Pick). An entry is an element of the ledger or of a spread copy of it (`{ ...ledger }` is a new
 * record, but its entries are still the ledger's). A value carries every kind it may hold through ?:, ||, && and ??,
 * and so does a local name it is bound to (followed within the file); a use is allowed only if every kind allows it.
 * A name that may hold the ledger itself is reported (`alias`), and writes through it are reported as well.
 *
 * Reported: assigning, updating or deleting the ledger or one of its slots, or a field of an entry (`write`);
 * destructuring the ledger out of a state, by declaration or into existing names (`destructure`); a state literal that
 * sets the ledger anywhere but state.ts's `empty()`, and there to anything but `{}` (`literal`); and any use of the
 * ledger, a copy or an entry other than these reads (`escape`): an element or a primitive field, a condition or `!`,
 * a comparison or `in`, a spread copy, `Object.keys`, an argument to a function declared in once.ts (the owner).
 *
 * Limits: a key typed only as `string` is not resolved; flows across files, through a whole state handed to a function,
 * and nested destructuring assignment are not followed.
 */
export function ledgerWrites(checker: ts.TypeChecker, file: ts.SourceFile): string[] {
  const found: string[] = [];
  const report = (reason: string, node: ts.Node) => found.push(`${file.fileName.slice(root.length + 1)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${reason} ${node.getText(file).slice(0, 80)}`);
  const declaredInEngineState = (symbol: ts.Symbol | undefined) => !!symbol?.declarations?.some(declaration =>
    ts.isPropertySignature(declaration) && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === 'EngineState');
  const ledgerOf = (type: ts.Type) => declaredInEngineState(type.getProperty('onceConsumed'));
  /** A key that is, or by its type can only be among, `'onceConsumed'`. */
  const ledgerKey = (key: ts.Expression | ts.PropertyName): boolean => {
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) { if (key.text === 'onceConsumed') return true; if (ts.isIdentifier(key) && !ts.isExpression(key)) return false; }
    if (ts.isComputedPropertyName(key)) return ledgerKey(key.expression);
    if (!ts.isExpression(key) || ts.isStringLiteralLike(key)) return false;
    const type = checker.getTypeAtLocation(key);
    return (type.isUnion() ? type.types : [type]).some(item => item.isStringLiteral() && item.value === 'onceConsumed');
  };
  const wrapper = (node: ts.Node): node is ts.ParenthesizedExpression | ts.NonNullExpression | ts.AsExpression | ts.SatisfiesExpression | ts.TypeAssertion =>
    ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);
  const inner = (node: ts.Expression): ts.Expression => wrapper(node) ? inner(node.expression) : node;
  const outer = (node: ts.Node): ts.Node => wrapper(node.parent) ? outer(node.parent) : node;
  const assigning = (kind: ts.SyntaxKind) => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  const assigned = (node: ts.Node) => ts.isBinaryExpression(node.parent) && node.parent.left === node && assigning(node.parent.operatorToken.kind);
  const updated = (node: ts.Node) => ts.isDeleteExpression(node.parent) || ((ts.isPrefixUnaryExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent))
    && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.parent.operator));
  const variable = (node: ts.Identifier) => ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
  /**
   * Every kind a value may hold, through every branch of ?:, ||, && and ??: an empty set is ordinary code. Kinds only
   * ever grow, so a value that may be a copy or an entry is judged as both.
   */
  type Kinds = ReadonlySet<Held>;
  const NONE: Kinds = new Set();
  const union = (...sets: Kinds[]) => new Set(sets.flatMap(set => [...set])) as Kinds;
  /** Names bound to the ledger, copies or entries, with every kind they may hold. */
  const aliases = new Map<ts.Symbol, Kinds>();
  const held = (raw: ts.Expression): Kinds => {
    const node = inner(raw);
    // An element of the ledger or of a copy is an entry; an element of an entry is one of its plain fields.
    const element = (expression: ts.Expression): Kinds => { const kinds = held(expression); return kinds.has('ledger') || kinds.has('copy') ? new Set(['entry']) : NONE; };
    if (ts.isIdentifier(node)) { const symbol = variable(node); return (symbol && aliases.get(symbol)) ?? NONE; }
    if (ts.isPropertyAccessExpression(node)) {
      return union(node.name.text === 'onceConsumed' && ledgerOf(checker.getTypeAtLocation(node.expression)) ? new Set(['ledger']) : NONE, element(node.expression));
    }
    if (ts.isElementAccessExpression(node)) {
      return union(ledgerKey(node.argumentExpression) && ledgerOf(checker.getTypeAtLocation(node.expression)) ? new Set(['ledger']) : NONE, element(node.expression));
    }
    if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isSpreadAssignment(property) && (held(property.expression).has('ledger') || held(property.expression).has('copy')))) return new Set(['copy']);
    if (ts.isConditionalExpression(node)) return union(held(node.whenTrue), held(node.whenFalse));
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return union(held(node.left), held(node.right));
    return NONE;
  };
  // Follow values into names until no name may hold anything new (three kinds at most, so this ends).
  for (let changed = true; changed;) {
    changed = false;
    const bind = (name: ts.Node, value: ts.Expression) => {
      const symbol = ts.isIdentifier(name) ? checker.getSymbolAtLocation(name) : undefined;
      if (!symbol) return;
      const before = aliases.get(symbol) ?? NONE;
      const after = union(before, held(value));
      if (after.size > before.size) { aliases.set(symbol, after); changed = true; }
    };
    const scan = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) bind(node.name, node.initializer);
      if (ts.isBinaryExpression(node) && assigning(node.operatorToken.kind)) bind(inner(node.left), node.right);
      ts.forEachChild(node, scan);
    };
    scan(file);
  }
  /** Where a value that may hold the ledger, a copy or an entry is used; a use is allowed only if every kind allows it. */
  const use = (node: ts.Expression, kinds: Kinds) => {
    const top = outer(node);
    const parent = top.parent;
    // An element or field written: only a slot of a copy may be, so every kind must be a copy.
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === top) {
      if ((assigned(outer(parent)) || updated(outer(parent))) && [...kinds].some(kind => kind !== 'copy')) report('write', parent);
      return;
    }
    if (assigned(top) || updated(top)) {
      const slot = inner(top as ts.Expression);
      // A name bound again is not the value; an element or field written is judged by what holds it (above).
      if (ts.isIdentifier(slot)) return;
      if ((ts.isElementAccessExpression(slot) || ts.isPropertyAccessExpression(slot)) && held(slot.expression).size) return;
      report('write', top);
      return;
    }
    // Bound to a name: followed; a name that may hold the ledger itself is reported as well.
    const binding = ts.isVariableDeclaration(parent) && parent.initializer === top ? parent.name
      : ts.isBinaryExpression(parent) && parent.right === top && assigning(parent.operatorToken.kind) ? inner(parent.left) : undefined;
    if (binding) {
      if (!ts.isIdentifier(binding)) report(ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding) || ts.isObjectLiteralExpression(binding) || ts.isArrayLiteralExpression(binding) ? 'destructure' : 'escape', top);
      else if (kinds.has('ledger')) report('alias', top);
      return;
    }
    // Copied by spread: a copy of the ledger or a copy is a new copy, checked as its own value; a copy of an entry is free.
    if (ts.isSpreadAssignment(parent)) return;
    // Read as a condition, compared, or listed by its keys.
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return;
    if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === top) return;
    if (ts.isForStatement(parent) && parent.condition === top) return;
    if (ts.isConditionalExpression(parent) && parent.condition === top) return;
    if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)) return;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === top) return;
    if (ts.isExpressionStatement(parent)) return;
    // An operand of ?:, ||, && or ?? holds what its expression holds, which is checked as its own value.
    if (ts.isConditionalExpression(parent) || (ts.isBinaryExpression(parent) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind))) return;
    if (ts.isCallExpression(parent) && parent.arguments.includes(top as ts.Expression)) {
      if (!kinds.has('entry') && parent.expression.getText(file) === 'Object.keys') return;
      // The owner of the ledger may be handed it.
      if (checker.getResolvedSignature(parent)?.getDeclaration()?.getSourceFile().fileName.endsWith(`${TRIGGERS}/once.ts`)) return;
    }
    report('escape', top);
  };
  /** The empty state: the object literal `empty` returns in state.ts, with an empty ledger. */
  const emptyLedger = (property: ts.PropertyAssignment) => {
    if (!file.fileName.endsWith(`${TRIGGERS}/state.ts`) || !ts.isObjectLiteralExpression(property.initializer) || property.initializer.properties.length) return false;
    let body: ts.Node = property.parent.parent;
    while (ts.isParenthesizedExpression(body)) body = body.parent;
    return ts.isArrowFunction(body) && ts.isVariableDeclaration(body.parent) && body.parent.name.getText(file) === 'empty' && ts.isVariableStatement(body.parent.parent.parent) && body.parent.parent.parent.parent === file;
  };
  const named = (node: ts.Node) => (ts.isVariableDeclaration(node.parent) || ts.isBindingElement(node.parent) || ts.isParameter(node.parent) || ts.isPropertyAssignment(node.parent)
    || ts.isFunctionDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent)) && (node.parent as { name?: ts.Node }).name === node;
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) && !wrapper(node) && !(ts.isIdentifier(node) && (named(node) || (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)))) {
      const kinds = held(node);
      if (kinds.size) use(node, kinds);
    }
    // The ledger destructured out of a state: by declaration, or into existing names.
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && ledgerKey(node.propertyName ?? node.name as ts.Identifier) && ledgerOf(checker.getTypeAtLocation(node.parent))) report('destructure', node);
    if (ts.isObjectLiteralExpression(node) && ts.isBinaryExpression(outer(node).parent) && (outer(node).parent as ts.BinaryExpression).left === outer(node)
      && (outer(node).parent as ts.BinaryExpression).operatorToken.kind === ts.SyntaxKind.EqualsToken && ledgerOf(checker.getTypeAtLocation((outer(node).parent as ts.BinaryExpression).right))) {
      for (const property of node.properties) if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ledgerKey(property.name)) report('destructure', property);
    }
    // A new state object that sets its own ledger, other than the empty state.
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent) && ledgerKey(node.name)) {
      const contextual = checker.getContextualType(node.parent);
      if (contextual && ledgerOf(contextual) && !(ts.isPropertyAssignment(node) && emptyLedger(node))) report('literal', node);
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
import { readLedger } from './once.js';
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
readLedger(state.onceConsumed, state);
declare function mutate(ledger: unknown): void;
mutate(state.onceConsumed);
`;
  assert.deepEqual(fixtureWrites(source), ['write state.onceConsumed', "write state.onceConsumed['a']", "write state.onceConsumed['a']", "write state.onceConsumed['a']", 'alias state.onceConsumed',
    'literal onceConsumed: {}', 'escape state.onceConsumed']);
});

/** What the ledger check finds in a fixture read in place of a file among the trigger modules (fixture.ts unless named). */
function fixtureWrites(source: string, base = 'fixture.ts'): string[] {
  const host = ts.createCompilerHost({});
  const name = join(root, TRIGGERS, base);
  const original = host.getSourceFile;
  host.getSourceFile = (file, version) => file === name ? ts.createSourceFile(file, source, version, true) : original.call(host, file, version);
  const checked = ts.createProgram([name], OPTIONS, host);
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
    "write state['onceConsumed']['a']", "alias state['onceConsumed']", "write viaBracket['b']", 'destructure onceConsumed', 'destructure onceConsumed: renamed', "write aliased.onceConsumed['c']",
    "write picked.onceConsumed['d']", "write state.onceConsumed['e'].at", 'literal onceConsumed: {}', "write (state.onceConsumed!)['g']", "write state['onceConsumed']['h']",
  ]);
});

test('the ledger check follows entries and copies under other names, destructuring into existing names and keys typed as the ledger', () => {
  const source = `
interface EngineState { onceConsumed: Record<string, { at: string; eventId?: string }>; triggers: unknown[] }
declare const state: EngineState;
declare let ledger: EngineState['onceConsumed'];
declare const id: string;
declare const trigger: { consumed?: { at: string } };
declare function use(value: unknown): void;
const entry = state.onceConsumed[id];
entry.at = '';
({ onceConsumed: ledger } = state);
ledger[id] = { at: '' };
const key = 'onceConsumed' as const;
state[key][id] = { at: '' };
const again = entry;
delete again.eventId;
trigger.consumed = state.onceConsumed[id];
use(state.onceConsumed[id]);
const values = Object.values(state.onceConsumed);
const copy = { ...state.onceConsumed };
copy[id] = { at: '' };
copy[id].at = '';
const own = { ...state.onceConsumed[id] };
own.at = '';
if (entry && state.onceConsumed[id]?.eventId !== 'x') use(entry.at);
const seen = state.onceConsumed[id] ? 'yes' : 'no';
const listed = Object.keys(copy);
`;
  assert.deepEqual(fixtureWrites(source), [
    'write entry.at', 'destructure onceConsumed: ledger', 'write state[key][id]', 'write again.eventId', 'escape state.onceConsumed[id]', 'escape state.onceConsumed[id]',
    'escape state.onceConsumed', 'write copy[id].at',
  ]);
});

test('a value that may be a copy or an entry (or the ledger) is judged by every kind it may hold', () => {
  const source = `
interface EngineState { onceConsumed: Record<string, { at: string; eventId?: string }>; triggers: unknown[] }
declare const state: EngineState;
declare const id: string;
declare const condition: boolean;
const mixed = condition ? { ...state.onceConsumed } : state.onceConsumed[id];
mixed.at = '';
const either = { ...state.onceConsumed } ?? state.onceConsumed[id];
either.at = '';
const or = { ...state.onceConsumed } || state.onceConsumed[id];
or.at = '';
const and = (condition && { ...state.onceConsumed }) || state.onceConsumed[id];
and.at = '';
const slots = condition ? { ...state.onceConsumed } : state.onceConsumed;
slots[id] = { at: '' };
const copies = condition ? { ...state.onceConsumed } : { ...state.onceConsumed };
copies[id] = { at: '' };
`;
  assert.deepEqual(fixtureWrites(source), ['write mixed.at', 'write either.at', 'write or.at', 'write and.at', 'alias condition ? { ...state.onceConsumed } : state.onceConsumed', 'write slots[id]']);
});

test('in state.ts only the empty() literal may set the ledger, and only to {}', () => {
  const source = `
interface EngineState { version: 1; onceConsumed: Record<string, { at: string }> }
export const empty = (): EngineState => ({ version: 1, onceConsumed: {} });
export const seeded = (): EngineState => ({ version: 1, onceConsumed: {} });
export function inner() { const empty = (): EngineState => ({ version: 1, onceConsumed: {} }); return empty; }
`;
  assert.deepEqual(fixtureWrites(source, 'state.ts'), ['literal onceConsumed: {}', 'literal onceConsumed: {}']);
  assert.deepEqual(fixtureWrites("interface EngineState { onceConsumed: Record<string, { at: string }> }\nexport const empty = (): EngineState => ({ onceConsumed: { a: { at: '' } } });", 'state.ts'), ["literal onceConsumed: { a: { at: '' } }"]);
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

test('the store requires SQL authority and sends guarded touched row batches; legacy serialization stays outside runtime writes', async () => {
  const text = (await sourceFiles([TRIGGERS])).get(`${TRIGGERS}/store.ts`)!;
  assert.match(text,/Triggers SQL authority is unavailable/);
  assert.match(text,/repository\.update\(changed,kind,undefined,this\.revision\)/);
  assert.doesNotMatch(text,/writePrivateJson|readPrivateBytes|serializeState|rowsOf|changesOf|structuredClone\(this\.current\)/);
  assert.match(text,/selected\(kind,id\)/,'business mutations declare their writable domain rows');
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
