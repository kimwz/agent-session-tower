import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceTreeEntries, type WorkspaceEntry } from '../../../client/src/workspace/WorkspaceFileTree.js';

const entries: Record<string, WorkspaceEntry[]> = {
  '': [{ name: 'src', path: 'src', type: 'directory' }, { name: 'README.md', path: 'README.md', type: 'file' }],
  src: [{ name: 'nested', path: 'src/nested', type: 'directory' }, { name: 'index.ts', path: 'src/index.ts', type: 'file' }],
  'src/nested': [{ name: 'child.ts', path: 'src/nested/child.ts', type: 'file' }],
};
function render(expanded: ReadonlySet<string>, disabled = false) {
  function branch(path: string): ReturnType<typeof createElement> {
    return createElement(WorkspaceTreeEntries, { entries: entries[path], expanded, folder: 'src', selectedFile: 'src/nested/child.ts', disabled, onFolder() {}, onFile() {}, childrenFor: branch });
  }
  return renderToStaticMarkup(branch(''));
}

test('expanded folders nest their children while preserving root and folder siblings', () => {
  const markup = render(new Set(['src', 'src/nested']));
  assert.match(markup, /title="src" aria-expanded="true" aria-current="true"/);
  assert.match(markup, /title="src\/nested" aria-expanded="true"/);
  assert.match(markup, /title="src\/nested\/child.ts" aria-current="true"/);
  assert.match(markup, /README.md/);
  assert.match(markup, /index.ts/);
  assert.equal((markup.match(/<ul /g) || []).length, 3);
  assert.doesNotMatch(markup, /role="tree"/);
});

test('collapsing a parent hides descendants without removing their expansion state', () => {
  const expanded = new Set(['src/nested']);
  const closed = render(expanded);
  assert.match(closed, /title="src" aria-expanded="false"/);
  assert.doesNotMatch(closed, /child.ts|index.ts/);
  assert.match(closed, /README.md/);
  expanded.add('src');
  assert.match(render(expanded), /child.ts/);
});

test('busy document operations disable both folder disclosure and file selection', () => {
  assert.equal((render(new Set(['src']), true).match(/disabled=""/g) || []).length, 4);
});
