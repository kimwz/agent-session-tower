import test from 'node:test';
import assert from 'node:assert/strict';
import { absoluteTime, cleanPreview, relativeTime, sessionTitle } from '../../../client/src/common/lib.js';
import type { Session } from '../../../shared/types.js';

const now = Date.parse('2026-09-15T12:00:00.000Z');
const ago = (milliseconds: number) => relativeTime(new Date(now - milliseconds).toISOString(), now);
const session = (patch: Partial<Session> = {}): Session => ({
  id: 'claude:1', nativeId: 'native-1', provider: 'claude', title: '리팩터링 계획 세우기', cwd: '/Users/me/monitor', project: 'monitor',
  status: 'idle', statusReason: '대기 중', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
  lastMessage: '', messageCount: 3, isSubagent: false, resumable: true, ...patch,
});

test('activity within the last minute reads as just now and older activity counts up in whole units', () => {
  assert.equal(ago(0), '방금 전');
  assert.equal(ago(59_999), '방금 전');
  assert.equal(ago(60_000), '1분 전');
  assert.equal(ago(59 * 60_000 + 59_000), '59분 전');
  assert.equal(ago(3_600_000), '1시간 전');
  assert.equal(ago(23 * 3_600_000), '23시간 전');
  assert.equal(ago(86_400_000), '1일 전');
  assert.equal(ago(6 * 86_400_000), '6일 전');
});

test('activity older than a week is shown as a date instead of a growing day count', () => {
  const stamp = relativeTime('2026-08-01T00:00:00.000Z', now);
  assert.doesNotMatch(stamp, /전$/);
  assert.match(stamp, /8/);
});

test('a clock that is behind the recorded activity never reports a negative age', () => {
  assert.equal(relativeTime('2026-09-15T12:05:00.000Z', now), '방금 전');
});

test('an unreadable timestamp is left blank rather than shown as an invalid date', () => {
  assert.equal(absoluteTime('not-a-date'), '');
  assert.notEqual(absoluteTime('2026-09-15T12:00:00.000Z'), '');
});

test('a session is named by its owner first, then by its agent, then by its recorded title', () => {
  assert.equal(sessionTitle(session({ customTitle: '1.0.0 준비', agentName: 'reviewer' })), '1.0.0 준비');
  assert.equal(sessionTitle(session({ agentName: '  reviewer  ' })), 'reviewer');
  assert.equal(sessionTitle(session()), '리팩터링 계획 세우기');
});

test('an agent name that is only an internal identifier is not shown as a title', () => {
  assert.equal(sessionTitle(session({ agentName: 'a1b2c3d4e5f6' })), '리팩터링 계획 세우기');
  assert.equal(sessionTitle(session({ agentName: 'a1b2c3d4e5' })), 'a1b2c3d4e5');
});

test('a session with nothing to name it still has a readable heading', () => {
  assert.equal(sessionTitle(session({ title: '' })), '제목 없는 세션');
});

test('a message preview is flattened to one line without markup or markdown noise', () => {
  assert.equal(cleanPreview('# 제목\n\n**굵게**  하고\r\n`코드`'), '제목 굵게 하고 코드');
  assert.equal(cleanPreview('<p>태그는 <b>보이지</b> 않습니다</p>'), '태그는 보이지 않습니다');
});

test('a preview is cut to the length its row can show', () => {
  assert.equal(cleanPreview('가'.repeat(400)).length, 160);
  assert.equal(cleanPreview('가'.repeat(400), 100).length, 100);
  assert.equal(cleanPreview('짧은 요약'), '짧은 요약');
});
