import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { parse, root, sourceFiles } from '../helpers/source-scan.js';

/**
 * Errors dropped without a trace may only shrink, file by file. A site that drops an error on purpose says why with a
 * `// best-effort: <reason>` comment on its line or the line above, and is then not counted.
 */
const BASELINE = join(root, 'tests', 'gates', 'swallowed-errors.baseline.json');
const UPDATE = 'UPDATE_SWALLOWED_BASELINE=1 node --import tsx --test tests/gates/swallowed-errors.test.ts';

export type Pattern = 1 | 2 | 3 | 4 | 5;
export interface Site { line: number; pattern: Pattern }

/** A value that carries no information about the error: `undefined`, `null`, `false`, `''`, `-1`, `void 0`, `[]`, `{}` … */
function isLiteral(expression: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return ts.isStringLiteral(expression) || ts.isNumericLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
    || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(expression.kind)
    || (ts.isIdentifier(expression) && expression.text === 'undefined')
    || (ts.isVoidExpression(expression) && isLiteral(expression.expression))
    || (ts.isPrefixUnaryExpression(expression) && ts.isNumericLiteral(expression.operand))
    || (ts.isArrayLiteralExpression(expression) && !expression.elements.length)
    || (ts.isObjectLiteralExpression(expression) && !expression.properties.length);
}

/** Empty, or only `return;` / `return <literal>;`. */
const dropsInBlock = (block: ts.Block) => block.statements.length === 0
  || (block.statements.length === 1 && ts.isReturnStatement(block.statements[0]!) && (!block.statements[0].expression || isLiteral(block.statements[0].expression)));

/** `() => {}`, `() => undefined`, `function () { return false; }`, with at most the error as parameter. */
function dropsError(handler: ts.Expression): boolean {
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return false;
  return handler.parameters.length <= 1 && (ts.isBlock(handler.body) ? dropsInBlock(handler.body) : isLiteral(handler.body));
}
const namedDrop = (handler: ts.Expression) => ts.isIdentifier(handler) && /^(noop|ignore|swallow)/i.test(handler.text);

/** Lines covered by a comment that says `best-effort: <reason>`; comments come from the syntax tree's trivia, never from strings. */
function exemptLines(file: ts.SourceFile): Set<number> {
  const lines = new Set<number>();
  const seen = new Set<number>();
  const mark = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      if (!/best-effort:\s*\S/.test(file.text.slice(range.pos, range.end).replace(/\*\/$/, ''))) continue;
      const from = file.getLineAndCharacterOfPosition(range.pos).line, to = file.getLineAndCharacterOfPosition(range.end).line;
      for (let line = from; line <= to; line++) lines.add(line + 1);
    }
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    mark(ts.getLeadingCommentRanges(file.text, node.getFullStart()));
    const children = node.getChildren(file);
    if (!children.length) mark(ts.getTrailingCommentRanges(file.text, node.end));
    children.forEach(visit);
  };
  visit(file);
  return lines;
}

/** Every counted site of one file, by the line of its `.catch`/`.then` or `catch` keyword. */
export function swallowedErrors(path: string, text: string): Site[] {
  const file = parse(path, text);
  const exempt = exemptLines(file);
  const sites: Site[] = [];
  const at = (node: ts.Node, pattern: Pattern) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    if (!exempt.has(line) && !exempt.has(line - 1)) sites.push({ line, pattern });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name, [first, second] = node.arguments;
      if (method.text === 'catch' && node.arguments.length === 1) {
        if (dropsError(first!)) at(method, 1); else if (namedDrop(first!)) at(method, 3);
      } else if (method.text === 'then' && node.arguments.length === 2) {
        if (dropsError(second!)) at(method, 2); else if (namedDrop(second!)) at(method, 3);
      }
    }
    if (ts.isCatchClause(node)) {
      const statements = node.block.statements;
      if (statements.length === 0) at(node, 4);
      else if (dropsInBlock(node.block)) at(node, 5);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

const sorted = (counts: Record<string, number>) => `${JSON.stringify(Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0).sort(([a], [b]) => a < b ? -1 : 1)), null, 2)}\n`;

test('swallowed errors do not grow, per file', async () => {
  const found = new Map<string, Array<Site & { source: string }>>();
  for (const [path, text] of await sourceFiles()) {
    const lines = text.split('\n');
    const sites = swallowedErrors(path, text).map(site => ({ ...site, source: lines[site.line - 1]!.trim() }));
    if (sites.length) found.set(path, sites);
  }
  const updating = process.env.UPDATE_SWALLOWED_BASELINE === '1';
  const baseline: Record<string, number> | undefined = existsSync(BASELINE) ? JSON.parse(await readFile(BASELINE, 'utf8')) : undefined;
  if (!baseline) {
    assert.ok(updating, `no baseline: create it with ${UPDATE}`);
    await writeFile(BASELINE, sorted(Object.fromEntries([...found].map(([path, sites]) => [path, sites.length]))));
    return;
  }
  const grown = [...found].filter(([path, sites]) => sites.length > (baseline[path] ?? 0));
  const shrunk = Object.entries(baseline).filter(([path, count]) => (found.get(path)?.length ?? 0) < count);
  if (updating && shrunk.length) {
    const lowered = Object.fromEntries(Object.entries(baseline).map(([path, count]) => [path, Math.min(count, found.get(path)?.length ?? 0)]));
    await writeFile(BASELINE, sorted(lowered));
  }
  assert.deepEqual(grown.flatMap(([path, sites]) => [`${path}: ${sites.length} (baseline ${baseline[path] ?? 0})`, ...sites.map(site => `  ${path}:${site.line}  ${site.source}`)]), [],
    'Handle or log the error, or mark an intentional best-effort site with `// best-effort: <reason>`. Renamed file? move its baseline entry in the same PR.');
  if (!updating) {
    assert.deepEqual(shrunk.map(([path, count]) => `${path}: ${found.get(path)?.length ?? 0} (baseline ${count})`), [], `lower the baseline: \`${UPDATE}\``);
  }
});

test('the counter recognises each pattern and ignores strings and comments', () => {
  const fixture = `
p.catch(() => {});
p.catch(e => undefined);
p.catch(() => (null));
p.catch(function (e) { return -1; });
p.catch(() => { return; });
p.catch(() => void 0);
p.catch(() => ([]));
p.catch(() => ({}));
p.catch(() => \`\`);
p.then(ok, () => false);
p.catch(noop);
p.then(ok, ignoreError);
try { a(); } catch {}
try { a(); } catch (e) { /* nothing */ }
try { a(); } catch { return ''; }
try { a(); } catch { return; }
p.catch(error => log(error));
p.catch((a, b) => {});
p.catch(() => \`\${x}\`);
p.catch(() => [1]);
p.catch(() => ({ a: 1 }));
p.then(() => {});
p.then(ok, report);
p.catch(handler);
try { a(); } catch (e) { log(e); }
try { a(); } catch { return fallback; }
const s = "p.catch(() => {})";
const t = \`try { a(); } catch {}\`;
// p.catch(() => {});
/* try { a(); } catch {} */
p.catch(() => {}); // best-effort: the page may already be gone
// best-effort: nobody waits for this answer
p.catch(() => {});
/* best-effort:
   a reason on the next line */
try { a(); } catch {}
p.catch(() => {}); // best-effort:
/* best-effort: */ p.catch(() => {});
p.catch(() => {}); const note = '// best-effort: a string is not a comment';
// best-effort is not the marker without its colon
p.catch(() => {});
p
  .then(ok)
  .catch(() => {});
`;
  const sites = swallowedErrors('fixture.ts', fixture);
  const lines = fixture.split('\n');
  const byPattern = (pattern: Pattern) => sites.filter(site => site.pattern === pattern).map(site => lines[site.line - 1]!.trim());
  assert.deepEqual(byPattern(1), ['p.catch(() => {});', 'p.catch(e => undefined);', 'p.catch(() => (null));', 'p.catch(function (e) { return -1; });',
    'p.catch(() => { return; });', 'p.catch(() => void 0);', 'p.catch(() => ([]));', 'p.catch(() => ({}));', 'p.catch(() => ``);',
    'p.catch(() => {}); // best-effort:', '/* best-effort: */ p.catch(() => {});', "p.catch(() => {}); const note = '// best-effort: a string is not a comment';", 'p.catch(() => {});', '.catch(() => {});']);
  assert.deepEqual(byPattern(2), ['p.then(ok, () => false);']);
  assert.deepEqual(byPattern(3), ['p.catch(noop);', 'p.then(ok, ignoreError);']);
  assert.deepEqual(byPattern(4), ['try { a(); } catch {}', 'try { a(); } catch (e) { /* nothing */ }']);
  assert.deepEqual(byPattern(5), ["try { a(); } catch { return ''; }", 'try { a(); } catch { return; }']);
  assert.equal(sites.length, 21);
  assert.deepEqual(swallowedErrors('fixture.tsx', 'const a = <div>{"p.catch(() => {})"}</div>;\np.catch(() => {});\n'), [{ line: 2, pattern: 1 }]);
});
