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
