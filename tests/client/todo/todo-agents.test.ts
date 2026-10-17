import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '../../../shared/types.js';
import type { TodoAgent, TodoTask } from '../../../shared/todo/types.js';
import { TaskCard } from '../../../client/src/todo/TaskCard.js';
import { TaskDetail, type DetailTab } from '../../../client/src/todo/TaskDetail.js';
import { agentLook, TodoAgentContext, type TodoAgentView } from '../../../client/src/todo/todo-agents.js';
import { cardContext } from '../../../client/src/todo/todo-views.js';
import { emptyWorld, withDetail, worldFromOverview } from '../../../client/src/todo/todo-model.js';
import { overview, task } from './fixtures.js';

const agent = (taskId: string, patch: Partial<TodoAgent> = {}): TodoAgent => ({ taskId, provider: 'claude', state: 'active', sessionId: `claude:${taskId}`, createdAt: 'x', updatedAt: 'x', ...patch });
const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, nativeId: id, provider: 'claude', title: id, cwd: '/state/todo-masters/a', project: 'a', status: 'idle', statusReason: '',
  createdAt: 'x', updatedAt: 'x', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, master: true, ...patch });
const view = (sessions: Session[], chat = (id: string) => `chat of ${id}`): TodoAgentView => ({ session: id => sessions.find(item => item.id === id), chat: id => chat(id) });
const within = (value: TodoAgentView, element: ReactNode) => renderToStaticMarkup(createElement(TodoAgentContext.Provider, { value }, element));

const card = (item: TodoTask, agents: Record<string, TodoAgent>, extra: Record<string, unknown> = {}) => {
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: () => null, setItem() {} } };
  const world = worldFromOverview(overview([item], { agents }), emptyWorld());
  return createElement(TaskCard, { task: item, context: cardContext(world, '2026-10-14', false), onOpen() {}, onComplete() {}, onCompleteNext() {}, onChat() {}, ...extra });
};

test('a card without an issue master offers a chat; with one it shows the master as the chat header shows a session', () => {
  const empty = within(view([]), card(task('a'), {}));
  assert.match(empty, /class="todo-card-chat icon-button "/, 'offered, shown on hover by the stylesheet');
  assert.doesNotMatch(empty, /agent-orb/);

  const idle = within(view([session('claude:a', { contextUsage: { usedTokens: 50_000, windowTokens: 200_000 } as Session['contextUsage'] })]), card(task('a'), { a: agent('a') }));
  assert.match(idle, /class="todo-card-chat icon-button active"/);
  assert.match(idle, /class="chat-context-icon todo-agent-icon idle"/, 'grey while it waits');
  assert.match(idle, /agent-orb-wrap claude compact/);

  const working = within(view([session('claude:a', { status: 'working' })]), card(task('a'), { a: agent('a') }));
  assert.match(working, /todo-agent-icon working/, 'in colour while it works');
  // A session the page has not been sent yet shows the master's provider, grey.
  assert.match(within(view([]), card(task('a'), { a: agent('a', { provider: 'codex' }) })), /todo-agent-icon idle.*agent-orb-wrap codex/s);
});

test('a card that cannot start a chat offers none, but still shows a master it has', () => {
  assert.doesNotMatch(within(view([]), card(task('a', { completedAt: 'x' }), {})), /todo-card-chat/);
  assert.doesNotMatch(within(view([]), card(task('a'), {}, { readOnly: true })), /todo-card-chat/);
  assert.match(within(view([]), card(task('a', { completedAt: 'x' }), { a: agent('a', { state: 'closing' }) })), /todo-agent-icon/);
});

test('the icon follows the session: starting shows at work, and what waits for the owner is flagged', () => {
  assert.deepEqual(agentLook(agent('a', { state: 'starting', sessionId: undefined }), undefined), { provider: 'claude', status: 'working' });
  assert.equal(agentLook(agent('a'), session('claude:a', { status: 'error' })).flag, 'error');
  assert.equal(agentLook(agent('a'), session('claude:a', { outcome: 'needsOwner' })).flag, 'needsOwner');
  assert.equal(agentLook(agent('a'), session('claude:a', { status: 'working', outcome: 'needsOwner' })).flag, undefined, 'at work again, nothing waits');
  assert.equal(agentLook(agent('a'), session('claude:a', { outcome: 'done' })).flag, undefined);
});

const detail = (item: TodoTask, agents: Record<string, TodoAgent>, tab: DetailTab, readOnly = false) => {
  const world = withDetail(worldFromOverview(overview([item], { agents }), emptyWorld()), { task: item, subtasks: [], comments: [], files: [], completions: [], events: [], previous: [], next: [] });
  const uploads = { subscribe: () => () => undefined, getJobs: () => [], add() {}, cancel() {}, retry() {} };
  return createElement(TaskDetail, { taskId: item.id, world, error: '', today: '2026-10-14', client: { today: () => '2026-10-14' } as never, actions: {} as never,
    readOnly, uploads: uploads as never, onClose() {}, onOpen() {}, onProject() {}, onFollowUp() {}, tab, onTab() {} });
};

test('the detail has two tabs; the chat tab starts an issue master with a first message', () => {
  const shown = within(view([]), detail(task('a'), {}, 'detail'));
  assert.match(shown, /role="tab" aria-selected="true">상세<.*role="tab" aria-selected="false">채팅</s);
  assert.match(shown, /todo-properties/);

  const start = within(view([]), detail(task('a'), {}, 'chat'));
  assert.match(start, /role="tab" aria-selected="true">채팅</);
  assert.match(start, /첫 메시지를 보내면 이 할 일 전용 마스터가 이슈 내용과 첨부를 먼저 읽고 시작합니다\./);
  assert.match(start, /<textarea[^>]*maxLength="32000"/);
  assert.doesNotMatch(start, /todo-properties/, 'the chat takes the panel');
  assert.match(within(view([]), detail(task('a', { completedAt: 'x' }), {}, 'chat')), /<textarea[^>]*disabled/, 'a closed todo starts none');
  assert.match(within(view([]), detail(task('a'), {}, 'chat', true)), /<textarea[^>]*disabled/, 'nor a read-only one');
});

test('with an issue master the chat tab is its conversation, and a starting one says so', () => {
  const chat = within(view([session('claude:a')]), detail(task('a'), { a: agent('a') }, 'chat'));
  assert.match(chat, /<div class="todo-detail-chat">chat of claude:a<\/div>/);
  assert.match(chat, /role="tab" aria-selected="true"><span class="chat-context-icon todo-agent-icon idle">/, 'the tab shows the master too');
  const starting = within(view([]), detail(task('a'), { a: agent('a', { state: 'starting', sessionId: undefined }) }, 'chat'));
  assert.match(starting, /이슈 마스터를 시작하는 중입니다\./);
  assert.doesNotMatch(starting, /<textarea/);
});
