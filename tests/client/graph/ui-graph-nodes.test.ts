import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type FunctionComponent, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { AgentNode, HostNode, ProjectGroupNode, type AgentData, type HostData, type ProjectData } from '../../../client/src/graph/GraphNodes.js';
import type { Session } from '../../../shared/types.js';

// React Flow's Handle reads the canvas store, so every node renders inside a provider.
const render = (element: ReactElement) => renderToStaticMarkup(createElement(ReactFlowProvider, null, element));
// React Flow gives a node its id and its stored data; that is the whole contract these nodes read.
const node = (component: unknown, data: unknown) =>
  render(createElement(component as FunctionComponent<{ id: string; data: unknown }>, { id: 'node', data }));

const session = (patch: Partial<Session> = {}): Session => ({
  id: 'claude:1', nativeId: 'native-1', provider: 'claude', title: '리팩터링 계획 세우기', cwd: '/Users/me/monitor', project: 'monitor',
  status: 'working', statusReason: '작업 중', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
  lastCompletedAt: '2026-09-15T00:00:00.000Z', lastMessage: '스타일시트를 화면별로 나눴습니다.', messageCount: 12,
  isSubagent: false, resumable: true, ...patch,
});
const agent = (patch: Partial<Session> = {}, data: Partial<AgentData> = {}): string =>
  node(AgentNode, { session: session(patch), selected: false, unread: false, onSelect() {}, ...data } satisfies AgentData);
const projectData = (patch: Partial<ProjectData> = {}): ProjectData => ({
  name: 'monitor', title: '', path: '/Users/me/monitor', count: 3, active: 1, pinned: false, hidden: false, manual: false,
  disabled: false, saving: false, onUpdate: async () => true, onCreate() {}, onAutoPrompt() {}, ...patch,
});
const host = (patch: Partial<HostData> = {}): string =>
  node(HostNode, { name: 'studio', active: 0, providers: [], disabled: false, onAutoPrompt() {}, ...patch } satisfies HostData);

test('an agent card names its provider, title and status in one screen-reader label', () => {
  const markup = agent();
  assert.match(markup, /aria-label="Claude Code: 리팩터링 계획 세우기, 작업 중, 확인함\. 대화 열기"/);
  assert.match(markup, /class="agent-card-title" title="리팩터링 계획 세우기">리팩터링 계획 세우기</);
  assert.match(markup, /class="agent-provider">Claude Code</);
});

test('an agent card with new activity is marked unread for both sighted and assisted readers', () => {
  const unread = agent({}, { unread: true });
  assert.match(unread, /class="agent-card claude working  has-unread"/);
  assert.match(unread, /class="agent-unread"><i><\/i>새 활동</);
  assert.match(unread, /, 새 활동\. 대화 열기"/);
  assert.doesNotMatch(agent(), /agent-unread/);
});

test('a working agent shows the live activity border that a completed one drops', () => {
  assert.match(agent(), /class="agent-activity-border"/);
  const completed = agent({ status: 'completed' });
  assert.doesNotMatch(completed, /agent-activity-border/);
  assert.match(completed, /class="agent-state completed"/);
});

test('a subagent card carries the branch mark and an empty conversation invites a first look', () => {
  assert.match(agent({ isSubagent: true }), /class="subagent-mark" title="하위 에이전트"/);
  assert.doesNotMatch(agent(), /subagent-mark/);
  assert.match(agent({ lastMessage: '' }), /class="agent-card-preview">대화 기록을 확인하세요</);
});

test('a project lane offers Auto Prompt for a real folder and refuses a placeholder path', () => {
  assert.match(node(ProjectGroupNode, projectData()), /class="auto-prompt-trigger nodrag nopan" aria-label="monitor 폴더에서 Auto Prompt 열기" title="Auto Prompt"(?! disabled)/);
  assert.match(node(ProjectGroupNode, projectData({ path: '알 수 없음', name: '알 수 없음' })), /auto-prompt-trigger[^>]*disabled=""/);
});

test('an empty project lane explains how to start a session there', () => {
  assert.match(node(ProjectGroupNode, projectData({ count: 0 })), /class="project-group-empty">표시된 세션이 없습니다<span>\+ 버튼으로 이 폴더에서 시작하세요/);
  assert.doesNotMatch(node(ProjectGroupNode, projectData()), /project-group-empty/);
});

test('a hidden project lane is styled as hidden while a visible one is not', () => {
  assert.match(node(ProjectGroupNode, projectData({ hidden: true })), /class="manual-project-lane is-hidden"/);
  assert.match(node(ProjectGroupNode, projectData()), /class="manual-project-lane "/);
});

test('the host counts the agents working on this Mac and falls back to a generic name', () => {
  assert.match(host({ active: 2 }), /<i class="live-pip"><\/i><span>2개 에이전트 작업 중/);
  assert.match(host(), /다음 작업을 기다리는 중/);
  assert.match(host({ name: '' }), /<strong title="">이 Mac<\/strong>/);
});

test('the host disables Auto Prompt while the connection cannot start a run', () => {
  assert.match(host({ disabled: true }), /auto-prompt-trigger[^>]*disabled=""/);
  assert.doesNotMatch(host(), /disabled=""/);
});

test('a joined computer’s host node says whether it is connected, out of date or needs an update', () => {
  const live = host({ name: 'studio', link: { status: 'connected', live: true, version: '1.23.0' } });
  assert.match(live, /class="host-with-usage is-remote"/);
  assert.match(live, /class="host-link connected live" role="status"><i><\/i>연결됨 · v1\.23\.0/);
  assert.match(live, /aria-label="studio에서 Auto Prompt 열기"/);
  const away = host({ name: 'studio', link: { status: 'offline', live: false } });
  assert.match(away, /class="host-with-usage is-remote is-stale"/);
  assert.match(away, /<i><\/i>오프라인<\/span>/, 'the version is left out while it is away');
  assert.match(away, /마지막으로 본 상태입니다/);
  assert.match(host({ link: { status: 'update-required', live: false } }), /업데이트 필요/);
  assert.doesNotMatch(host(), /host-link/, 'this computer’s own host node is unchanged');
});

test('cards of an unreachable computer are marked as its last known state', () => {
  assert.match(agent({}, { stale: true }), /class="agent-card claude working [^"]*is-stale"/);
});
