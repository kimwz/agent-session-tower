import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';
import ts from 'typescript';
import { parse, root, sourceFiles } from '../helpers/source-scan.js';

/**
 * The docs name repository paths, source files and functions in code spans, and link to each other. These checks fail
 * when one of them no longer exists. CHANGELOG.md and VALIDATION.md are dated history and are not read.
 */
type Reference = { kind: 'path' | 'source' | 'symbol' | 'link'; target: string };
interface Repository { exists(path: string, directory: boolean): boolean; sources: ReadonlySet<string>; symbols: ReadonlySet<string> }
const TOP_LEVEL = ['.github/', 'assets/', 'bin/', 'client/', 'docs/', 'scripts/', 'server/', 'shared/', 'tests/'];

/** What a code span refers to, or undefined for commands, URLs, state files, fields and anything else not checked. */
function classify(span: string): Reference | undefined {
  if (/\s/.test(span) || span.includes('://') || /[*<~]/.test(span)) return undefined;
  if (TOP_LEVEL.some(dir => span.startsWith(dir))) return { kind: 'path', target: span.replace(/#.*$/, '').replace(/(:\d+(-\d+)?)+$/, '') };
  if (/^[\w.-]+\.(ts|tsx|mjs)$/.test(span)) return { kind: 'source', target: span };
  if (/^[A-Za-z_$][\w$]*\(\)$/.test(span)) return { kind: 'symbol', target: span.slice(0, -2) };
  return undefined;
}

/** The checked references of one markdown file with their lines: code spans outside fenced blocks, and relative links. */
function references(text: string): Array<Reference & { line: number }> {
  const found: Array<Reference & { line: number }> = [];
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    for (const [, span] of line.matchAll(/`([^`]+)`/g)) {
      const reference = classify(span!);
      if (reference) found.push({ ...reference, line: index + 1 });
    }
    for (const [, target] of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^[a-z][\w+.-]*:/i.test(target!) || target!.startsWith('#') || target!.startsWith('/')) continue;
      found.push({ kind: 'link', target: target!.replace(/#.*$/, ''), line: index + 1 });
    }
  });
  return found;
}

/** `doc:line  reference` for every reference that does not resolve. */
function brokenReferences(docs: ReadonlyMap<string, string>, repository: Repository): string[] {
  const broken: string[] = [];
  for (const [doc, text] of docs) {
    for (const reference of references(text)) {
      const ok = reference.kind === 'path' ? repository.exists(reference.target.replace(/\/$/, ''), reference.target.endsWith('/'))
        : reference.kind === 'source' ? repository.sources.has(reference.target)
        : reference.kind === 'symbol' ? repository.symbols.has(reference.target)
        : repository.exists(normalize(join(dirname(doc), reference.target)).split('\\').join('/'), false);
      if (!ok) broken.push(`${doc}:${reference.line}  ${reference.kind} ${reference.target}`);
    }
  }
  return broken;
}

/** Names declared as a function, method, class or variable (`const x = …`). */
function declaredNames(path: string, text: string, into: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableDeclaration(node)
) && node.name && ts.isIdentifier(node.name)) into.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
}

async function docs(): Promise<Map<string, string>> {
  const paths = ['README.md', 'README.ko.md', 'AGENTS.md', ...(await readdir(join(root, 'docs'))).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
  return new Map(await Promise.all(paths.map(async path => [path, await readFile(join(root, path), 'utf8')] as const)));
}

test('docs reference only paths and functions that exist', async () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const symbols = new Set<string>();
  for (const [path, text] of await sourceFiles(['server', 'shared', 'client/src', 'scripts'])) declaredNames(path, text, symbols);
  const repository: Repository = {
    exists: (path, directory) => { try { const entry = statSync(join(root, path)); return directory ? entry.isDirectory() : true; } catch { return false; } },
    sources: new Set(tracked.map(path => basename(path))),
    symbols,
  };
  const all = await docs();
  assert.deepEqual(brokenReferences(all, repository), [], 'a doc names something that no longer exists: update the doc with the code');
  const counts = [...all.values()].flatMap(text => references(text)).reduce<Record<string, number>>((sum, { kind }) => ({ ...sum, [kind]: (sum[kind] ?? 0) + 1 }), {});
  for (const kind of ['path', 'source', 'symbol', 'link']) assert.ok(counts[kind], `the docs still have ${kind} references, so the check reads them`);
});

test('the classifier checks repository paths, source names and called functions, and leaves commands, URLs and state files alone', () => {
  for (const ignored of ['git show HEAD', 'POST /api/sessions', 'https://example.com/a.ts', '/api/bootstrap', '~/.claude/CLAUDE.md', '<state-dir>/runs.json',
    'runs.json', 'auth-sessions.json', 'sessionId', 'server/**/*.ts', '/Users/me/server/a.ts']) assert.equal(classify(ignored), undefined, ignored);
  assert.deepEqual(classify('server/runs/manager.ts:224'), { kind: 'path', target: 'server/runs/manager.ts' });
  assert.deepEqual(classify('client/src/i18n/messages.ts:3-11'), { kind: 'path', target: 'client/src/i18n/messages.ts' });
  assert.deepEqual(classify('tests/server/secrets/'), { kind: 'path', target: 'tests/server/secrets/' });
  assert.deepEqual(classify('durable-runner.test.ts'), { kind: 'source', target: 'durable-runner.test.ts' });
  assert.deepEqual(classify('markReady()'), { kind: 'symbol', target: 'markReady' });

  const doc = ['See `server/nope.ts` and `server/real.ts:3`, `gone.ts`, `missing()` and `present()`.', '```sh', 'cat `server/fenced.ts`', '```',
    '[usage](usage.md#remote-access), [away](missing.md), [site](https://example.com), [top](#top), `auth-sessions.json`', '`docs/` and `docs/real.ts/`'].join('\n');
  const repository: Repository = {
    exists: (path, directory) => directory ? path === 'docs' : ['server/real.ts', 'docs/usage.md', 'docs'].includes(path),
    sources: new Set(['real.ts']),
    symbols: new Set(['present']),
  };
  assert.deepEqual(brokenReferences(new Map([['docs/guide.md', doc]]), repository), [
    'docs/guide.md:1  path server/nope.ts',
    'docs/guide.md:1  source gone.ts',
    'docs/guide.md:1  symbol missing',
    'docs/guide.md:5  link missing.md',
    'docs/guide.md:6  path docs/real.ts/',
  ]);
});
