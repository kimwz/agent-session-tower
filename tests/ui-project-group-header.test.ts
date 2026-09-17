import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectGroupHeader, type ProjectGroupHeaderData } from '../client/src/project-groups/ProjectGroupHeader.js';

const data = (patch: Partial<ProjectGroupHeaderData> = {}): ProjectGroupHeaderData => ({
  name: 'monitor', title: '', path: '/Users/me/monitor', count: 3, active: 0, pinned: false, hidden: false, manual: false,
  disabled: false, saving: false, onUpdate: async () => true, onCreate() {}, ...patch,
});
const header = (patch: Partial<ProjectGroupHeaderData> = {}) =>
  renderToStaticMarkup(createElement(ProjectGroupHeader, { data: data(patch) }));

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
  assert.equal((markup.match(/disabled=""/g) || []).length, 4);
});

test('a save still in flight blocks every group action', () => {
  assert.equal((header({ saving: true }).match(/disabled=""/g) || []).length, 3);
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
