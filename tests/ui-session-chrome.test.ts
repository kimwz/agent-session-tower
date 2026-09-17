import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionTitleEditor } from '../client/src/sessions/SessionTitleEditor.js';
import { SessionFamilyNav } from '../client/src/sessions/SessionFamilyNav.js';
import type { Session } from '../shared/types.js';

const session = (patch: Partial<Session> = {}): Session => ({
  id: 'claude:1', nativeId: 'native-1', provider: 'claude', title: '리팩터링 계획 세우기', cwd: '/Users/me/monitor', project: 'monitor',
  status: 'idle', statusReason: '대기 중', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
  lastMessage: '', messageCount: 3, isSubagent: false, resumable: true, ...patch,
});
const title = (patch: Partial<Session> = {}, props: { token?: string; connected?: boolean } = {}) =>
  renderToStaticMarkup(createElement(SessionTitleEditor, { session: session(patch), token: 'token', connected: true, onSaved() {}, ...props }));
const family = (sessions: Session[], selectedId: string) =>
  renderToStaticMarkup(createElement(SessionFamilyNav, { sessions, selectedId, onNavigate() {} }));

test('a conversation shows its title with an edit button ready', () => {
  const markup = title();
  assert.match(markup, /<h2 title="리팩터링 계획 세우기">리팩터링 계획 세우기<\/h2>/);
  assert.match(markup, /class="icon-button title-edit-button" aria-label="세션 제목 수정"/);
  assert.doesNotMatch(markup, /disabled=""/);
  assert.doesNotMatch(markup, /session-title-editor/);
});

test('a renamed session shows the name its owner chose', () => {
  assert.match(title({ customTitle: '1.0.0 준비' }), /<h2 title="1\.0\.0 준비">1\.0\.0 준비<\/h2>/);
});

test('renaming is refused while the server connection or its token is missing', () => {
  assert.match(title({}, { connected: false }), /title-edit-button[^>]*disabled=""/);
  assert.match(title({}, { token: '' }), /title-edit-button[^>]*disabled=""/);
});

const parent = session({ id: 'claude:parent', title: '부모' });
const child = (id: string, patch: Partial<Session> = {}) =>
  session({ id, title: `하위 ${id}`, isSubagent: true, parentId: 'claude:parent', ...patch });

test('a conversation without subagents offers no family navigation', () => {
  assert.equal(family([parent], 'claude:parent'), '');
});

test('a conversation with subagents counts them and lists the parent first', () => {
  const markup = family([parent, child('claude:a'), child('claude:b')], 'claude:a');
  assert.match(markup, /class="session-family-nav" aria-label="서브에이전트 탐색"/);
  assert.match(markup, /<span>서브 2<\/span>/);
  assert.match(markup, /<option value="claude:parent"[^>]*>부모 대화<\/option><option value="claude:a"/);
  assert.match(markup, /<option value="claude:a" selected="">하위 claude:a<\/option>/);
});

test('a working subagent is marked as such in the navigation list', () => {
  const markup = family([parent, child('claude:a', { status: 'working' })], 'claude:parent');
  assert.match(markup, /<option value="claude:a">하위 claude:a · 작업 중<\/option>/);
});
