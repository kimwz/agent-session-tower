import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../../../shared/types.js';
import { graphProjectId, graphSessionGroups } from '../../../client/src/graph/graph-layout.js';
import { sessionStaysShown } from '../../../shared/session-activity.js';
import { defaultGraphPreferences, manualSessionGroups, moveManualGraphNodes, parseGraphPreferences, projectColumns, projectGrid, reconcileManualGraph, setGraphLayoutMode, setProjectColumns, type ProjectFrame } from '../../../client/src/graph/graph-layout-preferences.js';

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id, nativeId: id, provider: 'codex', title: id, cwd: '/work', project: 'work',
    status: 'idle', statusReason: '', createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T01:00:00.000Z', lastMessage: '', messageCount: 0,
    isSubagent: false, resumable: true, ...extra,
  };
}

const work = graphProjectId('/work');
const other = graphProjectId('/other');
const frame = (id: string, count = 1, columns = 1): ProjectFrame => {
  const grid = projectGrid(count, columns);
  return { id, width: grid.width, height: grid.height };
};

test('one session per row stacks cards from the top of the folder down', () => {
  const grid = projectGrid(3, 1);
  assert.deepEqual(grid.cards, [{ x: 20, y: 106 }, { x: 20, y: 321 }, { x: 20, y: 536 }]);
  assert.deepEqual([grid.width, grid.height], [282, 766]);
});

test('with two per row the third card starts the next row at the left', () => {
  const grid = projectGrid(3, 2);
  assert.deepEqual(grid.cards, [{ x: 20, y: 106 }, { x: 288, y: 106 }, { x: 20, y: 321 }]);
  assert.deepEqual([grid.width, grid.height], [550, 551]);
});

test('an empty folder keeps room for one card and a long title widens the frame', () => {
  assert.deepEqual(projectGrid(0, 3), { width: 818, height: 336, cards: [] });
  assert.equal(projectGrid(1, 1, 400).width, 400);
  assert.equal(projectGrid(1, 1, 100).width, 282);
});

test('each folder starts with one session per row and remembers its own choice', () => {
  let preferences = defaultGraphPreferences();
  assert.equal(projectColumns(preferences.columns, work), 1);
  preferences = setProjectColumns(preferences, work, 3);
  assert.equal(projectColumns(preferences.columns, work), 3);
  assert.equal(projectColumns(preferences.columns, other), 1);
  assert.equal(setProjectColumns(preferences, work, 3), preferences);
  assert.equal(projectColumns(setProjectColumns(preferences, work, 9).columns, work), 4);
  const restored = parseGraphPreferences(JSON.stringify(preferences));
  assert.deepEqual(restored.columns, { [work]: 3 });
  assert.deepEqual(setProjectColumns(restored, work, 1).columns, {});
  assert.equal(parseGraphPreferences(JSON.stringify({ ...preferences, columns: { [work]: 2.5, [other]: 'x', bad: 2 } })).columns, undefined);
});

test('a new folder is placed right of the shown folders and stays where it is dragged', () => {
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [frame(work), frame(other, 2)]);
  assert.deepEqual(initial.projects[work].position, { x: 0, y: 145 });
  assert.deepEqual(initial.projects[other].position, { x: 318, y: 145 });
  const moved = moveManualGraphNodes(initial, [{ id: other, position: { x: -400, y: 900 } }]);
  assert.deepEqual(moved.projects[other].position, { x: -400, y: 900 });
  assert.deepEqual(moved.projects[work], initial.projects[work]);
  assert.equal(reconcileManualGraph(moved, [frame(work), frame(other, 2)]), moved);
});

test('more sessions or more per row resize a folder in place without moving it', () => {
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [frame(work)]);
  const grown = reconcileManualGraph(initial, [frame(work, 5, 2)]);
  assert.deepEqual(grown.projects[work], { position: initial.projects[work].position, width: 550, height: 766 });
});

test('a folder that grows moves only the folders it newly covers, right or down, and they carry on', () => {
  const third = graphProjectId('/third');
  const below = graphProjectId('/below');
  let layout = reconcileManualGraph(defaultGraphPreferences().layout, [frame(work), frame(other), frame(third)]);
  layout = moveManualGraphNodes(layout, [{ id: below, position: { x: 0, y: 0 } }]);
  layout = reconcileManualGraph(layout, [frame(work), frame(other), frame(third), frame(below)]);
  layout = moveManualGraphNodes(layout, [{ id: below, position: { x: 0, y: 600 } }]);
  assert.deepEqual([layout.projects[work].position, layout.projects[other].position, layout.projects[third].position], [{ x: 0, y: 145 }, { x: 318, y: 145 }, { x: 636, y: 145 }]);
  const wider = reconcileManualGraph(layout, [frame(work, 3, 2), frame(other), frame(third), frame(below)]);
  assert.deepEqual(wider.projects[other].position, { x: 586, y: 145 });
  assert.deepEqual(wider.projects[third].position, { x: 904, y: 145 });
  assert.deepEqual(wider.projects[below].position, { x: 0, y: 145 + 551 + 36 });
  const narrower = reconcileManualGraph(wider, [frame(work), frame(other), frame(third), frame(below)]);
  assert.deepEqual(narrower.projects[other].position, wider.projects[other].position, 'shrinking pulls nothing back');
  const overlapping = moveManualGraphNodes(layout, [{ id: other, position: { x: 100, y: 145 } }]);
  assert.deepEqual(reconcileManualGraph(overlapping, [frame(work, 3), frame(other), frame(third), frame(below)]).projects[other].position, { x: 100, y: 145 }, 'a frame already overlapped by hand stays');
});

test('a new folder is not placed over a saved folder that is out of view', () => {
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [frame(work)]);
  const next = reconcileManualGraph(initial, [frame(other)]);
  assert.deepEqual(next.projects[other].position, { x: 0, y: 145 + 336 + 36 });
});

test('authoritative removal forgets vanished folders; partial scans and retained computers keep them', () => {
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [frame(work), frame(other)]);
  assert.equal(reconcileManualGraph(initial, [], undefined), initial);
  assert.deepEqual(Object.keys(reconcileManualGraph(initial, [], new Set([work])).projects), [work]);
  assert.deepEqual(Object.keys(reconcileManualGraph(initial, [frame(other)], new Set([work])).projects).sort(), [other, work].sort());
  assert.equal(reconcileManualGraph(initial, [], new Set(), id => id === work || id === other), initial);
});

test('mode changes and storage round trips preserve folder places', () => {
  const initial = defaultGraphPreferences();
  const layout = moveManualGraphNodes(reconcileManualGraph(initial.layout, [frame(work)]), [{ id: work, position: { x: -304, y: 277 } }, { id: 'host', position: { x: 5, y: -9 } }]);
  const manual = setGraphLayoutMode({ ...initial, layout }, 'manual');
  const restored = setGraphLayoutMode(setGraphLayoutMode(manual, 'auto'), 'manual');
  assert.equal(restored.layout, manual.layout);
  assert.deepEqual(parseGraphPreferences(JSON.stringify(restored)), restored);
});

test('invalid persisted data falls back safely and moves ignore cards and non-finite targets', () => {
  assert.deepEqual(parseGraphPreferences('invalid json'), defaultGraphPreferences());
  assert.deepEqual(parseGraphPreferences(JSON.stringify({ version: 22 })), defaultGraphPreferences());
  const parsed = parseGraphPreferences(JSON.stringify({ version: 1, mode: 'manual', layout: { projects: { 'project:bad': { position: { x: null, y: 8 }, width: 500, height: 300 } }, host: { x: null, y: 0 } } }));
  assert.equal(parsed.mode, 'manual');
  assert.deepEqual(parsed.layout, defaultGraphPreferences().layout);
  const layout = reconcileManualGraph(defaultGraphPreferences().layout, [frame(work)]);
  assert.equal(moveManualGraphNodes(layout, [{ id: work, position: { x: NaN, y: 5 } }, { id: 'a', position: { x: 1, y: 2 } }]), layout);
});

test('saves from hand-placed cards keep each folder where it was drawn', () => {
  const anchored = { version: 1, mode: 'manual', layout: {
    projects: { [work]: { position: { x: 50, y: 60 }, width: 282, height: 328 } },
    agents: { a: { projectId: work, position: { x: 20, y: 106 } } }, host: { x: 128, y: 0 }, anchoredFrames: true,
  } };
  assert.deepEqual(parseGraphPreferences(JSON.stringify(anchored)).layout.projects[work].position, { x: 50, y: 60 });
  const older = { version: 1, mode: 'manual', layout: {
    projects: { [work]: { position: { x: 50, y: 60 }, width: 282, height: 328 } },
    agents: { a: { projectId: work, position: { x: 700, y: 900 } }, b: { projectId: work, position: { x: 400, y: 1300 } } }, host: { x: 128, y: 0 },
  } };
  const parsed = parseGraphPreferences(JSON.stringify(older));
  assert.deepEqual(parsed.layout.projects[work].position, { x: 430, y: 854 });
  assert.equal(Object.hasOwn(parsed.layout, 'agents'), false);
  assert.deepEqual(parseGraphPreferences(JSON.stringify(parsed)), parsed);
});

test('the hand-arranged canvas orders cards in a folder as the automatic one does', () => {
  const items = [session('a', { lastRequestAt: '2026-09-15T01:00:00.000Z' }), session('b', { lastRequestAt: '2026-09-15T03:00:00.000Z' }), session('c', { cwd: '/other', project: 'other' })];
  assert.deepEqual(manualSessionGroups(items).map(([path, members]) => [path, members.map(item => item.id)]),
    graphSessionGroups(items, Infinity, null).map(([path, members]) => [path, members.map(item => item.id)]));
  assert.deepEqual(manualSessionGroups(items).find(([path]) => path === '/work')![1].map(item => item.id), ['b', 'a']);
});

test('a conversation that still needs something is never pushed off the canvas by newer ones', () => {
  const items = Array.from({ length: 20 }, (_, index) => session(`session-${index}`, { status: 'completed', lastRequestAt: `2026-09-15T${String(index).padStart(2, '0')}:00:00.000Z` }));
  items[0] = { ...items[0], outcome: 'needsOwner' };
  items[1] = { ...items[1], outcome: 'blocked' };
  items[2] = { ...items[2], outcome: 'done' };
  const shown = graphSessionGroups(items, 8, null).flatMap(([, members]) => members.map(item => item.id));
  assert.equal(shown.length, 10);
  assert.ok(shown.includes('session-0') && shown.includes('session-1'));
  assert.ok(!shown.includes('session-2'), 'finished work leaves as it always did');
  assert.equal(sessionStaysShown({ status: 'working', outcome: 'needsOwner' }), false);
  assert.equal(sessionStaysShown({ status: 'idle', outcome: 'progress' }), true);
  assert.equal(sessionStaysShown({ status: 'idle' }), false);
});
