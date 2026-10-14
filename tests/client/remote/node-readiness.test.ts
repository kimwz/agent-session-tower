import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NodeSummary } from '../../../shared/link.js';
import { setLanguage } from '../../../client/src/i18n/i18n.js';
import { NodeReadiness } from '../../../client/src/remote/NodeReadiness.js';
import { FollowedHostNote, followedHostName } from '../../../client/src/remote/followed-host.js';
import { followState, needsSignIn, syncView } from '../../../client/src/remote/node-readiness.js';

const at = new Date(Date.now() - 60_000).toISOString();
const node = (extra: Partial<NodeSummary> = {}): NodeSummary => ({ id: 'b'.repeat(32), name: 'office-tower-1', fingerprint: 'AAAA-BBBB-CCCC', status: 'connected', version: '1.137.0',
  features: ['read', 'work', 'workspace', 'status', 'followHost', 'managedSettings'], pairedAt: at, followHost: true, following: true, ...extra });
const card = (summary: NodeSummary) => renderToStaticMarkup(createElement(NodeReadiness, { token: 't', node: summary, busy: false, run: async () => true }));

test('a joined computer\'s card says whether it follows this Tower, and why not when it was asked to', () => {
  assert.equal(followState(node()), 'following');
  assert.equal(followState(node({ followHost: false, following: false })), 'off');
  assert.equal(followState(node({ following: false, status: 'offline' })), 'offline');
  assert.equal(followState(node({ following: false })), 'elsewhere');
  assert.equal(followState(node({ following: false, features: ['work'] })), 'unsupported');
  setLanguage('ko');
  assert.match(card(node({ followHost: false, following: false })), /호스트 설정 따르기.*적용하지 않습니다/);
  assert.doesNotMatch(card(node({ followHost: false, following: false })), /저장소에서 새 폴더/, 'no clone for a computer that does not follow');
  const elsewhere = card(node({ following: false }));
  assert.match(elsewhere, /다른 Tower의 설정을 따르고 있습니다/);
  assert.match(elsewhere, /이 Tower를 따르게 하기/);
});

test('the sync status shows the applied revision, and a delay with each section\'s reason', () => {
  setLanguage('ko');
  const synced = node({ managed: { applied: { revision: 'abcdef0123456789', appliedAt: at }, attemptedAt: at } });
  assert.deepEqual(syncView(synced), { state: 'synced', revision: 'abcdef01', appliedAt: at, sections: [], workerPending: false });
  assert.match(card(synced), /동기화됨 · abcdef01/);
  const delayed = card(node({ managed: { applied: { revision: 'abcdef0123456789', appliedAt: at, errors: { skills: 'clash: 이 컴퓨터에 같은 이름의 Tower 스킬이 있어' } }, attemptedAt: at, error: 'The link is closed.' } }));
  assert.match(delayed, /동기화 지연/);
  assert.match(delayed, /마지막으로 적용한 설정\(abcdef01/);
  assert.match(delayed, /<strong>스킬<\/strong>: clash/);
  assert.match(card(node({ features: ['work', 'followHost'] })), /실행 워커가 새 버전으로 바뀌면 동기화합니다/);
  assert.match(card(node()), /첫 동기화를 기다리는 중/);
});

test('sign-ins show for each CLI; a missing one offers a terminal there, and a following computer offers a clone', () => {
  setLanguage('ko');
  const missing = node({ report: { versions: { web: '1.137.0' }, service: true, logins: { claude: 'ok', codex: 'missing', gh: 'unknown' } } });
  assert.equal(needsSignIn(missing), true);
  const markup = card(missing);
  assert.match(markup, /<li class="ok"><span>Claude Code<\/span><small>로그인됨/);
  assert.match(markup, /<li class="missing"><span>Codex<\/span><small>로그인 필요/);
  assert.match(markup, /<li class="unknown"><span>gh<\/span><small>확인 안 됨/);
  assert.match(markup, /터미널 열기/);
  assert.match(markup, /저장소에서 새 폴더/);
  assert.equal(needsSignIn(node({ report: { versions: { web: '1.137.0' }, service: true, logins: { claude: 'ok', codex: 'ok', gh: 'ok' } } })), false);
  assert.doesNotMatch(card(node({ report: { versions: { web: '1.137.0' }, service: true, logins: { claude: 'ok', codex: 'ok', gh: 'ok' } } })), /터미널 열기/);
});

test('on a computer that follows a host, its panels name that host', () => {
  setLanguage('ko');
  assert.equal(followedHostName({ controllers: [{ id: 'a'.repeat(32), name: 'Main Mac', fingerprint: 'x', state: 'paired', status: 'connected', followed: true }] }), 'Main Mac');
  assert.equal(followedHostName({ controllers: [{ id: 'a'.repeat(32), name: 'Main Mac', fingerprint: 'x', state: 'paired', status: 'connected' }] }), undefined);
  assert.equal(renderToStaticMarkup(createElement(FollowedHostNote, { host: undefined })), '');
  assert.match(renderToStaticMarkup(createElement(FollowedHostNote, { host: 'Main Mac' })), /호스트 설정을 따르는 중: Main Mac/);
  assert.match(renderToStaticMarkup(createElement(FollowedHostNote, { host: 'Main Mac', skills: true })), /그 Tower에서 온 스킬과 지침/);
});

test('the card says how this Tower\'s secrets reach a computer that follows it', () => {
  setLanguage('ko');
  const checkedAt = new Date().toISOString();
  assert.match(card(node({ secrets: { state: 'connected', available: 3, checkedAt } })), /시크릿.*연결됨 · 사용 가능 3개/);
  assert.match(card(node({ secrets: { state: 'needs-open', checkedAt } })), /보관함을 한 번 열어 주세요/);
  assert.match(card(node({ secrets: { state: 'host-locked', checkedAt } })), /이 Tower의 보관함이 잠겨/);
  assert.doesNotMatch(card(node({ followHost: false, following: false, secrets: { state: 'connected', available: 3, checkedAt } })), /사용 가능 3개/, 'nothing about secrets while it does not follow');
});
