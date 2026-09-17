import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunControl } from '../../../client/src/chat/RunControl.js';
import { RunApprovalCard } from '../../../client/src/chat/RunApprovalCard.js';
import { approvalDecisionState, formApprovalContent, reconcileApprovalDecisions, safeApprovalUrl, submitApprovalDecision } from '../../../client/src/chat/chat-approvals.js';
import { ApiError } from '../../../client/src/common/lib.js';
import { setLanguage } from '../../../client/src/i18n/i18n.js';
import type { Run, RunApproval, RunApprovalResponse } from '../../../shared/types.js';

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

const questions: RunApproval = { id: 'questions', toolName: 'Codex questions', input: {}, origin: { threadId: 'child-1', turnId: 'child-turn', agentName: 'Researcher' }, interaction: { type: 'questions', questions: [
  { id: 'scope', header: 'Scope', question: 'Which <scope>?', isOther: true, isSecret: false, options: [{ label: 'Small', description: 'One file' }, { label: 'Broad', description: 'Several files' }] },
  { id: 'secret', header: 'Credential', question: 'Enter the secret', isOther: false, isSecret: true, options: null },
  { id: '__proto__', header: 'Note', question: 'Your note', isOther: false, isSecret: false, options: [] },
] } };
const form: RunApproval = { id: 'form', toolName: 'MCP form', input: {}, interaction: { type: 'mcp-form', serverName: 'Fixture server', schema: { type: 'object', required: ['count', 'enabled'], properties: {
  count: { type: 'integer', title: 'Count', minimum: 0, maximum: 5 },
  enabled: { type: 'boolean', title: 'Enabled' },
  email: { type: 'string', title: 'Email', format: 'email', maxLength: 80 },
  tier: { type: 'string', title: 'Tier', enum: ['basic', 'plus'], enumNames: ['Basic tier', 'Plus tier'] },
  mode: { type: 'string', title: 'Mode', oneOf: [{ const: 'fast', title: 'Fast mode' }, { const: 'safe', title: 'Safe mode' }] },
  regions: { type: 'array', title: 'Regions', minItems: 1, maxItems: 2, items: { anyOf: [{ const: 'kr', title: 'Korea' }, { const: 'us', title: 'United States' }] } },
} } } };
function renderApproval(value: RunApproval, disabled = false) { return renderToStaticMarkup(createElement(RunApprovalCard, { runId: 'render-interaction', approval: value, disabled, token: 'token', onSnapshotRefresh: noop })); }

test('questions show child origin, explicit choices, secret/free text and localized response controls', () => {
  let html = renderApproval(questions);
  assert.match(html, /하위 에이전트.*Researcher/);
  assert.match(html, /Which &lt;scope&gt;\?/);
  assert.equal((html.match(/type="radio"/g) || []).length, 3);
  assert.match(html, /type="password"/);
  assert.match(html, /autocomplete="new-password"/i);
  assert.match(html, /type="text"/);
  assert.match(html, /답변 보내기/);
  assert.match(html, /답변 취소/);
  assert.doesNotMatch(html, /checked=""|한 번 허용|value="[^\"]+"/);
  setLanguage('en'); html = renderApproval(questions);
  assert.match(html, /Subagent.*Researcher/); assert.match(html, /Send answers/); assert.match(html, /Secret answer/); assert.match(html, /Other answer/);
  const pending = renderToStaticMarkup(createElement(RunControl, { run: { ...run, approvals: [questions] }, onCancel: noop, onRetry: noop, cancelling: false, token: 'token', onSnapshotRefresh: noop }));
  assert.match(pending, /Waiting for a response/);
});

test('MCP forms render typed fields, titled choices and original schema constraints', () => {
  const html = renderApproval(form);
  assert.match(html, /Fixture server/);
  assert.match(html, /type="number"[^>]*min="0"[^>]*max="5"[^>]*step="1"/);
  assert.match(html, /<option value="false">/);
  assert.match(html, /type="email"[^>]*maxLength="80"/i);
  assert.match(html, /Basic tier/); assert.match(html, /Fast mode/); assert.match(html, /Korea/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 2);
  assert.match(html, /선택 수: 1–2/);
  assert.match(html, /제출/); assert.match(html, /취소/); assert.match(html, /거절/);
  const disabled = renderApproval(form, true);
  assert.match(disabled, /<select disabled=""/);
  assert.match(disabled, /<fieldset[^>]*disabled=""/);
});

test('unsupported MCP forms expose the original schema but cannot accept it', () => {
  const html = renderApproval({ ...form, interaction: { type: 'mcp-form', serverName: 'server', schema: { type: 'object', properties: { nested: { type: 'object', properties: {} } } } } });
  assert.match(html, /이 양식 형식은 지원하지 않습니다/);
  assert.match(html, /nested/); assert.doesNotMatch(html, /<input/);
  assert.match(html, /class="run-approval-allow" disabled=""/);
  assert.equal((html.match(/disabled=""/g) || []).length, 1);
});

test('MCP URLs require explicit safe links with no referrer and separate completion', () => {
  const urlApproval: RunApproval = { id: 'url', toolName: 'MCP authorization', input: {}, interaction: { type: 'mcp-url', serverName: 'Authorization server', url: 'https://example.com/connect?scope=read&state=opaque' } };
  const html = renderApproval(urlApproval);
  assert.match(html, /href="https:\/\/example.com\/connect\?scope=read&amp;state=opaque"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"/);
  assert.match(html, /완료 확인/);
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///private/file', '/relative', 'https://name:password@example.com']) {
    assert.equal(safeApprovalUrl(url), undefined);
    const blocked = renderApproval({ ...urlApproval, interaction: { type: 'mcp-url', serverName: 'server', url } });
    assert.doesNotMatch(blocked, /href=/); assert.match(blocked, /class="run-approval-allow" disabled=""/);
  }
});

test('structured answer/form responses preserve typed values and authenticated transport', async context => {
  const calls: RequestInit[] = [];
  context.mock.method(globalThis, 'fetch', async (_path: unknown, init: RequestInit) => { calls.push(init); return new Response('{}', { status: 200 }); });
  const responses: RunApprovalResponse[] = [
    { answers: Object.fromEntries([['__proto__', { answers: ['private answer'] }]]) },
    { action: 'accept', content: { count: 0, enabled: false, regions: ['kr'] } },
    { action: 'cancel', content: null }, { action: 'decline', content: null },
  ];
  for (const [index, response] of responses.entries()) await submitApprovalDecision('structured', String(index), response, 'csrf-token');
  assert.equal(calls.length, responses.length);
  calls.forEach((call, index) => {
    assert.deepEqual(JSON.parse(call.body as string), responses[index]);
    assert.deepEqual(call.headers, { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': 'csrf-token' });
  });
});

test('settled response remains locked across remounts and conversation switches until authoritative removal', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}', { status: 200 }); });
  await submitApprovalDecision('remount', 'answer', { answers: { key: { answers: ['secret'] } } }, 'token');
  assert.equal(approvalDecisionState('remount', 'answer'), 'settled');
  reconcileApprovalDecisions([{ ...run, id: 'another-conversation' }, { ...run, id: 'remount', approvals: [{ ...approval, id: 'answer' }] }]);
  assert.equal(await submitApprovalDecision('remount', 'answer', 'deny', 'token'), 'accepted');
  const html = renderToStaticMarkup(createElement(RunApprovalCard, { runId: 'remount', approval: { ...approval, id: 'answer' }, token: 'token', onSnapshotRefresh: noop }));
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
  assert.match(html, /작업 상태 갱신 중/);
  assert.equal(calls, 1);
  reconcileApprovalDecisions([{ ...run, id: 'remount', approvals: [] }]);
  assert.equal(approvalDecisionState('remount', 'answer'), 'idle');
});

test('valid empty required text and array values remain distinct from omitted optional fields and chosen false/zero', () => {
  const schema = { type: 'object', required: ['text', 'regions', 'choice', 'count', 'enabled'], properties: {
    text: { type: 'string' }, regions: { type: 'array', items: { type: 'string', enum: ['kr'] } },
    choice: { type: 'string', enum: ['', 'filled'] }, count: { type: 'integer' }, enabled: { type: 'boolean' }, optional: { type: 'string', default: 'do not submit' },
  } };
  assert.deepEqual(formApprovalContent(schema, { choice: '', count: 0, enabled: false }), { text: '', regions: [], choice: '', count: 0, enabled: false });
  const html = renderApproval({ ...form, interaction: { type: 'mcp-form', serverName: 'server', schema } });
  assert.match(html, /<option value="0">빈 값<\/option>/);
  assert.doesNotMatch(html, /value="do not submit"/);
});
