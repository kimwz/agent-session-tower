import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import ts from 'typescript';
import { parse, sourceFiles } from '../helpers/source-scan.js';

/**
 * Which part of the code may import which. Shared code stands alone, the page never imports the server, HTTP plumbing
 * stays behind the HTTP layer and its edge, domains do not speak HTTP, and backup reaches into domains, never the other
 * way round. Exceptions are listed one by one, so the lists can only shrink: a new offender and a stale entry both fail.
 */
const BACKUP_COORDINATORS = new Set(['server/index.ts', 'server/runs/worker.ts', 'server/runs/durable-runner.ts']);

/** The rule an import from `from` to `to` (repo paths without extension) breaks, if any. */
export function boundaryViolation(from: string, to: string): string | undefined {
  if (from.startsWith('shared/') && (to.startsWith('server/') || to.startsWith('client/'))) return 'R1 shared code imports only shared code';
  if (from.startsWith('client/') && to.startsWith('server/')) return 'R2 the page does not import the server';
  if (from.startsWith('server/') && to.startsWith('server/http/') && !from.startsWith('server/http/') && from !== 'server/index' && !EDGE.has(`${from}.ts`)) return 'R3 only the HTTP layer and its edge import server/http';
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

const ALLOWED: ReadonlyArray<readonly [edge: string, reason: string]> = [];

/**
 * The edge: transport and composition files that may speak HTTP. Each is listed with why it is one; everything else is
 * domain (R5). A file here that no longer does any of it, or is gone, fails, so the set only shrinks.
 */
export const EDGE: ReadonlyMap<string, string> = new Map([
  ['server/index.ts', 'composition: mounts the routes and answers the update request with its status'],
  ['server/http/auth.ts', 'web server'], ['server/http/chat-images.ts', 'web server'], ['server/http/compression.ts', 'web server'],
  ['server/http/requests.ts', 'web server: reads requests, answers errors with their status'], ['server/http/server.ts', 'web server'],
  ['server/http/sinks.ts', 'web server: the heads of audio and event streams'],
  ['server/link/controller.ts', 'link transport'], ['server/link/mirror.ts', 'link transport'], ['server/link/node.ts', "a node's own listener"],
  ['server/link/nodes.ts', 'link transport'], ['server/link/proxy.ts', 'link proxy'], ['server/link/routes.ts', 'link routes'],
  ['server/link/secret-relay.ts', 'link client of the secret relay'], ['server/link/secret-routes.ts', 'link routes of the secret relay'],
  ['server/link/transport.ts', 'link transport'],
  ['server/master/client.ts', 'web side of the master host wire'], ['server/master/host.ts', 'master host listener and wire'], ['server/master/routes.ts', 'master routes'],
  ['server/mcp/stdio.ts', 'MCP stdio bridge to Tower over HTTP'], ['server/owner-mcp/tools.ts', 'owner MCP client of Tower over HTTP'],
  ['server/public-agents/listener.ts', 'public agent listener'],
  ['server/remote/request-ledger.ts', 'remote requests: whether a refusal may be sent again follows its status'], ['server/remote/router.ts', 'remote HTTP router'],
  ['server/runs/durable-runner.ts', 'web side of the runner wire'], ['server/runs/runner-protocol.ts', 'runner wire format'], ['server/runs/worker.ts', 'worker socket listener and wire'],
  ['server/slack/mcp-bridge.ts', 'Slack MCP bridge over HTTP'],
  ['server/terminals/client.ts', 'web side of the terminal host wire'], ['server/terminals/host.ts', 'terminal host listener and wire'],
  ['server/tower-tools/live-state.ts', 'client of Tower over HTTP'], ['server/tower-tools/tower-client.ts', 'client of Tower over HTTP'],
  ['server/triggers/http.ts', 'HTTP trigger requests'],
]);
const HTTP_NAMES = new Set(['ServerResponse', 'IncomingMessage', 'Http2ServerRequest', 'Http2ServerResponse', 'Http2Server', 'Http2SecureServer', 'ClientHttp2Session', 'ClientHttp2Stream', 'ServerHttp2Stream']);
const STATUS_API = new Set(['STATUS', 'statusOf', 'fromStatus']);
/** shared/errors.ts defines the status table and reads foreign statuses: only those two clauses do not apply to it. */
const DEFINITION = 'shared/errors.ts';

/** How a file speaks HTTP, if it does: node:http imports, HTTP type names, `statusCode`, the status table, server/http imports. */
export function httpUse(path: string, text: string): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (/^(node:)?http2?$/.test(specifier)) found.add(`imports ${specifier}`);
      const target = posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.(js|ts)$/, '');
      if (target === 'shared/errors' && ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) if (STATUS_API.has((element.propertyName ?? element.name).text)) found.add(`imports ${(element.propertyName ?? element.name).text}`);
      }
      if (specifier.startsWith('.') && target.startsWith('server/http/') && !path.startsWith('server/http/')) found.add('imports server/http');
    }
    if (ts.isIdentifier(node) && HTTP_NAMES.has(node.text)) found.add(`names ${node.text}`);
    if (ts.isIdentifier(node) && node.text === 'statusCode') found.add('statusCode');
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  if (path === DEFINITION) { found.delete('statusCode'); for (const name of STATUS_API) found.delete(`imports ${name}`); }
  return [...found].sort();
}

/** R5: a domain file (outside the edge) that speaks HTTP, as `path: how`. */
export function domainHttp(path: string, text: string, edge: ReadonlyMap<string, string> = EDGE): string[] {
  if (edge.has(path) || !(path.startsWith('server/') || path.startsWith('shared/'))) return [];
  return httpUse(path, text).map(use => `${path}: ${use}`);
}

/** Edge entries whose file is gone or no longer speaks HTTP. */
export function staleEdges(files: ReadonlyMap<string, string>, edge: ReadonlyMap<string, string> = EDGE): string[] {
  return [...edge.keys()].filter(path => !files.has(path) || !httpUse(path, files.get(path)!).length);
}

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
    ['server/master/host', 'server/http/sinks', undefined],
    ['server/master/session', 'server/http/sinks', 'R3'],
    ['server/decisions/service', 'server/http/requests', 'R3'],
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

test('R5: domain files do not speak HTTP; the edge is exactly the files that do', async () => {
  const files = await sourceFiles(['server', 'shared']);
  assert.deepEqual([...files].flatMap(([path, text]) => domainHttp(path, text)), [], 'A domain file speaks HTTP: throw a kind (shared/errors) or give it a StreamSink, or move the transport to the edge.');
  assert.deepEqual(staleEdges(files), [], 'An edge entry is gone or no longer speaks HTTP: remove it.');
});

test('R5 cases: what makes a file speak HTTP, the definition exemptions, and stale entries', () => {
  const uses = (path: string, text: string) => domainHttp(path, text).map(line => line.slice(path.length + 2));
  assert.deepEqual(uses('server/master/session.ts', "import { replyError } from '../tower-tools/tower-client.js';"), []);
  assert.deepEqual(uses('server/master/session.ts', "import { TowerError, isKind, kindOf, type ErrorKind } from '../../shared/errors.js';"), []);
  assert.deepEqual(uses('server/master/session.ts', "import { fromStatus } from '../../shared/errors.js';"), ['imports fromStatus']);
  assert.deepEqual(uses('server/master/session.ts', "import { STATUS as table, statusOf } from '../../shared/errors.js';"), ['imports STATUS', 'imports statusOf']);
  assert.deepEqual(uses('server/link/nodes.ts', "import { connect } from 'node:http2';"), [], 'an edge file');
  assert.deepEqual(uses('server/link/views.ts', "import { connect } from 'node:http2';"), ['imports node:http2']);
  assert.deepEqual(uses('server/secrets/broker.ts', "let session: ClientHttp2Session | undefined;"), ['names ClientHttp2Session']);
  assert.deepEqual(uses('server/workspace-terminals.ts', "import type { ServerResponse } from 'node:http';"), ['imports node:http', 'names ServerResponse']);
  assert.deepEqual(uses('server/triggers/once.ts', "throw Object.assign(new Error('x'), { statusCode: 409 });"), ['statusCode']);
  assert.deepEqual(uses('server/triggers/once.ts', "const text = 'statusCode'; // statusCode in words is not code"), []);
  assert.deepEqual(uses('server/decisions/service.ts', "import { httpError } from '../http/requests.js';"), ['imports server/http']);
  assert.deepEqual(uses('shared/errors.ts', "const status = (error as { statusCode?: number }).statusCode; export const STATUS = {};"), [], 'the definition reads foreign statuses');
  assert.deepEqual(uses('shared/errors.ts', "import { request } from 'node:http';"), ['imports node:http'], 'but does not speak HTTP');
  assert.deepEqual(uses('shared/models.ts', "const failure = { statusCode: 400 };"), ['statusCode']);
  assert.deepEqual(uses('client/src/app.ts', "import { request } from 'node:http';"), [], 'the page has its own ApiError');
  const files = new Map([['server/a.ts', "import { request } from 'node:http';"], ['server/b.ts', 'export const b = 1;']]);
  assert.deepEqual(staleEdges(files, new Map([['server/a.ts', ''], ['server/b.ts', ''], ['server/gone.ts', '']])), ['server/b.ts', 'server/gone.ts']);
});
