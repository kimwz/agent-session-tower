import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLanguage } from '../../../client/src/i18n/i18n.js';
import { RemoteButton, RemoteChanges } from '../../../client/src/remote/RemotePanel.js';

test('this computer’s owner reads what controlling computers changed here, by computer and without content', () => {
  setLanguage('ko');
  const markup = renderToStaticMarkup(createElement(RemoteChanges, { initial: [
    { at: '2026-09-24T01:00:00.000Z', controllerId: 'a'.repeat(32), controller: 'Office Mac', action: 'repository', target: '/work/app', detail: 'pull' },
    { at: '2026-09-24T00:59:00.000Z', controllerId: 'b'.repeat(32), action: 'file', target: '/work/app/readme.md' },
  ] }));
  assert.match(markup, /저장소 동기화<\/strong> · 가져오기/);
  assert.match(markup, /Office Mac/);
  assert.match(markup, /해제된 컴퓨터/, 'a computer no longer linked is still shown as one');
  assert.match(markup, /readme\.md/);
  assert.match(markup, /내용, 비밀 값은 기록하지 않습니다/);
});

test('a computer that started controlling this one is announced here until it is seen', () => {
  setLanguage('ko');
  const markup = renderToStaticMarkup(createElement(RemoteButton, { token: 't', projects: [], controlledBy: ['Office Mac'], joined: { name: 'Office Mac', at: '2026-09-24T01:00:00.000Z' } }));
  assert.match(markup, /Office Mac이\(가\) 이 컴퓨터를 제어하기 시작했습니다/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(RemoteButton, { token: 't', projects: [] })), /제어하기 시작했습니다/);
});
