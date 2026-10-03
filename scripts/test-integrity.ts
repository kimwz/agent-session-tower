/**
 * Lists what a pull request takes away from the tests: removed tests, new skips, `.only`, and changed assertions.
 * Only a new unconditional skip fails (exit 1); the rest is for the reviewer. Usage:
 *   node --import tsx scripts/test-integrity.ts [--base <rev>]
 * Without `--base`, HEAD must be the pull request's merge commit, whose first parent is the base tip.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse } from '../tests/helpers/source-scan.js';

type Skip = 'none' | 'conditional' | 'unconditional';
export interface TestCase { id: string; skip: Skip; only: boolean }
export interface Assertion { start: number; end: number; source: string }
export interface AssertionChange { path: string; base: Assertion[]; head: Assertion[] }
export interface Integrity {
  exitCode: 0 | 1 | 2;
  removed: string[];
  unconditionalSkips: string[];
  conditionalSkips: string[];
  only: string[];
  assertions: AssertionChange[];
  snapshots: string[];
  report: string;
}

const TEST_CALLS = new Set(['test', 'it', 'describe', 'suite']);
const MODIFIERS = new Set(['skip', 'todo', 'only']);
const isTestFile = (path: string) => /\.test\.tsx?$/.test(path);

/** The test, describe and subtest calls of one file, with their nesting as `path::outer › inner`. */
export function testCases(path: string, text: string): TestCase[] {
  const file = parse(path, text);
  const found: TestCase[] = [];
  // `contexts` holds the parameter names of enclosing test bodies, so `t.test(…)` is a subtest and `pattern.test(…)` is not.
  const visit = (node: ts.Node, titles: string[], contexts: ReadonlySet<string>): void => {
    const call = ts.isCallExpression(node) ? testCall(node, contexts) : undefined;
    if (!call || !ts.isCallExpression(node)) { ts.forEachChild(node, child => visit(child, titles, contexts)); return; }
    const title = node.arguments[0];
    const name = !title ? '' : ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title) ? title.text : title.getText(file);
    const nested = [...titles, name];
    found.push({ id: `${path}::${nested.join(' › ')}`, skip: skipOf(node, call.modifier), only: call.modifier === 'only' || optionIs(node, 'only') === 'unconditional' });
    for (const argument of node.arguments.slice(1)) {
      const context = (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) ? argument.parameters[0]?.name : undefined;
      visit(argument, nested, context && ts.isIdentifier(context) ? new Set([...contexts, context.text]) : contexts);
    }
  };
  visit(file, [], new Set());
  return found;
}

/** `test(…)`, `it.skip(…)`, `describe.only(…)`, and a subtest `t.test(…)`. */
function testCall(call: ts.CallExpression, contexts: ReadonlySet<string>): { modifier?: string } | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return TEST_CALLS.has(callee.text) ? {} : undefined;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const target = callee.expression;
  if (ts.isIdentifier(target) && TEST_CALLS.has(target.text) && MODIFIERS.has(callee.name.text)) return { modifier: callee.name.text };
  if (ts.isIdentifier(target) && contexts.has(target.text) && callee.name.text === 'test') return {};
  return undefined;
}

/** `{ skip: true }` and `{ todo: 'why' }` always skip; any other expression decides at run time. */
function optionIs(call: ts.CallExpression, key: string): Skip {
  let result: Skip = 'none';
  for (const argument of call.arguments.slice(1)) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
      if (!property.name || property.name.getText() !== key) continue;
      const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      if (value.kind === ts.SyntaxKind.TrueKeyword || ((ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) && value.text)) return 'unconditional';
      if (value.kind === ts.SyntaxKind.FalseKeyword || ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) continue;
      result = 'conditional';
    }
  }
  return result;
}

function skipOf(call: ts.CallExpression, modifier: string | undefined): Skip {
  if (modifier === 'skip' || modifier === 'todo') return 'unconditional';
  const options = [optionIs(call, 'skip'), optionIs(call, 'todo')];
  if (options.includes('unconditional')) return 'unconditional';
  const body = call.arguments.slice(1).find((argument): argument is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
  const context = body?.parameters[0]?.name;
  if (body && context && ts.isIdentifier(context) && ts.isBlock(body.body)) {
    const skips = (node: ts.Node): boolean => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === context.text && ['skip', 'todo'].includes(node.expression.name.text);
    const direct = body.body.statements.some(statement => (ts.isExpressionStatement(statement) && skips(statement.expression))
      || (ts.isReturnStatement(statement) && !!statement.expression && skips(statement.expression)));
    if (direct) return 'unconditional';
    let nested = false;
    const find = (node: ts.Node): void => { if (nested) return; if (skips(node)) nested = true; else if (!ts.isFunctionLike(node)) ts.forEachChild(node, find); };
    ts.forEachChild(body.body, find);
    if (nested) return 'conditional';
  }
  return options.includes('conditional') ? 'conditional' : 'none';
}

/** Every assertion call with the lines its whole expression covers: `assert(…)`, `assert.x(…)`, `t.assert.x(…)`, `….snapshot(…)`. */
export function assertions(path: string, text: string): Assertion[] {
  const file = parse(path, text);
  const found: Assertion[] = [];
  const line = (position: number) => file.getLineAndCharacterOfPosition(position).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isAssertion(node.expression)) {
      found.push({ start: line(node.getStart(file)), end: line(node.end), source: node.getText(file) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function isAssertion(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === 'assert';
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text === 'snapshot') return true;
  const target = callee.expression;
  return (ts.isIdentifier(target) && target.text === 'assert') || (ts.isPropertyAccessExpression(target) && target.name.text === 'assert');
}

interface Hunk { base: [number, number]; head: [number, number] }

/** `@@ -a,b +c,d @@`: changed lines `a..a+b-1`; with a count of 0, the empty range between line `a` and `a+1`. */
export function hunks(diff: string): Hunk[] {
  const side = (start: string, count: string | undefined): [number, number] => {
    const from = Number(start), size = count === undefined ? 1 : Number(count);
    return size === 0 ? [from + 0.5, from + 0.5] : [from, from + size - 1];
  };
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match => ({ base: side(match[1]!, match[2]), head: side(match[3]!, match[4]) }));
}

const touches = (assertion: Assertion, [from, to]: [number, number]) => assertion.start <= to && assertion.end >= from;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Changed files as `[status, basePath, headPath]`; renames carry both paths. */
function changedFiles(cwd: string, base: string): Array<[string, string | undefined, string | undefined]> {
  const fields = git(cwd, ['diff', '--no-color', '--no-ext-diff', '--name-status', '-z', '-M50', base, 'HEAD', '--', 'tests']).split('\0');
  const files: Array<[string, string | undefined, string | undefined]> = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++]!;
    if (status.startsWith('R') || status.startsWith('C')) { files.push([status[0]!, fields[index]!, fields[index + 1]!]); index += 2; continue; }
    const path = fields[index++]!;
    files.push([status[0]!, status[0] === 'A' ? undefined : path, status[0] === 'D' ? undefined : path]);
  }
  return files;
}

function resolveBase(cwd: string, requested: string | undefined): string | undefined {
  if (requested) return git(cwd, ['merge-base', requested, 'HEAD']).trim();
  const parents = git(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1);
  return parents.length >= 2 ? parents[0] : undefined;
}

/** Compares the tests of HEAD with those at the base. */
export function checkTestIntegrity(cwd: string, requestedBase?: string): Integrity {
  const base = resolveBase(cwd, requestedBase);
  const empty = { removed: [], unconditionalSkips: [], conditionalSkips: [], only: [], assertions: [], snapshots: [] };
  if (!base) return { exitCode: 2, ...empty, report: 'HEAD has one parent: pass `--base <rev>` (for example `--base origin/main`), or run on the pull request merge commit.\n' };
  const before: TestCase[] = [], after: TestCase[] = [];
  const changes: AssertionChange[] = [];
  const snapshots: string[] = [];
  for (const [status, basePath, headPath] of changedFiles(cwd, base)) {
    const path = headPath ?? basePath!;
    if (/\.snapshot$|\.snap$|(^|\/)__snapshots__\//.test(path)) snapshots.push(path);
    if (!isTestFile(path) && !(basePath && isTestFile(basePath))) continue;
    const baseText = basePath ? git(cwd, ['show', `${base}:${basePath}`]) : undefined;
    const headText = headPath ? git(cwd, ['show', `HEAD:${headPath}`]) : undefined;
    // Base tests of a renamed file take the new path, so a pure rename removes nothing.
    if (baseText !== undefined) before.push(...testCases(path, baseText));
    if (headText !== undefined) after.push(...testCases(path, headText));
    if (status === 'A') continue;
    const baseAssertions = baseText === undefined ? [] : assertions(basePath!, baseText);
    if (headText === undefined) { if (baseAssertions.length) changes.push({ path, base: baseAssertions, head: [] }); continue; }
    const headAssertions = assertions(headPath!, headText);
    const diff = git(cwd, ['diff', '--no-color', '--no-ext-diff', '-U0', '-M50', base, 'HEAD', '--', ...new Set([basePath!, headPath!])]);
    for (const hunk of hunks(diff)) {
      const changedBase = baseAssertions.filter(assertion => touches(assertion, hunk.base));
      const changedHead = headAssertions.filter(assertion => touches(assertion, hunk.head));
      if (changedBase.length || changedHead.length) changes.push({ path, base: changedBase, head: changedHead });
    }
  }
  const newer = (pick: (test: TestCase) => boolean) => difference(after.filter(pick).map(test => test.id), before.filter(pick).map(test => test.id));
  const result = {
    removed: difference(before.map(test => test.id), after.map(test => test.id)),
    unconditionalSkips: newer(test => test.skip === 'unconditional'),
    conditionalSkips: newer(test => test.skip === 'conditional'),
    only: newer(test => test.only),
    assertions: changes,
    snapshots,
  };
  return { exitCode: result.unconditionalSkips.length ? 1 : 0, ...result, report: report(base, result) };
}

/** Items of `from` beyond their count in `minus`, so duplicate titles count. */
function difference(from: string[], minus: string[]): string[] {
  const left = new Map<string, number>();
  for (const id of minus) left.set(id, (left.get(id) ?? 0) + 1);
  return from.filter(id => { const count = left.get(id) ?? 0; if (count) { left.set(id, count - 1); return false; } return true; });
}

function report(base: string, result: Omit<Integrity, 'exitCode' | 'report'>): string {
  const list = (title: string, items: string[]) => items.length ? `### ${title}\n${items.map(item => `- \`${item}\``).join('\n')}\n\n` : '';
  const fence = (assertion: Assertion) => `\`\`\`ts\n${assertion.source}\n\`\`\``;
  const changed = result.assertions.map(change => [
    ...change.base.map(assertion => `- base \`${change.path}:${assertion.start}-${assertion.end}\`\n${fence(assertion)}`),
    ...(change.head.length ? change.head.map(assertion => `- head \`${change.path}:${assertion.start}-${assertion.end}\`\n${fence(assertion)}`) : [`- head: removed`]),
  ].join('\n')).join('\n\n');
  const body = list('Removed tests', result.removed) + list('New unconditional skips (fails)', result.unconditionalSkips)
    + list('New conditional skips', result.conditionalSkips) + list('New `.only`', result.only)
    + (changed ? `### Changed assertions\n${changed}\n\n` : '') + list('Changed snapshot files', result.snapshots);
  return `## Test integrity against ${base.slice(0, 12)}\n\n${body || 'No tests removed or skipped and no assertions changed.\n'}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--base');
  if (at !== -1 && !process.argv[at + 1]) { process.stderr.write('--base needs a revision\n'); process.exit(2); }
  const result = checkTestIntegrity(process.cwd(), at === -1 ? undefined : process.argv[at + 1]);
  if (result.exitCode === 2) process.stderr.write(result.report);
  else if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.report);
  else process.stdout.write(result.report);
  process.exitCode = result.exitCode;
}
