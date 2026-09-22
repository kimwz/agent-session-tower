import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlackWorkflowSummary } from '../../../client/src/slack/SlackMonitorPanel.js';
import type { SlackWorkflow } from '../../../shared/slack.js';
import { visibleSlackMentions } from '../../../client/src/graph/slack-graph.js';
import type { AutoPromptJob } from '../../../shared/types.js';

const workflow: SlackWorkflow = {
  id: 'mention-1', mention: { id: 'mention-1', teamId: 'T1', channel: 'C1', user: 'U1', ts: '1', threadTs: '1', text: '<script>review PR</script>' },
  status: 'running', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', rules: [],
  reason: 'Verse8 PR review requested', rule: { id: 'rule-1', name: 'PR review', enabled: true, condition: 'PR request', instructions: 'Review the changes', replyInstructions: 'Reply when done', provider: 'codex' },
  thread: [{ user: 'U2', text: 'Thread context', ts: '2' }], prompt: 'Review linked PR in repository',
};
const render = (item: SlackWorkflow, job?: AutoPromptJob) => renderToStaticMarkup(createElement(SlackWorkflowSummary, { workflow: item, job }));

test('mention detail exposes source, matching decision and submitted context without executing markup', () => {
  const html = render(workflow);
  for (const text of ['PR review', 'Verse8 PR review requested', 'Review the changes', 'Thread context', 'Review linked PR in repository']) assert.ok(html.includes(text));
  assert.ok(html.includes('&lt;script&gt;review PR&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /role="status"/);
});

test('uncertain delivery is not presented as a sent reply', () => {
  const html = render({ ...workflow, status: 'reply-uncertain', reply: 'Review complete', error: 'Network disconnected' });
  assert.ok(html.includes('작성된 답글'));
  assert.ok(!html.includes('Slack에 보낸 답글'));
  assert.ok(html.includes('답글 전송 여부를 확인할 수 없습니다.'));
  assert.ok(html.includes('Network disconnected'));
});

test('routing completion shows route decision while workflow remains working', () => {
  const job: AutoPromptJob = { id: 'job-1', provider: 'codex', prompt: 'review', routerModel: 'router', status: 'completed', createdAt: workflow.createdAt, updatedAt: workflow.updatedAt, decision: { action: 'resume', cwd: '/repo', sessionId: 'codex:1', reason: 'Existing PR context' } };
  const html = render(workflow, job);
  assert.ok(html.includes('Existing PR context'));
  assert.ok(html.includes('/repo'));
  assert.match(html, /slack-monitor-state working/);
});


test('overview latest page includes new mentions when the API returns oldest first', () => {
  const events = Array.from({ length: 80 }, (_, index) => ({ ...workflow, id: String(index), createdAt: new Date(Date.UTC(2026, 8, 22, 0, index)).toISOString() }));
  const page = visibleSlackMentions(events, 50);
  assert.equal(page.length, 50);
  assert.equal(page[0].id, '79');
  assert.equal(page.at(-1)?.id, '30');
  assert.equal(events[0].id, '0');
});
