import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { parseSlackPosition, visibleSlackMentions, SLACK_PAGE_SIZE, slackMentionLayout } from '../../../client/src/graph/slack-graph.js';
import { SlackMentionNode } from '../../../client/src/graph/SlackGraphNodes.js';
import { TriggerMonitorNode } from '../../../client/src/graph/TriggerGraphNodes.js';
import type { SlackWorkflow } from '../../../shared/slack.js';
const event = (id: string, status: SlackWorkflow['status'] = 'running'): SlackWorkflow => ({ id, status, createdAt: `2026-09-${id.padStart(2, '0')}T00:00:00Z`, updatedAt: '2026-09-22T00:00:00Z', rules: [], mention: { id, teamId: 'team', channel: 'channel', user: 'user', ts: '1', threadTs: '1', text: 'Please review this PR' } });
const node = (component: unknown, data: unknown) => renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(component as FunctionComponent<{ data: unknown }>, { data })));
test('Slack position accepts finite coordinates and ignores corrupt storage', () => {
  assert.deepEqual(parseSlackPosition('{"x":-55,"y":90}'), { x: -55, y: 90 });
  for (const value of [null, '{', '[]', '{"x":"4","y":2}', '{"x":1e999,"y":2}', '{"projects":{}}']) assert.equal(parseSlackPosition(value), null);
});
test('mention window sorts newest first and retains an older selected mention without mutating events', () => {
  const events = [event('1'), event('3'), event('2')];
  assert.deepEqual(visibleSlackMentions(events, 1, '1').map(item => item.id), ['3', '1']);
  assert.deepEqual(events.map(item => item.id), ['1', '3', '2']);
  assert.equal(visibleSlackMentions(events, 2, '3').length, 2);
});
test('compact mention list pages five newest conversations and expands without losing selection', () => {
  const events = Array.from({ length: 12 }, (_, index) => event(String(index + 1)));
  assert.deepEqual(visibleSlackMentions(events, SLACK_PAGE_SIZE).map(item => item.id), ['12', '11', '10', '9', '8']);
  const selected = visibleSlackMentions(events, SLACK_PAGE_SIZE, '1');
  assert.deepEqual(selected.map(item => item.id), ['12', '11', '10', '9', '8', '1']);
  const expanded = visibleSlackMentions(events, SLACK_PAGE_SIZE * 2, '1');
  assert.equal(expanded.length, 11);
  assert.equal(expanded.at(-1)?.id, '1');
  const layout = slackMentionLayout(selected.length, true);
  assert.equal(new Set(layout.positions.map(position => position.x)).size, 1);
  for (let index = 1; index < layout.positions.length; index++) assert.equal(layout.positions[index].y - layout.positions[index - 1].y, 78);
  assert.ok(layout.positions.at(-1)!.y + 70 < layout.height - 30, 'last card leaves room for the More button');
  assert.ok(slackMentionLayout(0, false).height >= 190, 'empty state retains usable canvas space');
});
test('the trigger monitor offers a draggable header, overview and empty state even with no sessions', () => {
  const markup = node(TriggerMonitorNode, { enabledTriggers: 0, count: 0, active: 0, remaining: 0, more: false, onMore() {} });
  assert.match(markup, /slack-monitor-drag-handle/);
  assert.match(markup, /트리거 모니터 열기/);
  assert.match(markup, /slack-monitor-empty/);
  assert.match(markup, /다음 실행을 기다리는 중/);
  assert.doesNotMatch(markup, /agent-activity-border/);
});
test('an active monitor and working mention cards reuse the session activity border', () => {
  assert.match(node(TriggerMonitorNode, { enabledTriggers: 1, count: 1, active: 1, remaining: 0, more: false, onMore() {} }), /agent-activity-border/);
  for (const status of ['received', 'matching', 'dispatching', 'running', 'composing', 'sending'] as const) assert.match(node(SlackMentionNode, { event: event('1', status), selected: false }), /agent-activity-border/);
  for (const status of ['ignored', 'completed', 'error', 'reply-uncertain'] as const) assert.doesNotMatch(node(SlackMentionNode, { event: event('1', status), selected: false }), /agent-activity-border/);
});

test('with Slack connected, the monitor distinguishes transport failure and reconnecting from healthy waiting', () => {
  const base = { enabledTriggers: 2, count: 0, active: 0, remaining: 0, more: false, onMore() {} };
  const slack = { name: 'Team', enabled: true };
  const failed = node(TriggerMonitorNode, { ...base, slack: { ...slack, status: 'error', error: 'Socket disconnected' } });
  assert.match(failed, /Slack 연결 오류/);
  assert.match(failed, /title="Socket disconnected"/);
  assert.match(failed, /Slack · Team · 트리거 2개 켜짐/);
  assert.doesNotMatch(failed, /멘션을 기다리는 중/);
  const reconnecting = node(TriggerMonitorNode, { ...base, slack: { ...slack, status: 'connecting' } });
  assert.match(reconnecting, /Slack 연결 중/);
  assert.doesNotMatch(reconnecting, /멘션을 기다리는 중/);
  assert.match(node(TriggerMonitorNode, { ...base, slack: { ...slack, status: 'connected' } }), /멘션을 기다리는 중/);
  const activeFailure = node(TriggerMonitorNode, { ...base, active: 1, slack: { ...slack, status: 'error' } });
  assert.match(activeFailure, /1개 작업 중/);
  assert.match(activeFailure, /Slack 연결 오류/);
  assert.match(node(TriggerMonitorNode, { ...base, more: true }), /더 표시</);
});
