import test, { afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskDetail } from '../../../client/src/todo/TaskDetail.js';
import { worldFromOverview, emptyWorld, withDetail } from '../../../client/src/todo/todo-model.js';
import { TaskCard } from '../../../client/src/todo/TaskCard.js';
import { cardContext } from '../../../client/src/todo/todo-views.js';
import { forgetFoldedForTests } from '../../../client/src/todo/todo-prefs.js';
import { movePreset, presetsDirty, presetsToSave, shownChatPresets } from '../../../client/src/todo/chat-presets.js';
import { setLanguage } from '../../../client/src/i18n/i18n.js';
import { overview, task } from './fixtures.js';
import type { TodoComment } from '../../../shared/todo/types.js';

// Each test brings its own browser stub (storage, window size) and leaves none behind.
afterEach(() => { delete (globalThis as { window?: unknown }).window; });

const render = (item: ReturnType<typeof task>, options: { tab?: 'detail' | 'chat'; chatPresets?: string[]; readOnly?: boolean; comments?: TodoComment[]; others?: ReturnType<typeof task>[] } = {}) => {
  const world = withDetail(worldFromOverview({ ...overview([item, ...options.others ?? []]), ...(options.chatPresets ? { chatPresets: options.chatPresets } : {}) }, emptyWorld()), { task: item, subtasks: [], comments: options.comments ?? [], files: [], completions: [], events: [], previous: [], next: [] });
  const uploads = { subscribe: () => () => undefined, getJobs: () => [], add() {}, cancel() {}, retry() {} };
  return renderToStaticMarkup(createElement(TaskDetail, { taskId: item.id, world, error: '', today: '2026-10-14', client: { today: () => '2026-10-14' } as never, actions: {} as never,
    readOnly: options.readOnly ?? false, uploads: uploads as never, onClose() {}, onOpen() {}, onFollowUp() {}, tab: options.tab ?? 'detail', onTab() {} }));
};

test('the detail puts the most used properties first; rare ones without a value become one row of additions', () => {
  const markup = render(task('a', { content: 'Plan', dueDate: '2026-10-14' }));
  const rows = [...markup.matchAll(/class="todo-property (\w+) ?(adding)?"/g)].map(match => match[2] ? `+${match[1]}` : match[1]);
  assert.deepEqual(rows, ['date', 'priority', 'labels', 'project', '+deadline', '+duration'], 'the most used first; the rare ones as additions after them');
  assert.match(markup, /＋ 마감일.*＋ 소요 시간/s);
  // The properties come before the description (a phone shows them as chips under the title), then the sections in order.
  const at = (text: string) => markup.indexOf(text);
  assert.ok(at('todo-properties') < at('todo-description-area') && at('todo-description-area') < at('>하위 작업<') && at('>하위 작업<') < at('>댓글<'));
  assert.doesNotMatch(markup, />없음</, 'no row of "none"');
  // One way to attach to the description, as a paperclip; no wordy button.
  assert.equal((markup.match(/aria-label="파일 첨부"/g) ?? []).length, 2, 'the description and the comment box');
  assert.doesNotMatch(markup, />파일 첨부</);
});

test('a rare property with a value takes its row, and the additions row is gone when none is left', () => {
  const markup = render(task('a', { deadlineDate: '2026-10-20', durationMin: 90 }));
  const rows = [...markup.matchAll(/class="todo-property (\w+) ?(adding)?"/g)].map(match => match[2] ? `+${match[1]}` : match[1]);
  assert.deepEqual(rows, ['date', 'priority', 'labels', 'project', 'deadline', 'duration']);
});

test('a todo synced with a GitHub issue heads its properties with a link that opens the issue in a new window', () => {
  const uploads = { subscribe: () => () => undefined, getJobs: () => [], add() {}, cancel() {}, retry() {} };
  const show = (item: ReturnType<typeof task>, github: { issues?: Record<string, { repo: string; number: number; url: string; error: string | null }>; detail?: { repo: string; number: number; url: string } }) => {
    const world = withDetail(worldFromOverview({ ...overview([item]), github: { bindings: [], issues: github.issues ?? {} } }, emptyWorld()),
      { task: item, subtasks: [], comments: [], files: [], completions: [], events: [], previous: [], next: [], ...(github.detail ? { github: github.detail } : {}) });
    return renderToStaticMarkup(createElement(TaskDetail, { taskId: item.id, world, error: '', today: '2026-10-14', client: { today: () => '2026-10-14' } as never, actions: {} as never,
      readOnly: true, uploads: uploads as never, onClose() {}, onOpen() {}, onFollowUp() {}, tab: 'detail', onTab() {} }));
  };
  const url = 'https://github.com/o/r/issues/7';
  const open = show(task('a'), { issues: { a: { repo: 'o/r', number: 7, url, error: null } } });
  assert.deepEqual([...open.matchAll(/class="todo-property (\w+)/g)].map(match => match[1]).slice(0, 2), ['github', 'date'], 'first in the card, read-only too');
  assert.match(open, /<a class="todo-property-value todo-outside-link todo-github-link " href="https:\/\/github.com\/o\/r\/issues\/7" target="_blank" rel="noreferrer"[^>]*><span>o\/r#7<\/span>/);
  // A completed todo is no longer in the overview's issues; its detail still knows the issue.
  assert.match(show(task('b', { completedAt: '2026-10-14T01:00:00.000Z' }), { detail: { repo: 'o/r', number: 8, url } }), /todo-github-link[^>]*><span>o\/r#8</);
  // A sync problem shows red, with the reason in its hover text.
  assert.match(show(task('c'), { issues: { c: { repo: 'o/r', number: 9, url, error: 'boom' } } }), /class="todo-property-value todo-outside-link todo-github-link error"[^>]*title="o\/r#9 — boom"/);
  assert.doesNotMatch(show(task('d'), {}), /todo-github-link/, 'none without an issue');
});

test('a todo from a Slack thread heads its properties with a link that opens that thread in a new window', () => {
  const markup = render(task('a', { slackThread: { teamId: 'TBMLFLL3F', channel: 'C0A88QQ5607', threadTs: '1792746520.260769' } }));
  assert.deepEqual([...markup.matchAll(/class="todo-property (\w+)/g)].map(match => match[1]).slice(0, 2), ['slack', 'date']);
  assert.match(markup, /<a class="todo-property-value todo-outside-link" href="https:\/\/slack.com\/archives\/C0A88QQ5607\/p1792746520260769" target="_blank" rel="noreferrer" title="[^"]*#C0A88QQ5607"><span>스레드 열기<\/span>/);
  assert.doesNotMatch(render(task('b')), /slack.com/, 'none without a thread');
});

test('a card shows its sub-tasks unless they were folded, a done one struck through', () => {
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: () => null, setItem() {} } };
  const parent = task('p'), open = task('c1', { parentId: 'p' }), done = task('c2', { parentId: 'p', completedAt: '2026-10-14T01:00:00.000Z' });
  const world = worldFromOverview(overview([parent, open, done]), emptyWorld());
  const markup = renderToStaticMarkup(createElement(TaskCard, { task: parent, context: cardContext(world, '2026-10-14', false), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, />c1</);
  assert.match(markup, /<li class="done">[^]*?>c2</, 'three or fewer show all, completed ones struck through');
});

test('a card title shows three lines at most, the whole of it in its hover text', () => {
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: () => null, setItem() {} } };
  const long = task('p', { content: 'A title long enough to need more than three lines on a board card' });
  const markup = renderToStaticMarkup(createElement(TaskCard, { task: long, context: cardContext(worldFromOverview(overview([long]), emptyWorld()), '2026-10-14', false), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  assert.match(markup, /<span class="todo-card-title" title="A title long enough to need more than three lines on a board card">/);
  const css = readFileSync(new URL('../../../client/src/styles/todo.css', import.meta.url), 'utf8');
  const rule = css.match(/^\.todo-card-title \{([^}]*)\}/m);
  assert.ok(rule);
  for (const part of ['display:-webkit-box;', '-webkit-box-orient:vertical;', '-webkit-line-clamp:3;', 'overflow:hidden;']) assert.ok(rule[1].includes(part), part);
});

test('a folded card lists no sub-tasks, and says so', () => {
  const values = new Map([['tower.todo.collapsedSubtasks', '["p"]']]);
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem() {} } };
  forgetFoldedForTests();
  const parent = task('p'), open = task('c1', { parentId: 'p' });
  const world = worldFromOverview(overview([parent, open]), emptyWorld());
  const markup = renderToStaticMarkup(createElement(TaskCard, { task: parent, context: cardContext(world, '2026-10-14', false), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, />c1</);
  forgetFoldedForTests();
});

test('a sub-task with a card of its own on the board is not listed again under its parent', () => {
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: () => null, setItem() {} } };
  forgetFoldedForTests();
  const parent = task('p'), dated = task('c1', { parentId: 'p', dueDate: '2026-10-14' }), other = task('c2', { parentId: 'p' });
  const world = worldFromOverview(overview([parent, dated, other]), emptyWorld());
  const markup = renderToStaticMarkup(createElement(TaskCard, { task: parent, context: cardContext(world, '2026-10-14', false, new Set(['p', 'c1'])), onOpen() {}, onComplete() {}, onCompleteNext() {} }));
  assert.doesNotMatch(markup, />c1</);
  assert.match(markup, />c2</);
});

test('an empty issue chat offers the presets as buttons: the saved ones in order, else the defaults, none for an empty list', t => {
  t.after(() => setLanguage('ko'));
  const presets = (markup: string) => [...markup.matchAll(/class="todo-agent-preset"( disabled="")? title="([^"]*)"/g)].map(match => `${match[1] ? '-' : ''}${match[2]}`);
  setLanguage('ko');
  assert.deepEqual(presets(render(task('a'), { tab: 'chat' })), ['작업 시작 해줘', '설계 해줘', '조사 해줘']);
  assert.deepEqual(presets(render(task('a'), { tab: 'chat', chatPresets: ['조사 해줘', '리뷰 해줘'] })), ['조사 해줘', '리뷰 해줘']);
  assert.doesNotMatch(render(task('a'), { tab: 'chat', chatPresets: [] }), /todo-agent-presets/);
  // They are disabled wherever sending is: a read-only page, a completed todo.
  assert.deepEqual(presets(render(task('a'), { tab: 'chat', chatPresets: ['go'], readOnly: true })), ['-go']);
  assert.deepEqual(presets(render(task('a', { completedAt: '2026-10-14T01:00:00.000Z' }), { tab: 'chat', chatPresets: ['go'] })), ['-go']);
  // The defaults follow the page's language; a saved list shows as written.
  setLanguage('en');
  assert.deepEqual(presets(render(task('a'), { tab: 'chat' })), ['Start the work', 'Design it', 'Research it']);
  assert.deepEqual(presets(render(task('a'), { tab: 'chat', chatPresets: ['조사 해줘'] })), ['조사 해줘']);
});

test('the tabs head the panel beside its buttons, with no project line; a sub-task shows its parent above its title', () => {
  setLanguage('ko');
  for (const tab of ['detail', 'chat'] as const) {
    const bar = /<header class="todo-detail-bar">([^]*?)<\/header>/.exec(render(task('a', { content: 'Plan' }), { tab }))?.[1] ?? '';
    assert.match(bar, /role="tablist" aria-label="작업 보기">.*>상세<.*>채팅<.*<\/div><span class="todo-spacer"><\/span>.*>완료</s, tab);
    assert.doesNotMatch(bar, /todo-dot|todo-breadcrumb/, 'the project is in the property card, not the bar');
  }
  const child = render(task('c', { content: 'Child', parentId: 'p' }), { others: [task('p', { content: 'Parent plan' })] });
  assert.match(child, /<div class="todo-detail-main"><button type="button" class="todo-detail-parent" title="상위 작업">.*<span>Parent plan<\/span><\/button><div class="todo-detail-heading">/s);
  assert.doesNotMatch(render(task('a')), /todo-detail-parent/);
  assert.doesNotMatch(render(task('c', { parentId: 'p' }), { tab: 'chat', others: [task('p')] }), /todo-detail-parent/, 'the chat tab keeps its room');
});

test('both tabs of the detail have a left edge to drag; it starts at 640px and comes back at the saved width', t => {
  setLanguage('ko');
  const handle = (markup: string) => /<div class="chat-resize-handle todo-detail-resize" role="separator" tabindex="0" aria-label="상세 패널 너비 조절" aria-orientation="vertical" aria-valuemin="480" aria-valuemax="[^"]+" aria-valuenow="(\d+)"/.exec(markup)?.[1];
  const values = new Map<string, string>();
  (globalThis as { window?: unknown }).window = { innerWidth: 1440, localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem() {} } };
  for (const tab of ['detail', 'chat'] as const) {
    const markup = render(task('a'), { tab });
    assert.equal(handle(markup), '640', tab);
    assert.match(markup, /class="todo-detail[^"]*" aria-label="[^"]*" tabindex="-1" style="--todo-detail-width:640px"/, tab);
  }
  values.set('agent-session-tower.todo-detail-width', '900');
  assert.equal(handle(render(task('a'))), '900');
  values.set('agent-session-tower.todo-detail-width', '5000');
  assert.equal(handle(render(task('a'))), '980', "no wider than leaves the header's controls beside it");
  values.set('agent-session-tower.todo-detail-width', '100');
  assert.equal(handle(render(task('a'))), '480', 'no narrower than the property card needs');
});

test('the presets editor saves trimmed rows without blanks, and a drag moves one row', () => {
  assert.deepEqual(presetsToSave([' a ', '', '  ', 'b']), ['a', 'b']);
  assert.deepEqual(movePreset(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(movePreset(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(movePreset(['a', 'b'], 0, -1), ['a', 'b'], 'a drop outside the list changes nothing');
  assert.deepEqual(shownChatPresets([]), []);
  // An edit is what would be saved differing from where the rows started.
  const start = ['작업 시작 해줘', '설계 해줘'];
  assert.equal(presetsDirty([...start], start), false);
  assert.equal(presetsDirty([...start, '  '], start), false, 'a blank row added is not saved, so no edit');
  assert.equal(presetsDirty(['설계 해줘', '작업 시작 해줘'], start), true, 'a new order is an edit');
  assert.equal(presetsDirty(['작업 시작 해줘 ', '설계 해줘'], start), false, 'spaces around are trimmed on saving');
  assert.equal(presetsDirty(['작업 시작 해줘'], start), true);
});

test('the comments are a region of their own after the task, each card saying who wrote it, and the box writes as the owner', () => {
  const at = '2026-10-14T01:00:00.000Z';
  const comment = (id: string, author: TodoComment['author']): TodoComment => ({ id, taskId: 'a', body: `body ${id}`, author, createdAt: at, updatedAt: at, deletedAt: null });
  const markup = render(task('a'), { comments: [comment('c1', 'owner'), comment('c2', 'agent'), comment('c3', null)] });
  const region = markup.indexOf('todo-comments-area');
  assert.ok(markup.indexOf('>하위 작업<') < region && markup.indexOf('todo-flow-actions') < region, 'after the task itself, its flow included');
  assert.deepEqual([...markup.matchAll(/<li class="todo-comment (\w+)">/g)].map(match => match[1]), ['owner', 'agent', 'unknown'], 'oldest first, each marked with its writer');
  assert.deepEqual([...markup.matchAll(/class="todo-comment-author"[^>]*>([^<]+)</g)].map(match => match[1]), ['나', '에이전트', '작성자 기록 없음']);
  assert.match(markup, /title="이 댓글에는 작성자 정보가 저장되어 있지 않습니다"/);
  assert.match(markup, /<div class="todo-comment-compose"><span class="todo-comment-avatar owner"/, 'the box is the owner’s');
  const readOnly = render(task('a'), { comments: [comment('c1', 'agent')], readOnly: true });
  assert.doesNotMatch(readOnly, /todo-comment-compose|aria-label="댓글 삭제"/);
  assert.match(readOnly, /<li class="todo-comment agent">/);
});
