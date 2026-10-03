import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import ts from 'typescript';
import { parse, sourceFiles } from '../helpers/source-scan.js';

/**
 * Which part of the code may import which. Shared code stands alone, the page never imports the server, HTTP plumbing
 * stays behind the HTTP layer, and backup reaches into domains, never the other way round. The exceptions below are
 * listed edge by edge, so the list can only shrink: a new offender and a stale entry both fail.
 */
const BACKUP_COORDINATORS = new Set(['server/index.ts', 'server/runs/worker.ts', 'server/runs/durable-runner.ts']);

/** The rule an import from `from` to `to` (repo paths without extension) breaks, if any. */
export function boundaryViolation(from: string, to: string): string | undefined {
  if (from.startsWith('shared/') && (to.startsWith('server/') || to.startsWith('client/'))) return 'R1 shared code imports only shared code';
  if (from.startsWith('client/') && to.startsWith('server/')) return 'R2 the page does not import the server';
  if (from.startsWith('server/') && to.startsWith('server/http/') && !from.startsWith('server/http/') && from !== 'server/index') return 'R3 only the HTTP layer imports server/http';
  if (from.startsWith('server/') && to.startsWith('server/backup/') && !from.startsWith('server/backup/') && !BACKUP_COORDINATORS.has(`${from}.ts`)) return 'R4 domains do not import backup';
  return undefined;
}

/** Relative module edges of one file, `from -> to`: imports, `import type`, `export … from`, `import()` and `import('…')` types. */
export function importEdges(path: string, text: string): string[] {
  const edges = new Set<string>();
  const from = path.replace(/\.tsx?$/, '');
  const add = (specifier: string) => {
    if (!specifier.startsWith('.')) return;
    edges.add(`${from} -> ${posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.(js|jsx|ts|tsx)$/, '')}`);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) add(node.moduleReference.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  return [...edges];
}

const ALLOWED: ReadonlyArray<readonly [edge: string, reason: string]> = [
  // The remote HTTP router serves a joined computer's pages through the same handlers as the local server.
  ['server/remote/router -> server/http/chat-images', 'remote HTTP router'],
  ['server/remote/router -> server/http/request-context', 'remote HTTP router'],
  ['server/remote/router -> server/http/requests', 'remote HTTP router'],
  ['server/remote/router -> server/http/public-snapshot', 'remote HTTP router'],
  ['server/remote/router -> server/http/server', 'remote HTTP router'],
  ['server/remote/router -> server/http/snapshot-stream', 'remote HTTP router'],
  ['server/remote/router -> server/http/sse-client', 'remote HTTP router'],
  // Route modules mounted by server/index.ts read request bodies with readJson.
  ['server/link/routes -> server/http/requests', 'route module'],
  ['server/master/routes -> server/http/requests', 'route module'],
  ['server/link/secret-routes -> server/http/requests', 'route module (also errorStatus)'],
  // The link proxy shares the attachment body limit; a node's own listener reads its request bodies.
  ['server/link/proxy -> server/http/requests', 'proxy edge (ATTACHMENT_BODY_BYTES)'],
  ['server/link/node -> server/http/requests', "node's own listener (readJson)"],
];

test('the import boundaries hold, apart from the listed exceptions', async () => {
  const violations: string[] = [];
  for (const [path, text] of await sourceFiles()) {
    for (const edge of importEdges(path, text)) {
      const [from, to] = edge.split(' -> ') as [string, string];
      if (boundaryViolation(from, to)) violations.push(edge);
    }
  }
  assert.deepEqual(violations.sort(), ALLOWED.map(([edge]) => edge).sort(),
    'A new edge breaks a boundary: move the code to its owner, or list the edge with its reason. A listed edge that is gone: remove it from the list.');
});

test('boundary rules: allowed and forbidden cases', () => {
  const cases: Array<[from: string, to: string, rule: string | undefined]> = [
    ['shared/models', 'shared/triggers', undefined],
    ['shared/models', 'server/models/settings', 'R1'],
    ['shared/models', 'client/src/app', 'R1'],
    ['client/src/app', 'shared/models', undefined],
    ['client/src/app', 'server/models/settings', 'R2'],
    ['server/triggers/service', 'server/http/requests', 'R3'],
    ['server/http/server', 'server/triggers/service', undefined],
    ['server/http/server', 'server/http/requests', undefined],
    ['server/index', 'server/http/server', undefined],
    ['server/index', 'server/backup/service', undefined],
    ['server/runs/worker', 'server/backup/restore-files', undefined],
    ['server/runs/durable-runner', 'server/backup/service', undefined],
    ['server/backup/service', 'server/triggers/service', undefined],
    ['server/triggers/service', 'server/backup/payload', 'R4'],
    ['server/http-extra/thing', 'server/backup/payload', 'R4'],
    ['server/httpish', 'server/http/requests', 'R3'],
  ];
  for (const [from, to, rule] of cases) assert.equal(boundaryViolation(from, to)?.slice(0, 2), rule, `${from} -> ${to}`);
});

test('every import form makes an edge, and package imports and strings do not', () => {
  const text = [
    "import { a } from './a.js';",
    "import type { B } from '../shared/b.js';",
    "import './side-effect.js';",
    "export { c } from './c.js';",
    "export * from './d.ts';",
    "export type { E } from './e';",
    "const f = await import('./f.js');",
    "type G = import('./g.js').G;",
    "import h = require('./h.js');",
    "import { readFile } from 'node:fs/promises';",
    "import ts from 'typescript';",
    "const s = \"import { x } from './not-an-import.js'\";",
    '// import { y } from "./comment.js";',
    "const dynamic = await import(name);",
  ].join('\n');
  assert.deepEqual(importEdges('server/x/y.ts', text).sort(), [
    'server/x/y -> server/shared/b', 'server/x/y -> server/x/a', 'server/x/y -> server/x/c', 'server/x/y -> server/x/d', 'server/x/y -> server/x/e',
    'server/x/y -> server/x/f', 'server/x/y -> server/x/g', 'server/x/y -> server/x/h', 'server/x/y -> server/x/side-effect',
  ]);
  assert.deepEqual(importEdges('client/src/a.tsx', "import { b } from '../../server/b.js';\nexport const A = () => <div>{'../../server/c.js'}</div>;"), ['client/src/a -> server/b']);
});
