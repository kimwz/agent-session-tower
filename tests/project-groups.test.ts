import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectGroup, Session } from '../shared/types.js';
import { canvasVisibleSessions, includePinnedProjectGroups, projectGroupChoices, projectGroupLabel, visiblePinnedProjectGroups } from '../client/src/project-groups/project-groups.js';
import { graphProjectId, graphSessionGroups } from '../client/src/graph/graph-layout.js';
import { defaultGraphPreferences, moveManualGraphNodes, reconcileManualGraph } from '../client/src/graph/graph-layout-preferences.js';

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

test('hiding removes only matching canvas folders and Show all keeps the existing filtered set intact', () => {
  const visible = session('visible', '/work/api');
  const hidden = session('hidden', '/other/api');
  const otherPath = session('same basename', '/third/api');
  const filtered = [visible, hidden, otherPath];
  const metadata = [{ cwd: '/other/api', title: 'Hidden', pinned: false, hidden: true }];
  assert.deepEqual(canvasVisibleSessions(filtered, metadata, false), [visible, otherPath]);
  assert.equal(canvasVisibleSessions(filtered, metadata, true), filtered);
  assert.deepEqual(canvasVisibleSessions([hidden], metadata, false), []);
  assert.deepEqual(canvasVisibleSessions([hidden], metadata, true), [hidden], 'revealing does not add a session excluded by another filter');
  assert.deepEqual(filtered, [visible, hidden, otherPath]);
  assert.equal(hidden.closed, undefined);
});

test('hidden pins and empty unpinned folders are revealed only by Show all and remain restorable by folder or search', () => {
  const metadata: ProjectGroup[] = [
    { cwd: '/work/pinned', title: 'Pinned secret', pinned: true, hidden: true },
    { cwd: '/work/empty', title: 'Empty secret', pinned: false, hidden: true },
    { cwd: '/work/visible', title: '', pinned: true },
  ];
  assert.deepEqual(visiblePinnedProjectGroups(metadata, [], 'all', ''), [metadata[2]]);
  assert.deepEqual(visiblePinnedProjectGroups(metadata, [], 'all', '', true), metadata);
  assert.deepEqual(visiblePinnedProjectGroups(metadata, [], '/work/empty', '', true), [metadata[1]]);
  assert.deepEqual(visiblePinnedProjectGroups(metadata, [], 'all', 'EMPTY SECRET', true), [metadata[1]]);
  assert.deepEqual(visiblePinnedProjectGroups(metadata, [], '/work/visible', 'secret', true), []);
  assert.equal(new Map(projectGroupChoices([], metadata)).get('/work/empty'), 'Empty secret');
});

test('revealed hidden folder headers survive the automatic card limit and session-only search hits', () => {
  const recent = Array.from({ length: 8 }, (_, index) => ({ ...session(`recent-${index}`, '/work/recent'), lastRequestAt: '2026-09-17T00:00:00Z' }));
  const old = session('needle in a conversation', '/work/old');
  const metadata = [{ cwd: '/work/old', title: 'Older work', pinned: false, hidden: true }];
  const filtered = [...recent, old];
  const frames = visiblePinnedProjectGroups(metadata, filtered, 'all', '', true, filtered);
  const rendered = includePinnedProjectGroups(graphSessionGroups(filtered, 8, null), frames);
  assert.deepEqual(rendered.find(([cwd]) => cwd === old.cwd), [old.cwd, []]);
  assert.deepEqual(visiblePinnedProjectGroups(metadata, filtered, 'all', 'needle', true, [old]), metadata);
  assert.deepEqual(visiblePinnedProjectGroups(metadata, filtered, '/other', 'needle', true, [old]), []);
});

test('hiding and revealing retains manual card positions and empty hidden folder positions', () => {
  const a = session('visible', '/work/visible');
  const b = session('hidden', '/work/hidden');
  const metadata: ProjectGroup[] = [{ cwd: b.cwd, title: '', pinned: false, hidden: true }, { cwd: '/work/empty', title: '', pinned: false, hidden: true }];
  const all = [a, b];
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, all, true, all, metadata);
  const moved = moveManualGraphNodes(initial, [{ id: b.id, position: { x: 1200, y: 900 } }, { id: graphProjectId('/work/empty'), position: { x: 1700, y: 400 } }]);
  const concealed = reconcileManualGraph(moved, all, true, canvasVisibleSessions(all, metadata, false), metadata);
  assert.deepEqual(concealed.agents[b.id], moved.agents[b.id]);
  assert.deepEqual(concealed.projects[graphProjectId(b.cwd)], moved.projects[graphProjectId(b.cwd)]);
  assert.deepEqual(concealed.projects[graphProjectId('/work/empty')], moved.projects[graphProjectId('/work/empty')]);
  const revealed = reconcileManualGraph(concealed, all, true, canvasVisibleSessions(all, metadata, true), metadata);
  assert.deepEqual(revealed, concealed);
});
