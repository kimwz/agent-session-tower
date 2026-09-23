import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlackActivity, SlackRules } from '../../../client/src/slack/SlackPanel.js';
import type { SlackWorkflow } from '../../../shared/slack.js';

test('Slack activity treats incoming text as text and builds links only on Slack origin', () => {
  const event: SlackWorkflow = { id: 'event-1', status: 'error', createdAt: '', updatedAt: '', rules: [], error: '<script>alert(1)</script>', mention: { id: 'm1', teamId: 'T1', channel: 'C1', ts: '123.45', threadTs: '123.40', user: 'U1', text: '' }, autoPromptId: 'auto-1', runId: 'run-1' };
  const html = renderToStaticMarkup(createElement(SlackActivity, { events: [event] }));
  assert.match(html, /https:\/\/app.slack.com\/client\/T1\/C1\?thread_ts=123.40/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Auto Prompt: auto-1/);
  assert.match(html, /Run: run-1/);
});

test('rule editor exposes editable criteria, execution, reply and disabled activation', () => {
  const html = renderToStaticMarkup(createElement(SlackRules, { rules: [{ id: 'r1', name: 'Verse8', enabled: false, condition: 'PR review', instructions: 'Review code', replyInstructions: 'Reply after review', provider: 'codex' }], onChange() {} }));
  assert.match(html, /PR review/);
  assert.match(html, /Review code/);
  assert.match(html, /Reply after review/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /aria-label="지침 위로 이동" disabled=""/);
  assert.match(html, /aria-label="지침 아래로 이동" disabled=""/);
});

test('Slack rules use provider model choices and preserve the saved selection', () => {
  const html = renderToStaticMarkup(createElement(SlackRules, { rules: [{ id: 'r', name: 'Review', enabled: true, condition: 'PR', instructions: 'Review', replyInstructions: 'Propose', provider: 'claude', model: 'opus' }], providers: [{ provider: 'claude', available: true, sessionCount: 0, models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] }], onChange() {} }));
  assert.match(html, /aria-label="모델"/);
  assert.match(html, /value="opus" selected=""/);
  assert.match(html, /Sonnet/);
});

test('rule list stays collapsed to one-line summaries and opens only the selected editor', () => {
  const rules = [
    { id: 'a', name: 'Deploy', enabled: true, condition: 'Redeploy request', instructions: 'Redeploy develop', replyInstructions: 'Report', provider: 'claude' as const, model: 'opus', autoReply: true },
    { id: 'b', name: '', enabled: false, condition: 'Question', instructions: 'Research', replyInstructions: '', provider: 'codex' as const },
  ];
  const collapsed = renderToStaticMarkup(createElement(SlackRules, { rules, expanded: null, onExpand() {}, onChange() {} }));
  assert.match(collapsed, /Redeploy request/);
  assert.doesNotMatch(collapsed, /<textarea/);
  assert.match(collapsed, /Claude · opus/);
  assert.match(collapsed, /자동 답변/);
  assert.match(collapsed, /이름 없는 지침/);
  assert.match(collapsed, /입력 필요/);
  assert.equal((collapsed.match(/aria-expanded="false"/g) ?? []).length, 2);
  const open = renderToStaticMarkup(createElement(SlackRules, { rules, expanded: 'a', onExpand() {}, onChange() {} }));
  assert.equal((open.match(/<textarea/g) ?? []).length, 3);
  assert.match(open, /Redeploy develop/);
  assert.doesNotMatch(open, /Research/);
});

test('activity lists newest first and pages long histories', () => {
  const events: SlackWorkflow[] = Array.from({ length: 25 }, (_, i) => ({ id: `e${i}`, status: 'completed', createdAt: '', updatedAt: '', rules: [], reason: `reason-${i}`, mention: { id: `m${i}`, teamId: 'T1', channel: 'C1', ts: `${i}`, threadTs: `${i}`, user: 'U1', text: '' } }));
  const html = renderToStaticMarkup(createElement(SlackActivity, { events }));
  assert.ok(html.indexOf('reason-24') < html.indexOf('reason-23'));
  assert.doesNotMatch(html, /reason-4</);
  assert.match(html, /더 보기/);
});
