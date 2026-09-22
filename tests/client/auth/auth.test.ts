import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountRecords } from '../../../client/src/auth/AccountPanel';
import { AuthGate, LoginForm } from '../../../client/src/auth/AuthGate';
import { api, AUTH_REQUIRED_EVENT } from '../../../client/src/common/lib';
import type { AuthOverview } from '../../../shared/auth';

test('auth gate does not mount protected content before status is resolved', () => {
  let mounted = false;
  function Private() { mounted = true; return createElement('p', null, 'secret conversation'); }
  const html = renderToStaticMarkup(createElement(AuthGate, { children: createElement(Private) }));
  assert.equal(mounted, false);
  assert.ok(!html.includes('secret conversation'));
});
test('login uses password inputs and explains permanent IP blocking', () => {
  const html = renderToStaticMarkup(createElement(LoginForm, { status: { local: false, authenticated: false, configured: true, token: 'token' }, onLogin() {} }));
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="current-password"/);
  assert.match(html, /5회 실패/);
  assert.ok(!html.includes('value="token"'));
});
test('records show successful, failed and blocked attempts and accessible unblock action', () => {
  const overview: AuthOverview = { configured: true, username: 'admin', attemptLimit: 5, historyLimit: 1000,
    blockedIps: [{ ip: '203.0.113.1', blockedAt: '2026-01-01T00:00:00Z', failures: 5 }],
    attempts: ['success', 'failure', 'blocked'].map((result, id) => ({ id: String(id), at: '2026-01-01T00:00:00Z', ip: '203.0.113.1', username: '<script>', result: result as 'success' | 'failure' | 'blocked' })) };
  const html = renderToStaticMarkup(createElement(AccountRecords, { overview, busy: false, onUnblock() {} }));
  for (const result of ['success', 'failure', 'blocked']) assert.match(html, new RegExp(`auth-result ${result}`));
  assert.match(html, /203.0.113.1 차단 해제/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>'));
});
test('records have explicit empty states', () => {
  const html = renderToStaticMarkup(createElement(AccountRecords, { overview: { configured: false, attemptLimit: 5, historyLimit: 1000, blockedIps: [], attempts: [] }, busy: false, onUnblock() {} }));
  assert.match(html, /차단된 IP가 없습니다/);
  assert.match(html, /로그인 시도 기록이 없습니다/);
});
test('protected API 401 requests reauthentication but login failure does not', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events: string[] = [];
  Object.defineProperty(globalThis, 'window', { value: { dispatchEvent(event: Event) { events.push(event.type); } }, configurable: true });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Login required' }), { status: 401 });
  try {
    await assert.rejects(api('/api/snapshot'));
    assert.deepEqual(events, [AUTH_REQUIRED_EVENT]);
    await assert.rejects(api('/api/auth/login'));
    assert.equal(events.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
