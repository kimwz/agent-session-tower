import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '../../../shared/types.js';
import type { TodoAgent, TodoTask } from '../../../shared/todo/types.js';
import { OWN_PRESS, TaskCard } from '../../../client/src/todo/TaskCard.js';
import { TaskDetail, type DetailTab } from '../../../client/src/todo/TaskDetail.js';
import { agentLook, masterOpener, screenSelect, TodoAgentContext, type TodoAgentView } from '../../../client/src/todo/todo-agents.js';
import { cardContext } from '../../../client/src/todo/todo-views.js';
import { emptyWorld, withDetail, worldFromOverview } from '../../../client/src/todo/todo-model.js';
import { forgetFoldedForTests } from '../../../client/src/todo/todo-prefs.js';
import { overview, task } from './fixtures.js';

const agent = (taskId: string, patch: Partial<TodoAgent> = {}): TodoAgent => ({ taskId, provider: 'claude', state: 'active', sessionId: `claude:${taskId}`, createdAt: 'x', updatedAt: 'x', ...patch });
const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, nativeId: id, provider: 'claude', title: id, cwd: '/state/todo-masters/a', project: 'a', status: 'idle', statusReason: '',
  createdAt: 'x', updatedAt: 'x', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, master: true, ...patch });
const view = (sessions: Session[], chat = (id: string) => `chat of ${id}`, running: Record<string, number> = {}): TodoAgentView => ({ session: id => sessions.find(item => item.id === id), chat: id => chat(id), running: id => running[id] ?? 0 });
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
  assert.deepEqual(agentLook(agent('a', { state: 'starting', sessionId: undefined }), undefined), { provider: 'claude', status: 'working', running: 0 });
  assert.equal(agentLook(agent('a'), session('claude:a', { status: 'error' })).flag, 'error');
  assert.equal(agentLook(agent('a'), session('claude:a', { outcome: 'needsOwner' })).flag, 'needsOwner');
  assert.equal(agentLook(agent('a'), session('claude:a', { status: 'working', outcome: 'needsOwner' })).flag, undefined, 'at work again, nothing waits');
  assert.equal(agentLook(agent('a'), session('claude:a', { outcome: 'done' })).flag, undefined);
});

const detail = (item: TodoTask, agents: Record<string, TodoAgent>, tab: DetailTab, readOnly = false) => {
  const world = withDetail(worldFromOverview(overview([item], { agents }), emptyWorld()), { task: item, subtasks: [], comments: [], files: [], completions: [], events: [], previous: [], next: [] });
  const uploads = { subscribe: () => () => undefined, getJobs: () => [], add() {}, cancel() {}, retry() {} };
  return createElement(TaskDetail, { taskId: item.id, world, error: '', today: '2026-10-14', client: { today: () => '2026-10-14' } as never, actions: {} as never,
    readOnly, uploads: uploads as never, onClose() {}, onOpen() {}, onFollowUp() {}, tab, onTab() {} });
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

test('a press on the card\'s chat icon never reaches the board\'s drag sensors', () => {
  // The board drags from mousedown (MouseSensor), touchstart (TouchSensor) and pointerdown.
  for (const name of ['onMouseDown', 'onTouchStart', 'onPointerDown'] as const) {
    let stopped = false;
    OWN_PRESS[name]({ stopPropagation: () => { stopped = true; } });
    assert.ok(stopped, name);
  }
});

test('the master\'s close leaves an issue chat the Todo page shows, and otherwise closes the canvas conversation', () => {
  const selected: (string | null)[] = [];
  let left = 0;
  let open: (() => void) | null = () => { left++; };
  const select = screenSelect(id => selected.push(id), () => open);
  select(null);
  assert.deepEqual([left, selected], [1, []], 'the issue chat goes back to its details');
  select('claude:x');
  assert.deepEqual(selected, ['claude:x'], 'opening a session is the canvas\'s as before');
  open = null;
  select(null);
  assert.deepEqual(selected, ['claude:x', null]);
});

test('the master\'s button opens its conversation over the Todo page while that page shows, and on the canvas otherwise', () => {
  const overTodo: (string | null)[] = [];
  const selected: (string | null)[] = [];
  let onTodo = true;
  const open = masterOpener(() => onTodo, id => overTodo.push(id), id => selected.push(id));
  open('claude:master');
  open(null);
  assert.deepEqual([overTodo, selected], [['claude:master', null], []], 'the owner stays on the Todo page');
  onTodo = false;
  open('claude:master');
  assert.deepEqual([overTodo, selected], [['claude:master', null], ['claude:master']], 'the page is read at each press: on the canvas, as before');
});

test('a todo whose issue master waits while the work it handed out runs is at work: coloured icon, the count, the moving border', () => {
  assert.equal(agentLook(agent('a'), session('claude:a'), 2).status, 'working');
  const busy = within(view([session('claude:a')], undefined, { a: 2 }), card(task('a'), { a: agent('a') }));
  assert.match(busy, /agent-activity-border/, 'the card wears the canvas\'s moving border');
  assert.match(busy, /todo-agent-icon working/);
  assert.match(busy, /class="todo-agent-running"[^>]*>2</);
  const idle = within(view([session('claude:a')]), card(task('a'), { a: agent('a') }));
  assert.doesNotMatch(idle, /agent-activity-border|todo-agent-running/, 'nothing under way: no border, no count');
  assert.doesNotMatch(within(view([session('claude:a', { status: 'working' })], undefined, { a: 1 }), card(task('a', { completedAt: 'x' }), { a: agent('a', { state: 'closing' }) })), /agent-activity-border/, 'a completed card is not at work');
  // What waits for the owner stays flagged while handed-out work runs.
  assert.equal(agentLook(agent('a'), session('claude:a', { outcome: 'needsOwner' }), 1).flag, 'needsOwner');
});

// A parent with five sub-tasks, the first done; masters on the second (idle) and the fifth, outside the card's run.
const family = () => {
  const parent = task('p', { content: 'Parent' });
  const subtasks = [1, 2, 3, 4, 5].map(n => task(`p${n}`, { parentId: 'p', content: `Step ${n}`, sortKey: `${n}`, ...(n === 1 ? { completedAt: 'x' } : {}) }));
  return { parent, subtasks, agents: { p2: agent('p2'), p5: agent('p5', { provider: 'codex' }) } };
};
const familyCard = (sessions: Session[], folded = false) => {
  const { parent, subtasks, agents } = family();
  // The card's fold, as this browser remembers it (todo-prefs.ts).
  forgetFoldedForTests();
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: () => folded ? JSON.stringify(['p']) : null, setItem() {} } };
  const world = worldFromOverview(overview([parent, ...subtasks.slice(1)], { agents, doneSubtasks: [subtasks[0]], subtaskCounts: { p: { done: 1, total: 5 } } }), emptyWorld());
  return within(view(sessions), createElement(TaskCard, { task: world.tasks.p, context: cardContext(world, '2026-10-14', false), onOpen() {}, onComplete() {}, onCompleteNext() {}, onChat() {} }));
};
const rowsOf = (markup: string) => [...markup.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(match => ({ title: /todo-subtask-title"[^>]*>([^<]+)</.exec(match[1])?.[1], border: match[1].includes('agent-activity-border'), icon: /todo-agent-icon (\w+)/.exec(match[1])?.[1] }));

test('a sub-task at work shows it on its parent\'s card as a card does, and stays listed outside the run', () => {
  const markup = familyCard([session('claude:p2'), session('claude:p5', { provider: 'codex', status: 'working' })]);
  assert.deepEqual(rowsOf(markup), [
    { title: 'Step 1', border: false, icon: undefined },
    { title: 'Step 2', border: false, icon: 'idle' },
    { title: 'Step 3', border: false, icon: undefined },
    { title: 'Step 5', border: true, icon: 'working' },
  ], 'the run as before, the idle master grey without a border, the one at work after it with the moving border');
  assert.match(markup, /class="todo-subtask-chat icon-button"[^>]*aria-label="이슈 채팅"/, 'the icon opens its chat');
  assert.match(markup, />1건 더 있음</, 'only what is left out is counted');
  // Nothing at work: the window as before.
  assert.deepEqual(rowsOf(familyCard([session('claude:p2'), session('claude:p5', { provider: 'codex' })])).map(row => row.title), ['Step 1', 'Step 2', 'Step 3']);
});

test('a folded card still lists its sub-tasks at work, and only them', () => {
  const folded = familyCard([session('claude:p2', { status: 'working' }), session('claude:p5', { provider: 'codex' })], true);
  assert.match(folded, /aria-expanded="false"/);
  assert.deepEqual(rowsOf(folded), [{ title: 'Step 2', border: true, icon: 'working' }]);
  assert.doesNotMatch(folded, /건 더 있음/);
  assert.doesNotMatch(familyCard([session('claude:p2'), session('claude:p5', { provider: 'codex' })], true), /<ul>/, 'none at work: folded as before');
});

test('the parent\'s detail shows each sub-task\'s master as its card does', () => {
  const { parent, subtasks, agents } = family();
  const world = withDetail(worldFromOverview(overview([parent, ...subtasks.slice(1)], { agents }), emptyWorld()), { task: parent, subtasks, comments: [], files: [], completions: [], events: [], previous: [], next: [] });
  const uploads = { subscribe: () => () => undefined, getJobs: () => [], add() {}, cancel() {}, retry() {} };
  const markup = within(view([session('claude:p2'), session('claude:p5', { provider: 'codex', status: 'working' })]), createElement(TaskDetail, { taskId: 'p', world, error: '', today: '2026-10-14', client: { today: () => '2026-10-14' } as never,
    actions: {} as never, readOnly: false, uploads: uploads as never, onClose() {}, onOpen() {}, onFollowUp() {}, tab: 'detail', onTab() {} }));
  const list = /<ul class="todo-subtask-list">(.*?)<\/ul>/.exec(markup)?.[1] ?? '';
  const rows = [...list.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(match => `${/>(Step \d)</.exec(match[1])?.[1]}:${match[1].includes('agent-activity-border') ? 'border' : '-'}:${/todo-agent-icon (\w+)/.exec(match[1])?.[1] ?? '-'}`);
  assert.deepEqual(rows, ['Step 1:-:-', 'Step 2:-:idle', 'Step 3:-:-', 'Step 4:-:-', 'Step 5:border:working']);
});
