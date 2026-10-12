import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SecretBrokerAccess } from '../../../shared/secrets.js';
import { SecretBrokerApprovalForm } from '../../../client/src/secrets/SecretBrokerApproval.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';

const original = getLanguage();
test.beforeEach(() => setLanguage('ko')); test.afterEach(() => setLanguage(original));
const access: SecretBrokerAccess = { sessionId: 'codex:fixture-deployer', root: '/fixture/project', taskId: null, eligible: true, requiresApproval: true, locked: false };
const render = (patch: Partial<SecretBrokerAccess> = {}) => renderToStaticMarkup(createElement(SecretBrokerApprovalForm, { access: { ...access, ...patch }, busy: false, approve: () => assert.fail('render does not approve'), revoke: () => assert.fail('render does not revoke') }));

test('owner reviews exact session and project before granting broker access, independently of key permission', () => {
  const html = render();
  assert.match(html, /codex:fixture-deployer/); assert.match(html, /\/fixture\/project/);
  assert.match(html, /사용할 키의 권한은 별도로 확인/);
  assert.match(html, /로그인한 소유자만 승인/);
  assert.match(html, /required=""/); assert.match(html, /type="submit" disabled=""/);
});
test('ineligible external input has no approval form and a locked vault cannot approve', () => {
  const denied = render({ eligible: false, reason: '외부 입력이 포함된 세션은 승인할 수 없습니다.' });
  assert.match(denied, /외부 입력/); assert.doesNotMatch(denied, /<form|type="submit"/);
  const locked = render({ locked: true }); assert.match(locked, /보관함 잠금을 해제/); assert.match(locked, /type="submit" disabled=""/);
});
test('existing approval shows its owner purpose and expiry with exact-record revocation instead of renewal', () => {
  const html = render({ taskId: 'fixture-task', approval: { id: 'fixture-approval', sessionId: access.sessionId, root: access.root!, taskId: 'fixture-task', hostId: 'fixture-host', taskLabel: 'g2-sync dev PR849', createdAt: 1, expiresAt: 3_600_001 } });
  assert.match(html, /g2-sync dev PR849/); assert.match(html, /만료/); assert.match(html, /다음 턴/); assert.match(html, /브로커 연결 승인 철회/); assert.doesNotMatch(html, /<form/);
});
