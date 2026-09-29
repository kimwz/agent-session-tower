import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceContext } from '../../../client/src/workspace/WorkspaceOverlay.js';
import { ProjectGroupHeader, ProjectGroupMenu, type ProjectGroupHeaderData } from '../../../client/src/project-groups/ProjectGroupHeader.js';
import { repositoryAgentDraft, repositoryOutOfSync } from '../../../client/src/project-groups/RepositorySync.js';
import type { RepositoryStatus } from '../../../shared/repositories.js';

const data = (patch: Partial<ProjectGroupHeaderData> = {}): ProjectGroupHeaderData => ({
  token: 'test-token', name: 'monitor', title: '', path: '/Users/me/monitor', count: 3, active: 0, pinned: false, hidden: false, columns: 1, onColumnsChange() {},
  disabled: false, saving: false, onUpdate: async () => true, onCreate() {}, ...patch,
});
const withWorkspace = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(WorkspaceContext.Provider, { value: () => {} }, element));
const header = (patch: Partial<ProjectGroupHeaderData> = {}) => withWorkspace(createElement(ProjectGroupHeader, { data: data(patch) }));
const menu = (patch: Partial<ProjectGroupHeaderData> = {}) => withWorkspace(createElement(ProjectGroupMenu, { data: data(patch), onEditTitle() {}, onDone() {} }));
const disabledCount = (markup: string) => (markup.match(/<button\b[^>]*\sdisabled=""[^>]*>/g) || []).length;

test('a folder group shows its name, full path and how many sessions it holds', () => {
  const markup = header();
  assert.match(markup, /class="project-group-title">.*<bdi dir="ltr">monitor<\/bdi>/s);
  assert.match(markup, /class="project-group-path folder-tail" title="\/Users\/me\/monitor"/);
  assert.match(markup, /<span>3개 세션<\/span>/);
});

test('a folder group with running agents says how many are working', () => {
  assert.match(header({ active: 2 }), /<span>3개 세션 · 2개 작업 중<\/span>/);
});

test('the header keeps only pinning and a settings button; the other folder actions wait in the settings menu', () => {
  const markup = header();
  assert.equal((markup.match(/<button\b/g) || []).length, 2);
  assert.match(markup, /aria-label="monitor 그룹 고정" aria-pressed="false"/);
  assert.match(markup, /aria-label="monitor 폴더 설정" title="폴더 설정" aria-expanded="false"/);
  assert.doesNotMatch(markup, /project-drag-grip|workspace-actions|폴더에 새 세션/);
  const items = menu();
  for (const label of ['이 폴더에 새 세션', '브라우저 코드 에디터 열기', '브라우저 터미널 열기', '그룹 제목 편집', '폴더와 세션을 캔버스에서 숨기기']) assert.match(items, new RegExp(`</svg>${label}</button>`));
});

test('pinning and hiding report their current state to assistive technology', () => {
  assert.match(header(), /aria-label="monitor 그룹 고정" aria-pressed="false"/);
  assert.match(menu(), /aria-pressed="false"[^>]*>.*폴더와 세션을 캔버스에서 숨기기/);
  assert.match(header({ pinned: true }), /aria-label="monitor 그룹 고정 해제" aria-pressed="true"/);
  assert.match(menu({ hidden: true }), /aria-pressed="true"[^>]*>.*폴더 숨김 해제/);
});

test('the settings menu offers one to four sessions per row and marks the folder’s current choice', () => {
  const markup = menu({ columns: 2 });
  assert.match(markup, /role="group" aria-label="한 줄에 놓을 세션 수"/);
  assert.deepEqual([...markup.matchAll(/aria-pressed="(true|false)" aria-label="한 줄에 (\d)개"/g)].map(match => [match[2], match[1]]), [['1', 'false'], ['2', 'true'], ['3', 'false'], ['4', 'false']]);
});

test('a group that is not a real folder cannot be renamed, pinned, hidden or worked in, but its row width still changes', () => {
  const unknown = { path: '알 수 없음', name: '알 수 없음' };
  assert.equal(disabledCount(header(unknown)), 1);
  assert.equal(disabledCount(menu(unknown)), 7);
  assert.doesNotMatch(menu(unknown), /disabled=""[^>]*aria-label="한 줄에/);
});

test('a save still in flight blocks every group change', () => {
  assert.equal(disabledCount(header({ saving: true })), 1);
  assert.equal(disabledCount(menu({ saving: true })), 4);
  assert.doesNotMatch(header() + menu(), /disabled=""/);
});

test('folder tools that are out of reach say why inside the menu', () => {
  const markup = menu({ workspaceDisabled: true, workspaceNote: 'studio는 오프라인입니다.' });
  assert.equal(disabledCount(markup), 2);
  assert.match(markup, /class="project-group-menu-note">studio는 오프라인입니다\.<\/p>/);
});

test('a failed group change is announced where the group is shown', () => {
  assert.match(header({ error: '그룹을 저장하지 못했습니다. 다시 시도해 주세요.' }), /class="project-group-error nodrag nopan" role="alert">그룹을 저장하지 못했습니다/);
  assert.doesNotMatch(header(), /project-group-error/);
});

const repository = (patch: Partial<RepositoryStatus> = {}): RepositoryStatus => ({
  cwd: '/Users/me/monitor', root: '/Users/me/monitor', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0, checkedAt: '2026-09-24T00:00:00.000Z', ...patch,
});

test('a git folder shows how far its branch is behind or ahead of the remote, and says so in words', () => {
  const markup = header({ repository: repository({ behind: 3, ahead: 1, changes: 2 }), onRepositoryAction: async () => undefined });
  assert.match(markup, /class="repository-sync nodrag nopan out-of-sync"/);
  assert.match(markup, /aria-label="Git 동기화: main ↔ origin\/main: 3개 뒤처짐, 푸시하지 않은 커밋 1개, 커밋하지 않은 파일 2개"/);
  assert.match(markup, /<\/svg>3<\/span>.*<\/svg>1<\/span>/s);
});

test('a branch level with its remote shows a quiet badge, and uncommitted edits alone are not out of sync', () => {
  const markup = header({ repository: repository({ changes: 4 }), onRepositoryAction: async () => undefined });
  assert.match(markup, /class="repository-sync nodrag nopan"/);
  assert.equal(repositoryOutOfSync(repository({ upstream: undefined, ahead: 3 })), false);
  assert.doesNotMatch(header(), /repository-sync/);
});

test('handing a repository to an agent drafts a request that states where it stands and forbids destructive git', () => {
  const draft = repositoryAgentDraft(repository({ behind: 2, changes: 3 }));
  assert.equal(draft.title, 'Git 정리: main');
  assert.match(draft.prompt, /현재 상태: main ↔ origin\/main: 2개 뒤처짐, 커밋하지 않은 파일 3개/);
  assert.match(draft.prompt, /강제 푸시, reset --hard, 변경 사항 폐기는 하지 마세요/);
});

test('another computer’s folder shows its own path and offers that computer’s file tools', () => {
  const node = 'b'.repeat(32);
  const markup = header({ path: `@${node}//Users/me/monitor` });
  assert.match(markup, /class="project-group-path folder-tail" title="\/Users\/me\/monitor"><bdi dir="ltr">\/Users\/me\/monitor<\/bdi>/);
  assert.doesNotMatch(markup, new RegExp(node));
  assert.doesNotMatch(menu({ path: `@${node}//Users/me/monitor` }), /disabled=""/);
});

test('a folder on this computer opens its skills and permissions from its menu; a joined computer\'s folder does not', () => {
  assert.match(menu(), /이 폴더의 스킬.*이 폴더의 권한/s);
  assert.doesNotMatch(menu({ machine: 'node-1' } as Partial<ProjectGroupHeaderData>), /이 폴더의 권한/);
});
