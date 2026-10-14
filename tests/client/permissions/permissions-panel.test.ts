import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionsPanel, RuleList, permissionOperation } from '../../../client/src/permissions/PermissionsPanel.tsx';
import { setLanguage } from '../../../client/src/i18n/i18n.ts';
import type { TriggerComputer } from '../../../client/src/triggers/TriggerPanel.tsx';
import type { PermissionOverview, PermissionRule } from '../../../shared/permissions.ts';

const NODE = 'c'.repeat(32);
const computer = (patch: Partial<TriggerComputer> = {}): TriggerComputer => ({ node: NODE, name: 'office-tower-1', providers: [], ready: true, connected: true, models: true, permissions: true, ...patch });
const panel = (props: Partial<Parameters<typeof PermissionsPanel>[0]> = {}) => renderToStaticMarkup(createElement(PermissionsPanel, { token: 't', projects: [], pending: 0,
  onClearFolder() {}, onChanged() {}, onOpenSession() {}, ...props }));
const selected = (markup: string) => /<option value="([^"]*)" selected="">/.exec(markup)?.[1];

test('the computer choice lists this computer and the joined computers that follow this Tower, with their waiting requests', () => {
  setLanguage('ko');
  assert.doesNotMatch(panel(), /trigger-computer/, 'no choice without a following computer');
  assert.doesNotMatch(panel({ computers: [computer({ permissions: false })] }), /office-tower-1/, 'a computer that does not follow is not managed here');
  const markup = panel({ computers: [computer()], pending: 2, waitingOn: { [NODE]: 2 } });
  assert.match(markup, /<option value="">이 컴퓨터<\/option>/);
  assert.match(markup, /office-tower-1 · 요청 2/);
  assert.equal(selected(markup), NODE, 'opened where the requests wait');
  assert.equal(selected(panel({ computers: [computer()], pending: 3, waitingOn: { [NODE]: 2 } })), '', 'this computer first when requests wait here');
  assert.equal(selected(panel({ computers: [computer()], cwd: `@${NODE}/work/shop` })), NODE, 'a joined computer’s folder opens that computer');
  assert.match(panel({ computers: [], cwd: `@${NODE}/work/shop` }), /연결되어 있지 않거나 이 Tower의 설정을 따르지 않습니다/, 'one no longer following says so');
});

test('a joined computer’s permissions go through its link, changes with a request ID so they are made once', async t => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify({ result: { rules: [], requests: [], targets: [], pending: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await permissionOperation<PermissionOverview>('t', 'overview', {}, NODE);
  await permissionOperation<PermissionOverview>('t', 'decide', { id: '0199a2b3-c4d5-7123-8abc-0123456789ab', approve: true }, NODE);
  await permissionOperation<PermissionOverview>('t', 'overview');
  assert.deepEqual(calls.map(call => call.url), [`/api/nodes/${NODE}/v1/permissions.overview`, `/api/nodes/${NODE}/v1/permissions.decide`, '/api/v1/permissions.overview']);
  assert.equal(calls[0]!.headers['X-Tower-Request-Id'], undefined);
  assert.match(calls[1]!.headers['X-Tower-Request-Id'] ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
});

test('the followed host’s rules for every project show as its own, without edit or delete here', () => {
  setLanguage('ko');
  const rule = (patch: Partial<PermissionRule>): PermissionRule => ({ id: 'r', kind: 'command', value: 'gh pr view', providers: ['claude', 'codex'], scope: 'global', source: 'owner', createdAt: '', updatedAt: '', ...patch });
  const overview: PermissionOverview = { rules: [rule({ id: 'mine', value: 'make lint' }), rule({ id: 'host', host: true })], requests: [], targets: [], pending: 0 };
  const markup = renderToStaticMarkup(createElement(RuleList, { overview, busy: false, onNew() {}, onEdit() {}, onDelete() {} }));
  assert.match(markup, /호스트 설정/);
  assert.match(markup, /그 Tower에서 바꾸거나 지웁니다/);
  assert.match(markup, /aria-label="make lint 삭제"/);
  assert.doesNotMatch(markup, /aria-label="gh pr view (삭제|편집)"/);
});
