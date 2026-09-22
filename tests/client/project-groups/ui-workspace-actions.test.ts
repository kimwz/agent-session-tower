import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceContext } from '../../../client/src/workspace/WorkspaceOverlay.js';
import { WorkspaceActions } from '../../../client/src/workspace/WorkspaceActions.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';
import { terminalInputChunks } from '../../../client/src/workspace/terminal-input.js';

test('workspace controls use overlay buttons without new browser tabs', () => {
  const language = getLanguage();
  try {
    setLanguage('en');
    const markup = renderToStaticMarkup(createElement(WorkspaceContext.Provider, { value: () => {} }, createElement(WorkspaceActions, { cwd: '/work/a project', token: 'fixture-token' })));
    assert.match(markup, /aria-label="Open folder \/work\/a project in a code editor"/);
    assert.equal((markup.match(/<button/g) || []).length, 2);
    assert.doesNotMatch(markup, /href=|target=|disabled=""/);
    assert.doesNotMatch(markup, /aria-disabled="true"/);
  } finally { setLanguage(language); }
});

test('workspace controls require a connected authenticated workspace with an absolute path', () => {
  for (const patch of [{ token: '' }, { disabled: true }, { cwd: 'unknown' }]) {
    const markup = renderToStaticMarkup(createElement(WorkspaceActions, { cwd: '/work/project', token: 'fixture-token', ...patch }));
    assert.equal((markup.match(/aria-disabled="true"/g) || []).length, 2);
    assert.doesNotMatch(markup, /href=/);
  }
});

test('large pasted terminal input is split on Unicode boundaries within the byte limit', () => {
  const data = 'a'.repeat(16383) + '한😀'.repeat(10000);
  const chunks = terminalInputChunks(data);
  assert.equal(chunks.join(''), data);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk) <= 16384);
    assert.equal(Buffer.from(chunk).toString('utf8'), chunk);
  }
  assert.deepEqual(terminalInputChunks(''), []);
});
