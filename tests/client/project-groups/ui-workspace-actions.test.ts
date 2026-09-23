import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceContext } from '../../../client/src/workspace/WorkspaceOverlay.js';
import { WorkspaceActions } from '../../../client/src/workspace/WorkspaceActions.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';
import { isTerminalReport, terminalInputChunks } from '../../../client/src/workspace/terminal-input.js';

test('automatic terminal replies are recognized without matching typed text or keys', () => {
  for (const report of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[12;40R', '\x1b[?2004;1$y', '\x1b]11;rgb:0c0c/1414/2020\x07', '\x1b]10;rgb:dcdc/e6e6/f3f3\x1b\\', '\x1bP>|xterm.js(5.5.0)\x1b\\', '\x1b[?1;2c\x1b[?1;2c']) assert.equal(isTerminalReport(report), true, JSON.stringify(report));
  for (const typed of ['1;2c', 'ls\r', '\x1b[A', '\x1b[1;5D', '\x1b', '\x03', 'echo \x1b[?1;2c']) assert.equal(isTerminalReport(typed), false, JSON.stringify(typed));
});

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
