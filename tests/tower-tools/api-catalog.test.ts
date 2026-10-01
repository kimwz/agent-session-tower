import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apiCatalog, FILE_ROUTES } from '../../server/tower-tools/api-catalog.js';
import { OPERATIONS } from '../../shared/api/operations.js';

/** Where Tower's HTTP routes are matched. */
const SOURCES = ['server/http/server.ts', 'server/link/routes.ts', 'server/master/routes.ts'];

/** Routes an agent never calls, and why. Anything else a page can call must be in the catalog. */
const NOT_FOR_AGENTS = new Map<string, string>([
  ['/api/health', 'liveness, not an operation'],
  ['/api/bootstrap', 'the page token; the tools send it themselves'],
  ['/api/auth/status', 'sign-in state of a browser'],
  ['/api/auth/login', 'sign-in of a browser'],
  ['/api/auth/logout', 'sign-out of a browser'],
  ['/api/events', 'the live stream; tower_query reads it'],
  ['/api/master/events', 'the master page\'s live stream'],
  ['/api/workspace/terminals/{}/events', 'a terminal\'s live stream; terminal_read reads it'],
  ['/api/master/presence', 'a page saying it shows the master'],
  ['/api/master/directives/{}', 'a page answering a screen command'],
  ['/api/master/voice/audio/{}', 'audio a page plays'],
  ...['on', 'off', 'presence', 'token', 'usage', 'request', 'activity', 'finished', 'played'].map(action => [`/api/master/voice/${action}`, 'the page\'s microphone and speaker'] as [string, string]),
  ['/api/nodes/{}/{}', 'the joined-computer prefix; every route takes it through node'],
]);

/** `(a|b)` alternatives expanded, and parameters (`{id}` or a capturing pattern) written `{}`. */
function expand(route: string): string[] {
  const group = /\(([^()]*)\)(\?)?/.exec(route);
  if (!group) return [route];
  const options = group[1]!.split('|').concat(group[2] ? [''] : []);
  return options.flatMap(option => expand(route.slice(0, group.index) + option + route.slice(group.index + group[0].length)));
}

function sourceRoutes(text: string): string[] {
  const routes = new Set<string>();
  for (const [, literal] of text.matchAll(/(?:(?:path|local) === |case )'(\/api\/[^']+)'/g)) routes.add(literal!);
  // A route kept in a constant, compared by name.
  for (const [, name, literal] of text.matchAll(/const ([A-Z_]+) = '(\/api\/[^']+)'/g)) if (new RegExp(`path === ${name}\\b`).test(text)) routes.add(literal!);
  // A route of a joined computer answered here rather than passed on.
  for (const [, rest] of text.matchAll(/nodeRoute\[2\] === '([^']+)'/g)) routes.add(`/api/nodes/{}/${rest}`);
  for (const [, pattern] of text.matchAll(/\/\^(\\\/api\\\/.*?)\$\//g)) {
    const route = pattern!
      .replace(/\\\//g, '/')
      .replace(/\((?:\?:)?nodes\/\[a-f0-9\]\{32\}\/\)\?/g, '')
      .replace(/\(\(\?:.*\)$/, '{}')
      .replace(/\((?:\[[^\]]+\](?:\{\d+\}|\+)?|\.\+|\[a-z\]\+\\\.\[a-zA-Z\]\+)\)/g, '{}')
      .replace(/\[[^\]]+\](?:\{\d+\}|\+)/g, '{}');
    for (const item of expand(route)) routes.add(item);
  }
  return [...routes];
}

function catalogRoutes(text: string): Set<string> {
  const routes = new Set<string>();
  for (const [token] of text.matchAll(/\/api\/[A-Za-z0-9/{}().|_-]+/g)) {
    for (const item of expand(token.replace(/\{[^}]*\}/g, '{}').replace(/\.$/, ''))) routes.add(item);
  }
  for (const name of Object.keys(OPERATIONS)) routes.add(`/api/v1/${name}`);
  return routes;
}

async function missingFrom(catalog: string): Promise<string[]> {
  const listed = catalogRoutes(catalog);
  const missing: string[] = [];
  for (const source of SOURCES) {
    for (const route of sourceRoutes(await readFile(source, 'utf8'))) {
      if (route === '/api/v1/{}' || NOT_FOR_AGENTS.has(route) || listed.has(route)) continue;
      missing.push(route);
    }
  }
  return missing;
}

test('the route catalog the master and the owner\'s agents read lists every route the pages can call', async () => {
  assert.deepEqual(await missingFrom(apiCatalog()), [], 'add these to server/tower-tools/api-catalog.ts, or to NOT_FOR_AGENTS with the reason');
  const listed = catalogRoutes(apiCatalog());
  for (const route of FILE_ROUTES) assert.ok(listed.has(route), route);
});

test('a route left out of the catalog is noticed, whether matched by literal, pattern, constant or for a joined computer', async () => {
  const without = (catalog: string, ...lines: RegExp[]) => catalog.split('\n').filter(line => !lines.some(pattern => pattern.test(line))).join('\n');
  const catalog = apiCatalog();
  assert.deepEqual(await missingFrom(without(catalog, /\/api\/auto-prompt-suggestions/)), ['/api/auto-prompt-suggestions']);
  assert.deepEqual(await missingFrom(without(catalog, /\/api\/remote\/exclusions/)), ['/api/remote/exclusions', '/api/nodes/{}/view']);
  assert.ok((await missingFrom(without(catalog, /\/api\/skills\/pin/))).includes('/api/skills/pin'));
  assert.ok((await missingFrom(without(catalog, /\/api\/backup\/\(run/))).includes('/api/backup/run'));
});
