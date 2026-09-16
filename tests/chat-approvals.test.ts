import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunControl } from '../client/src/ChatPanel.js';
import { RunApprovalCard } from '../client/src/RunApprovalCard.js';
import { submitApprovalDecision } from '../client/src/chat-approvals.js';
import { ApiError } from '../client/src/lib.js';
import { setLanguage } from '../client/src/i18n.js';
import type { Run, RunApproval } from '../shared/types.js';

const noop = () => {};
const approval: RunApproval = {
  id: 'approval', toolName: 'Bash', description: 'Run **native command**',
  input: { command: 'printf "<script>alert(1)</script>"', cwd: '/tmp/original project', timeout: 120000, nested: { path: '/tmp/native.md' } },
};
const run: Run = { id: 'run', sessionId: 'session', status: 'running', createdAt: '2026-09-16T00:00:00.000Z', prompt: 'Continue', output: '', approvals: [approval] };
afterEach(() => setLanguage('ko'));

test('approval controls expose original commands and targets as read-only escaped text', () => {
  const html = renderToStaticMarkup(createElement(RunApprovalCard, { runId: 'run', approval, token: 'token', onSnapshotRefresh: noop }));
  assert.match(html, /Bash/);
  assert.match(html, /Run \*\*native command\*\*/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /\/tmp\/original project/);
  assert.match(html, /120000/);
  assert.match(html, /\/tmp\/native.md/);
  assert.match(html, /한 번 허용/);
  assert.match(html, /거절/);
  assert.doesNotMatch(html, /<script|<textarea|<input|contenteditable|class="markdown"|disabled=""/);
});

test('pending approvals replace the working label and keep cancellation available', () => {
  const html = renderToStaticMarkup(createElement(RunControl, { run, onCancel: noop, onRetry: noop, cancelling: false, token: 'token', onSnapshotRefresh: noop }));
  assert.match(html, /작업 승인 대기/);
  assert.match(html, /중지/);
  assert.match(html, /data-approval-id="approval"/);
  assert.doesNotMatch(html, /disabled=""/);
});

test('approval labels follow English while native tool details stay intact', () => {
  setLanguage('en');
  const html = renderToStaticMarkup(createElement(RunControl, { run, onCancel: noop, onRetry: noop, cancelling: false, token: 'token', onSnapshotRefresh: noop }));
  assert.match(html, /Waiting for approval/);
  assert.match(html, /Allow once/);
  assert.match(html, /Deny/);
  assert.match(html, /Run \*\*native command\*\*/);
  assert.doesNotMatch(html, /작업 승인 대기|한 번 허용|거절/);
});

test('turn-scoped permission grants explicitly show their longer scope in both languages', () => {
  const scoped: RunApproval = { ...approval, scope: 'turn', toolName: 'Permissions', input: { permissions: { network: { enabled: true }, filesystem: { read: ['/tmp/native path'] } } } };
  const render = () => renderToStaticMarkup(createElement(RunApprovalCard, { runId: 'run', approval: scoped, token: 'token', onSnapshotRefresh: noop }));
  const korean = render();
  assert.match(korean, /이번 턴에 허용/);
  assert.match(korean, /요청한 권한은 이번 턴에만 적용됩니다\./);
  assert.doesNotMatch(korean, /한 번 허용|이 작업에만 적용됩니다/);
  setLanguage('en');
  const english = render();
  assert.match(english, /Allow for this turn/);
  assert.match(english, /Requested access applies to this turn only\./);
  assert.match(english, /\/tmp\/native path/);
  assert.doesNotMatch(english, /Allow once|Applies to this action only/);
});

for (const props of [{ disabled: true, token: 'token' }, { disabled: false, token: '' }]) {
  test(`approval decisions are disabled with disabled=${props.disabled} and token=${!!props.token}`, () => {
    const html = renderToStaticMarkup(createElement(RunApprovalCard, { runId: 'run', approval, onSnapshotRefresh: noop, ...props }));
    assert.equal((html.match(/disabled=""/g) || []).length, 2);
  });
}

test('cancel in progress disables both approval decisions', () => {
  const html = renderToStaticMarkup(createElement(RunControl, { run, onCancel: noop, onRetry: noop, cancelling: true, token: 'token', onSnapshotRefresh: noop }));
  assert.equal((html.match(/disabled=""/g) || []).length, 3);
});

for (const status of ['error', 'completed', 'cancelled'] as const) {
  test(`${status} snapshots cannot retain actionable approvals`, () => {
    const html = renderToStaticMarkup(createElement(RunControl, { run: { ...run, status }, onCancel: noop, onRetry: noop, cancelling: false, token: 'token', onSnapshotRefresh: noop }));
    assert.doesNotMatch(html, /data-approval-id|한 번 허용|거절|작업 승인 대기/);
  });
}

test('allow and deny requests preserve authenticated JSON transport and original action inputs', async context => {
  const calls: Array<{ path: unknown; init: RequestInit | undefined }> = [];
  context.mock.method(globalThis, 'fetch', async (path: unknown, init: RequestInit | undefined) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ run }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  for (const decision of ['allow', 'deny'] as const) {
    assert.equal(await submitApprovalDecision('run/id', `approval/${decision}`, decision, 'csrf-token'), 'accepted');
  }
  assert.equal(calls.length, 2);
  for (const [index, decision] of ['allow', 'deny'].entries()) {
    assert.equal(calls[index].path, `/api/runs/run%2Fid/approvals/approval%2F${decision}`);
    assert.equal(calls[index].init?.method, 'POST');
    assert.deepEqual(calls[index].init?.headers, { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': 'csrf-token' });
    assert.deepEqual(JSON.parse(calls[index].init?.body as string), { decision });
  }
});

test('simultaneous conflicting decisions for one approval produce only one request', async context => {
  let release!: (response: Response) => void;
  let calls = 0;
  context.mock.method(globalThis, 'fetch', () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); });
  const first = submitApprovalDecision('run', 'concurrent', 'allow', 'token');
  const repeated = submitApprovalDecision('run', 'concurrent', 'deny', 'token');
  assert.equal(first, repeated);
  assert.equal(calls, 1);
  release(new Response('{}', { status: 200 }));
  assert.deepEqual(await Promise.all([first, repeated]), ['accepted', 'accepted']);
});

test('a stale 409 decision settles for snapshot refresh without offering a repeat mutation', async context => {
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: '이미 처리된 승인 요청입니다.' }), { status: 409 }));
  assert.equal(await submitApprovalDecision('run', 'stale', 'allow', 'token'), 'stale');
});

test('failed decisions retain HTTP error details and release the in-flight guard for retry', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response(JSON.stringify({ error: 'Connection authentication expired.' }), { status: 403 }) : new Response('{}', { status: 200 }));
  await assert.rejects(submitApprovalDecision('run', 'retry', 'allow', 'token'), error => error instanceof ApiError && error.status === 403 && error.message === 'Connection authentication expired.');
  assert.equal(await submitApprovalDecision('run', 'retry', 'allow', 'new-token'), 'accepted');
  assert.equal(calls, 2);
});
