import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { parseSlackPosition, visibleSlackMentions } from '../../../client/src/graph/slack-graph.js';
import { SlackMonitorNode, SlackMentionNode } from '../../../client/src/graph/SlackGraphNodes.js';
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
test('monitor offers draggable header, overview and empty state even with no sessions', () => {
  const markup = node(SlackMonitorNode, { name: 'Team', enabled: true, status: 'connected', count: 0, active: 0, remaining: 0, onMore() {} });
  assert.match(markup, /slack-monitor-drag-handle/);
  assert.match(markup, /Slack 모니터 열기/);
  assert.match(markup, /slack-monitor-empty/);
  assert.doesNotMatch(markup, /agent-activity-border/);
});
test('active Slack monitor and mention cards reuse the session activity border', () => {
  assert.match(node(SlackMonitorNode, { name: 'Team', enabled: true, status: 'connected', count: 1, active: 1, remaining: 0, onMore() {} }), /agent-activity-border/);
  for (const status of ['received', 'matching', 'dispatching', 'running', 'composing', 'sending'] as const) assert.match(node(SlackMentionNode, { event: event('1', status), selected: false }), /agent-activity-border/);
  for (const status of ['ignored', 'completed', 'error', 'reply-uncertain'] as const) assert.doesNotMatch(node(SlackMentionNode, { event: event('1', status), selected: false }), /agent-activity-border/);
});

test('enabled monitor distinguishes transport failure and reconnecting from healthy waiting', () => {
  const base = { name: 'Team', enabled: true, count: 0, active: 0, remaining: 0, onMore() {} };
  const failed = node(SlackMonitorNode, { ...base, status: 'error', error: 'Socket disconnected' });
  assert.match(failed, /Slack 연결 오류/);
  assert.match(failed, /title="Socket disconnected"/);
  assert.doesNotMatch(failed, /멘션을 기다리는 중/);
  const reconnecting = node(SlackMonitorNode, { ...base, status: 'connecting' });
  assert.match(reconnecting, /Slack 연결 중/);
  assert.doesNotMatch(reconnecting, /멘션을 기다리는 중/);
  assert.match(node(SlackMonitorNode, { ...base, status: 'connected' }), /멘션을 기다리는 중/);
  const activeFailure = node(SlackMonitorNode, { ...base, active: 1, status: 'error' });
  assert.match(activeFailure, /1개 작업 중/);
  assert.match(activeFailure, /Slack 연결 오류/);
});
