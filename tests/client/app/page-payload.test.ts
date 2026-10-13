import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../../client/src');
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);

test('the page asks for the snapshot only with its scope; the complete one is for tools and links', () => {
  const unscoped = sources(root).flatMap(file => [...readFileSync(file, 'utf8').matchAll(/\/api\/snapshot(?!\?\$\{scopeParams\()/g)]
    .map(() => file.slice(root.length + 1)));
  assert.deepEqual(unscoped, []);
});
