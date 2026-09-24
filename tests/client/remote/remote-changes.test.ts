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
    { at: '2026-09-24T00:58:00.000Z', controllerId: 'a'.repeat(32), controller: 'Office Mac', action: 'approval', session: 'codex:s', name: 'Parser work', target: '/work/app', detail: 'deny' },
    { at: '2026-09-24T00:57:00.000Z', controllerId: 'a'.repeat(32), controller: 'Office Mac', action: 'trigger', target: 'Nightly digest', detail: 'disable' },
    { at: '2026-09-24T00:56:00.000Z', controllerId: 'a'.repeat(32), controller: 'Office Mac', action: 'update', detail: '1.28.0' },
  ] }));
  assert.match(markup, /저장소 동기화<\/strong> · 받기/);
  assert.match(markup, /승인 요청에 답함<\/strong> · 거부<\/span><span class="remote-change-target" title="Parser work">Parser work/, 'a conversation by its title now, its start shown');
  assert.match(markup, /트리거 변경<\/strong> · 끔<\/span><span class="remote-change-target" title="Nightly digest">/);
  assert.match(markup, /업데이트 요청<\/strong> · 1\.28\.0/);
  assert.match(markup, /<time dateTime="2026-09-24T01:00:00.000Z"[^>]*>9월 24일 10:00<\/time>/, 'when, in words anyone can read');
  assert.match(markup, /Office Mac/);
  assert.match(markup, /해제된 컴퓨터/, 'a computer no longer linked is still shown as one');
  assert.match(markup, /readme\.md/);
  assert.match(markup, /내용, 비밀 값은 기록하지 않습니다/);
});

test('a computer that started controlling this one is announced here until it is seen', () => {
  setLanguage('ko');
  const markup = renderToStaticMarkup(createElement(RemoteButton, { token: 't', projects: [], controlledBy: ['Office Mac'], joined: { name: 'Office Mac', at: '2026-09-24T01:00:00.000Z' } }));
  assert.match(markup, /Office Mac이\(가\) 이 컴퓨터를 제어하기 시작했습니다/);
  assert.match(markup, /<time dateTime="2026-09-24T01:00:00.000Z">/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(RemoteButton, { token: 't', projects: [] })), /제어하기 시작했습니다/);
});
