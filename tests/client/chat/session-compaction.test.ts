import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Run, Session, SessionCompaction } from '../../../shared/types.js';
import { SessionContextIcon } from '../../../client/src/sessions/SessionContextIcon.js';
import { CompactButton, CompactionStatus, compactBlock } from '../../../client/src/chat/SessionCompaction.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';

const originalLanguage = getLanguage();
test.beforeEach(() => setLanguage('ko'));
test.afterEach(() => setLanguage(originalLanguage));

const session = (patch: Partial<Session> = {}): Session => ({ id: 'claude:s', nativeId: 's', provider: 'claude', title: 'T', cwd: '/w', project: 'w', status: 'completed', statusReason: '',
  createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:10:00Z', lastRequestAt: '2026-10-08T00:05:00Z', lastMessage: 'done', messageCount: 4, isSubagent: false, resumable: true, ...patch });
const job = (patch: Partial<SessionCompaction>): SessionCompaction => ({ id: 'j1', sessionId: 'claude:s', state: 'reading', createdAt: '2026-10-08T00:06:00Z', updatedAt: '2026-10-08T00:07:00Z', ...patch });
const status = (props: Partial<Parameters<typeof CompactionStatus>[0]>) => renderToStaticMarkup(createElement(CompactionStatus,
  { job: null, error: '', followed: false, busy: false, onCancel() {}, onOpen() {}, onDismiss() {}, ...props }));

test('the chat header icon is the canvas orb with its context ring, and unknown usage shows no fill', () => {
  const known = renderToStaticMarkup(createElement(SessionContextIcon, { provider: 'claude', usage: { usedTokens: 40_000, contextWindow: 100_000, usedPercent: 40 }, descriptionId: 'd', compact: true, label: 'Claude' }));
  assert.match(known, /class="agent-orb-wrap claude compact"/);
  assert.match(known, /role="img"/);
  assert.match(known, /aria-label="Claude"/);
  assert.match(known, /aria-describedby="d"/);
  assert.match(known, /title="Claude · 컨텍스트 사용량: 40% · 40,000 \/ 100,000 토큰"/);
  assert.match(known, /session-context-ring medium/);
  assert.match(known, /session-context-fill/);
  const unknown = renderToStaticMarkup(createElement(SessionContextIcon, { provider: 'codex', usage: { usedTokens: 1234 }, descriptionId: 'd', compact: true, label: 'Codex' }));
  assert.match(unknown, /session-context-ring unknown/);
  assert.doesNotMatch(unknown, /session-context-fill/, 'never drawn as 0%');
  assert.match(unknown, /알 수 없음/);
  const canvas = renderToStaticMarkup(createElement(SessionContextIcon, { provider: 'claude', descriptionId: 'd' }));
  assert.doesNotMatch(canvas, /role="img"|compact/, 'the canvas card keeps its own labelling');
});

test('the compact button says why it is off, and the worker refusals it mirrors', () => {
  const ok = { reachable: true, token: 't', supported: true };
  assert.equal(compactBlock(session(), [], ok), undefined);
  const running: Run = { id: 'r', sessionId: 'claude:s', prompt: 'p', status: 'queued', createdAt: '2026-10-08T00:00:00Z', output: '' };
  for (const [blocked, expected] of [
    [compactBlock(session(), [], { ...ok, supported: false }), /업데이트/],
    [compactBlock(session(), [], { ...ok, reachable: false }), /연결되면/],
    [compactBlock(undefined, [], ok), /불러오는 중/],
    [compactBlock(session({ isSubagent: true }), [], ok), /하위 세션/],
    [compactBlock(session({ resumable: false }), [], ok), /이어서 작업할 수 없는/],
    [compactBlock(session({ creationPending: true }), [], ok), /첫 응답이 끝난 뒤/],
    [compactBlock(session({ master: true }), [], ok), /하위 세션/],
    [compactBlock(session({ messageCount: 0 }), [], ok), /압축할 대화가 없습니다/],
    [compactBlock(session({ status: 'working' }), [], ok), /끝난 뒤/],
    [compactBlock(session(), [running], ok), /끝난 뒤/],
  ] as const) assert.match(blocked ?? '', expected);
  const off = renderToStaticMarkup(createElement(CompactButton, { job: null, busy: false, blocked: '압축할 대화가 없습니다.', onStart() {} }));
  assert.match(off, /disabled=""/);
  assert.match(off, /title="압축할 대화가 없습니다\."/);
  assert.match(off, /aria-label="세션 압축"/);
  const running2 = renderToStaticMarkup(createElement(CompactButton, { job: job({ state: 'summarizing' }), busy: false, onStart() {} }));
  assert.match(running2, /disabled=""[^>]*title="세션을 압축하고 있습니다"|title="세션을 압축하고 있습니다"[^>]*disabled/);
});

test('the status line follows a compaction: progress with cancel, the result with its model, and failures it started', () => {
  assert.equal(status({}), '');
  const summarizing = status({ job: job({ state: 'summarizing', progress: { done: 2, total: 5 }, compactor: { provider: 'claude', model: 'claude-haiku-5-5' } }), followed: true });
  assert.match(summarizing, /세션 압축 · 요약하는 중 \(2\/5\)/);
  assert.match(summarizing, /claude-haiku-5-5/);
  assert.match(summarizing, /취소/);
  assert.doesNotMatch(status({ job: job({ state: 'creating' }), followed: true }), /취소/, 'no cancel once the session is being made');
  const done = status({ job: job({ state: 'done', newSessionId: 'claude:new', continuation: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', modelSource: 'observed', effortSource: 'observed' } }) });
  assert.match(done, /압축한 새 세션에서 이어집니다/);
  assert.match(done, /claude-opus-5-5 · high \(원래 세션 기록\)/);
  assert.match(done, /새 세션 열기/);
  assert.match(status({ job: job({ state: 'done', newSessionId: 'n', continuation: { provider: 'codex', modelSource: 'default', effortSource: 'lastRun', effort: 'low' } }) }), /CLI 기본 모델 · low \(CLI 기본값 \/ 마지막 요청\)/);
  assert.equal(status({ job: job({ state: 'done', newSessionId: 'n' }), lastRequestAt: '2026-10-08T00:09:00Z' }), '', 'a compaction older than the latest request no longer describes the conversation');
  assert.equal(status({ job: job({ state: 'failed', error: 'x' }) }), '', 'an old failure is not shown again');
  assert.match(status({ job: job({ state: 'failed', error: '압축하는 동안 원래 세션에 새 대화가 생겨 새 세션을 만들지 않았습니다. 다시 압축하세요.' }), followed: true }), /새 대화가 생겨/);
  assert.match(status({ job: job({ state: 'cancelled' }), followed: true }), /새 세션은 만들지 않았습니다/);
  assert.match(status({ error: '실행 워커가 아직 새 버전으로 바뀌지 않아 세션을 압축할 수 없습니다. 진행 중인 작업이 끝나면 바뀝니다.' }), /role="alert"/);
  setLanguage('en');
  assert.match(status({ job: job({ state: 'reading' }), followed: true }), /Compact session · Reading the conversation/);
});
