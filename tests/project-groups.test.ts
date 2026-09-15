import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectGroup, Session } from '../shared/types.js';
import { includePinnedProjectGroups, projectGroupChoices, projectGroupLabel, visiblePinnedProjectGroups } from '../client/src/project-groups.js';

function session(id: string, cwd: string, project = cwd.split('/').at(-1)!): Session {
  return { id, nativeId: id, provider: 'codex', title: id, cwd, project, status: 'idle', statusReason: '', createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T00:00:00Z', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
}

const groups: ProjectGroup[] = [
  { cwd: '/work/api', title: '고객 결제', pinned: true },
  { cwd: '/other/api', title: 'Admin Panel', pinned: true },
  { cwd: '/한글 폴더/앱 100%', title: '', pinned: true },
  { cwd: '/work/title-only', title: '숨은 이름', pinned: false },
];

test('group identity stays the exact cwd despite matching basenames, spaces, Unicode, and percent signs', () => {
  const choices = projectGroupChoices([session('a', '/work/api'), session('b', '/other/api')], groups);
  assert.equal(choices.length, 3);
  assert.equal(new Map(choices).get('/work/api'), '고객 결제');
  assert.equal(new Map(choices).get('/other/api'), 'Admin Panel');
  assert.equal(new Map(choices).get('/한글 폴더/앱 100%'), '앱 100%');
  assert.equal(projectGroupLabel('/work/api', '  ', '기존 프로젝트'), '기존 프로젝트');
  assert.equal(projectGroupLabel('/work/api', '  새 제목  ', '기존 프로젝트'), '새 제목');
});

test('pins remain without sessions while title-only metadata follows ordinary group visibility', () => {
  assert.equal(visiblePinnedProjectGroups(groups, [], 'all', '').length, 3);
  assert.deepEqual(projectGroupChoices([], groups).map(([cwd]) => cwd).sort(), groups.filter(group => group.pinned).map(group => group.cwd).sort());
  assert.equal(new Map(projectGroupChoices([session('title', '/work/title-only')], groups)).get('/work/title-only'), '숨은 이름');
});

test('empty pins respect exact project selection and case-insensitive title, cwd, or original project searches', () => {
  const sessions = [session('a', '/work/api', 'Legacy Portal')];
  assert.deepEqual(visiblePinnedProjectGroups(groups, sessions, '/work/api', ''), [groups[0]]);
  assert.deepEqual(visiblePinnedProjectGroups(groups, sessions, '/work/api', 'admin'), []);
  assert.deepEqual(visiblePinnedProjectGroups(groups, sessions, 'all', '  ADMIN  '), [groups[1]]);
  assert.deepEqual(visiblePinnedProjectGroups(groups, sessions, 'all', '결제'), [groups[0]]);
  assert.deepEqual(visiblePinnedProjectGroups(groups, sessions, 'all', '/other/'), [groups[1]]);
  assert.deepEqual(visiblePinnedProjectGroups(groups, sessions, 'all', '100%'), [groups[2]]);
  assert.deepEqual(visiblePinnedProjectGroups(groups, sessions, 'all', 'legacy'), [groups[0]]);
  assert.deepEqual(visiblePinnedProjectGroups(groups, sessions, 'all', 'unrelated prompt'), []);
});

test('card search hits keep their groups even when the group title itself does not match', () => {
  const a = session('matching prompt', '/work/api');
  const matchingPins = visiblePinnedProjectGroups(groups, [a], 'all', 'matching prompt');
  const result = includePinnedProjectGroups([['/work/api', [a]]], matchingPins);
  assert.deepEqual(result, [['/work/api', [a]]]);
});

test('empty pins append deterministically without duplicating or reordering session groups', () => {
  const a = session('a', '/work/api');
  const b = session('b', '/other/api');
  const result = includePinnedProjectGroups([['/other/api', [b]], ['/work/api', [a]]], groups.filter(group => group.pinned));
  assert.deepEqual(result, [['/other/api', [b]], ['/work/api', [a]], ['/한글 폴더/앱 100%', []]]);
  assert.deepEqual(includePinnedProjectGroups([], groups.filter(group => group.pinned)).map(([cwd]) => cwd), includePinnedProjectGroups([], groups.filter(group => group.pinned).reverse()).map(([cwd]) => cwd));
});
