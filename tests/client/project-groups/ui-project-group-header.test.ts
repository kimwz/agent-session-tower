import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceContext } from '../../../client/src/workspace/WorkspaceOverlay.js';
import { ProjectGroupHeader, type ProjectGroupHeaderData } from '../../../client/src/project-groups/ProjectGroupHeader.js';
import { repositoryOutOfSync } from '../../../client/src/project-groups/RepositorySync.js';
import type { RepositoryStatus } from '../../../shared/repositories.js';

const data = (patch: Partial<ProjectGroupHeaderData> = {}): ProjectGroupHeaderData => ({
  token: 'test-token', name: 'monitor', title: '', path: '/Users/me/monitor', count: 3, active: 0, pinned: false, hidden: false, manual: false,
  disabled: false, saving: false, onUpdate: async () => true, onCreate() {}, ...patch,
});
const header = (patch: Partial<ProjectGroupHeaderData> = {}) =>
  renderToStaticMarkup(createElement(WorkspaceContext.Provider, { value: () => {} }, createElement(ProjectGroupHeader, { data: data(patch) })));

test('a folder group shows its name, full path and how many sessions it holds', () => {
  const markup = header();
  assert.match(markup, /class="project-group-title">.*<bdi dir="ltr">monitor<\/bdi>/s);
  assert.match(markup, /class="project-group-path folder-tail" title="\/Users\/me\/monitor"/);
  assert.match(markup, /<span>3개 세션<\/span>/);
});

test('a folder group with running agents says how many are working', () => {
  assert.match(header({ active: 2 }), /<span>3개 세션 · 2개 작업 중<\/span>/);
});

test('pinning and hiding report their current state to assistive technology', () => {
  const plain = header();
  assert.match(plain, /aria-label="monitor 그룹 고정" aria-pressed="false"/);
  assert.match(plain, /aria-label="monitor 폴더 숨기기" aria-pressed="false"/);
  const marked = header({ pinned: true, hidden: true });
  assert.match(marked, /aria-label="monitor 그룹 고정 해제" aria-pressed="true"/);
  assert.match(marked, /aria-label="monitor 폴더 숨김 해제" aria-pressed="true"/);
});

test('a group that is not a real folder cannot be renamed, pinned or hidden', () => {
  const markup = header({ path: '알 수 없음', name: '알 수 없음' });
  assert.equal((markup.match(/<button\b[^>]*\sdisabled=""[^>]*>/g) || []).length, 6);
});

test('a save still in flight blocks every group action', () => {
  assert.equal((header({ saving: true }).match(/<button\b[^>]*\sdisabled=""[^>]*>/g) || []).length, 5);
  assert.doesNotMatch(header(), /disabled=""/);
});

test('a failed group change is announced where the group is shown', () => {
  assert.match(header({ error: '그룹을 저장하지 못했습니다. 다시 시도해 주세요.' }), /class="project-group-error nodrag nopan" role="alert">그룹을 저장하지 못했습니다/);
  assert.doesNotMatch(header(), /project-group-error/);
});

test('only a hand-arranged canvas shows the drag grip', () => {
  assert.match(header({ manual: true }), /project-drag-grip/);
  assert.doesNotMatch(header(), /project-drag-grip/);
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

test('another computer’s folder shows its own path and offers that computer’s file tools', () => {
  const node = 'b'.repeat(32);
  const markup = header({ path: `@${node}//Users/me/monitor` });
  assert.match(markup, /class="project-group-path folder-tail" title="\/Users\/me\/monitor"><bdi dir="ltr">\/Users\/me\/monitor<\/bdi>/);
  assert.doesNotMatch(markup, new RegExp(node));
  assert.match(markup, /aria-label="monitor 폴더에 새 세션"(?![^>]*disabled)/);
  assert.match(markup, /workspace-actions/);
});
