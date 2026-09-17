import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionRow } from '../../../client/src/sessions/SessionRow.js';
import type { Session } from '../../../shared/types.js';

const session = (patch: Partial<Session> = {}): Session => ({
  id: 'claude:1', nativeId: 'native-1', provider: 'claude', title: '리팩터링 계획 세우기', cwd: '/Users/me/monitor', project: 'monitor',
  status: 'working', statusReason: '작업 중', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
  lastCompletedAt: '2026-09-15T00:00:00.000Z', lastMessage: '스타일시트를 화면별로 나눴습니다.', messageCount: 12,
  isSubagent: false, resumable: true, ...patch,
});
const render = (patch: Partial<Session> = {}, props: { selected?: boolean; unread?: boolean } = {}) =>
  renderToStaticMarkup(createElement(SessionRow, { session: session(patch), selected: false, unread: false, onSelect() {}, ...props }));

test('an unread session row shows the new-activity dot and a read one does not', () => {
  const unread = render({}, { unread: true });
  assert.match(unread, /class="session-row  unread"/);
  assert.match(unread, /<strong><i class="unread-dot" title="새 활동" aria-label="새 활동"><\/i>/);
  assert.doesNotMatch(render(), /unread-dot/);
});

test('the open session is the only row announced as pressed', () => {
  assert.match(render({}, { selected: true }), /class="session-row selected " [^>]*aria-pressed="true"/);
  assert.match(render(), /aria-pressed="false"/);
});

test('a subagent row says so and an ordinary row stays silent about it', () => {
  assert.match(render({ isSubagent: true }), /하위 에이전트/);
  assert.doesNotMatch(render(), /하위 에이전트/);
});

test('a row shows its project, status and the last message as a single preview line', () => {
  const markup = render({ lastMessage: '# 제목\n\n여러 줄에 걸친   메시지' });
  assert.match(markup, /<bdi dir="ltr">monitor<\/bdi>/);
  assert.match(markup, /class="row-status working">작업 중</);
  assert.match(markup, /class="session-row-preview">제목 여러 줄에 걸친 메시지</);
});

test('a session without any message falls back to naming its agent', () => {
  assert.match(render({ lastMessage: '' }), /class="session-row-preview">Claude Code</);
});

test('a custom title replaces the recorded one in the row heading', () => {
  assert.match(render({ customTitle: '1.0.0 준비' }), /<strong>1\.0\.0 준비<\/strong>/);
  assert.match(render(), /<strong>리팩터링 계획 세우기<\/strong>/);
});
