import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectGroup, Session } from '../shared/types.js';
import { graphProjectId, graphSessionGroups } from '../client/src/graph-layout.js';
import { AGENT_HEIGHT, AGENT_WIDTH, defaultGraphPreferences, manualProjectBounds, manualSessionGroups, moveManualGraphNodes, parseGraphPreferences, reconcileManualGraph, setGraphLayoutMode, type ManualGraphLayout } from '../client/src/graph-layout-preferences.js';

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id, nativeId: id, provider: 'codex', title: id, cwd: '/work', project: 'work',
    status: 'idle', statusReason: '', createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T01:00:00.000Z', lastMessage: '', messageCount: 0,
    isSubagent: false, resumable: true, ...extra,
  };
}

function absolute(layout: ManualGraphLayout, id: string) {
  const agent = layout.agents[id];
  const project = layout.projects[agent.projectId];
  return { x: project.position.x + agent.position.x, y: project.position.y + agent.position.y };
}

function tightBounds(layout: ManualGraphLayout, projectId: string, visibleIds?: ReadonlySet<string>) {
  const bounds = manualProjectBounds(layout, projectId, visibleIds)!;
  const cards = Object.entries(layout.agents).filter(([id, agent]) => agent.projectId === projectId && (!visibleIds || visibleIds.has(id))).map(([id]) => absolute(layout, id));
  const left = Math.min(...cards.map(card => card.x));
  const top = Math.min(...cards.map(card => card.y));
  const right = Math.max(...cards.map(card => card.x + AGENT_WIDTH));
  const bottom = Math.max(...cards.map(card => card.y + AGENT_HEIGHT));
  assert.deepEqual(bounds.position, { x: left - 20, y: top - 106 });
  assert.equal(bounds.position.x + bounds.width, right + 20);
  assert.equal(bounds.position.y + bounds.height, bottom + 20);
  return bounds;
}

test('manual positions and project identities survive requests, completion, streaming, and input reordering', () => {
  const items = [session('a'), session('b', { cwd: '/other', project: 'other' }), session('c')];
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, items);
  const placed = moveManualGraphNodes(initial, [{ id: graphProjectId('/work'), position: { x: -125, y: 450 } }, { id: 'c', position: { x: 71, y: 811 } }]);
  const reordered = items.reverse().map(item => ({ ...item, lastRequestAt: '2026-09-16T00:00:00.000Z', lastCompletedAt: '2026-09-16T01:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z', lastMessage: 'streamed output', status: 'completed' as const }));
  assert.equal(reconcileManualGraph(placed, reordered), placed);
  assert.deepEqual(absolute(placed, 'c'), { x: 71, y: 811 });
  assert.deepEqual(Object.keys(initial.projects).sort(), [graphProjectId('/other'), graphProjectId('/work')].sort());
  assert.notEqual(graphProjectId('/same/project'), graphProjectId('/other/project'));
});

test('moving a project carries every member without editing their relative positions', () => {
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [session('a'), session('b'), session('other', { cwd: '/other' })]);
  const projectId = graphProjectId('/work');
  const beforeA = absolute(initial, 'a');
  const beforeB = absolute(initial, 'b');
  const beforeOther = absolute(initial, 'other');
  const next = moveManualGraphNodes(initial, [{ id: projectId, position: { x: initial.projects[projectId].position.x + 327, y: initial.projects[projectId].position.y - 51 } }]);
  assert.equal(next.agents, initial.agents);
  assert.deepEqual(absolute(next, 'a'), { x: beforeA.x + 327, y: beforeA.y - 51 });
  assert.deepEqual(absolute(next, 'b'), { x: beforeB.x + 327, y: beforeB.y - 51 });
  assert.deepEqual(absolute(next, 'other'), beforeOther);
});

test('moving a card outward grows the project and moving back shrinks it without moving siblings', () => {
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [session('a'), session('b')]);
  const projectId = graphProjectId('/work');
  const originalA = absolute(initial, 'a');
  const originalB = absolute(initial, 'b');
  const originalBounds = tightBounds(initial, projectId);
  const moved = moveManualGraphNodes(initial, [{ id: 'a', position: { x: 1503, y: 1009 } }]);
  assert.deepEqual(moved.projects[projectId].position, initial.projects[projectId].position);
  assert.equal(moved.agents.b, initial.agents.b);
  assert.deepEqual(absolute(moved, 'b'), originalB);
  const grownBounds = tightBounds(moved, projectId);
  assert.ok(grownBounds.width > originalBounds.width);
  assert.ok(grownBounds.height > originalBounds.height);
  const returned = moveManualGraphNodes(moved, [{ id: 'a', position: originalA }]);
  assert.deepEqual(tightBounds(returned, projectId), originalBounds);
  assert.deepEqual(absolute(returned, 'b'), originalB);
});

test('filters and newest cutoffs cannot prune manual placements or discard older sessions', () => {
  const items = Array.from({ length: 90 }, (_, index) => session(`session-${index}`, { lastRequestAt: `2026-09-15T${String(index % 24).padStart(2, '0')}:00:00.000Z` }));
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, items);
  const filtered = items.slice(30, 33);
  assert.equal(manualSessionGroups(items).flatMap(([, members]) => members).length, 90);
  assert.equal(graphSessionGroups(items, 8, null).flatMap(([, members]) => members).length, 8);
  assert.deepEqual(manualSessionGroups(filtered).flatMap(([, members]) => members.map(item => item.id)), filtered.map(item => item.id));
  assert.equal(reconcileManualGraph(initial, items), initial);
  assert.equal(Object.keys(initial.agents).length, 90);
  assert.deepEqual(manualSessionGroups([]), []);
});

test('authoritative removal prunes only vanished sessions and empty projects; partial scans preserve them', () => {
  const a = session('a');
  const b = session('b');
  const other = session('other', { cwd: '/other' });
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [a, b, other]);
  assert.equal(reconcileManualGraph(initial, [], false), initial);
  assert.equal(reconcileManualGraph(initial, [a], false), initial);
  const removed = reconcileManualGraph(initial, [b]);
  assert.deepEqual(Object.keys(removed.agents), ['b']);
  assert.deepEqual(Object.keys(removed.projects), [graphProjectId('/work')]);
  assert.equal(removed.agents.b, initial.agents.b);
  assert.deepEqual(absolute(removed, 'b'), absolute(initial, 'b'));
  const bounds = tightBounds(removed, graphProjectId('/work'));
  assert.equal(bounds.width, 282);
  assert.equal(bounds.height, 328);
  const empty = reconcileManualGraph(removed, []);
  assert.deepEqual(empty.agents, {});
  assert.deepEqual(empty.projects, {});
});

test('unseen history does not inflate visible project bounds; visited placements survive filtered seeding', () => {
  const recent = [session('recent-a'), session('recent-b')];
  const history = Array.from({ length: 100 }, (_, index) => session(`old-${index}`, { cwd: index < 50 ? '/work' : '/old-project' }));
  const all = [...history, ...recent];
  const visible = reconcileManualGraph(defaultGraphPreferences().layout, all, true, recent);
  const onlyRecent = reconcileManualGraph(defaultGraphPreferences().layout, recent);
  assert.deepEqual(visible, onlyRecent);
  assert.deepEqual(Object.keys(visible.agents).sort(), ['recent-a', 'recent-b']);
  assert.deepEqual(Object.keys(visible.projects), [graphProjectId('/work')]);

  const placed = moveManualGraphNodes(visible, [{ id: 'recent-a', position: { x: 417, y: 608 } }]);
  const visitHistory = reconcileManualGraph(placed, all, true, [history[0], history[99]]);
  assert.equal(visitHistory.agents['recent-a'], placed.agents['recent-a']);
  assert.equal(visitHistory.agents['recent-b'], placed.agents['recent-b']);
  assert.equal(Object.keys(visitHistory.agents).length, 4);
  assert.equal(reconcileManualGraph(visitHistory, all, true, []), visitHistory);
  assert.equal(reconcileManualGraph(visitHistory, all, true, recent), visitHistory);

  const closed = reconcileManualGraph(visitHistory, all.filter(item => item.id !== 'recent-a'), true, [history[99]]);
  assert.equal(Object.hasOwn(closed.agents, 'recent-a'), false);
  assert.equal(closed.agents['recent-b'], visitHistory.agents['recent-b']);
  assert.equal(closed.agents[history[0].id], visitHistory.agents[history[0].id]);
});

test('new sessions fill vacant positions without colliding with manually placed cards or moving existing nodes', () => {
  const a = session('a');
  const b = session('b');
  let layout = reconcileManualGraph(defaultGraphPreferences().layout, [a, b]);
  layout = moveManualGraphNodes(layout, [{ id: 'a', position: { x: 45, y: 120 } }, { id: 'b', position: { x: 21, y: 358 } }]);
  const added = reconcileManualGraph(layout, [session('new', { lastRequestAt: '2026-09-16T00:00:00.000Z' }), b, a]);
  assert.equal(added.agents.a, layout.agents.a);
  assert.equal(added.agents.b, layout.agents.b);
  assert.deepEqual(added.projects[graphProjectId('/work')].position, layout.projects[graphProjectId('/work')].position);
  const next = absolute(added, 'new');
  for (const id of ['a', 'b']) {
    const existing = absolute(added, id);
    assert.ok(next.x + AGENT_WIDTH <= existing.x || existing.x + AGENT_WIDTH <= next.x || next.y + AGENT_HEIGHT <= existing.y || existing.y + AGENT_HEIGHT <= next.y);
  }
  const newProject = reconcileManualGraph(added, [a, b, session('new'), session('other', { cwd: '/other' })]);
  assert.deepEqual(newProject.projects[graphProjectId('/work')], added.projects[graphProjectId('/work')]);
  assert.ok(newProject.projects[graphProjectId('/other')].position.x >= added.projects[graphProjectId('/work')].position.x + added.projects[graphProjectId('/work')].width);
});

test('mode changes and storage round trips preserve manual coordinates', () => {
  const initial = defaultGraphPreferences();
  const layout = moveManualGraphNodes(reconcileManualGraph(initial.layout, [session('a')]), [{ id: 'a', position: { x: 338, y: 471 } }, { id: graphProjectId('/work'), position: { x: -304, y: 277 } }]);
  const manual = setGraphLayoutMode({ ...initial, layout }, 'manual');
  const automatic = setGraphLayoutMode(manual, 'auto');
  const restored = setGraphLayoutMode(automatic, 'manual');
  assert.equal(manual.layout, automatic.layout);
  assert.equal(restored.layout, manual.layout);
  assert.deepEqual(parseGraphPreferences(JSON.stringify(restored)), restored);
});

test('invalid persisted data falls back safely and cannot add dangling or non-finite placements', () => {
  assert.deepEqual(parseGraphPreferences('invalid json'), defaultGraphPreferences());
  assert.deepEqual(parseGraphPreferences(JSON.stringify({ version: 22 })), defaultGraphPreferences());
  const parsed = parseGraphPreferences(JSON.stringify({ version: 1, mode: 'manual', layout: { projects: { 'project:bad': { position: { x: null, y: 8 }, width: 500, height: 300 } }, agents: { missing: { projectId: 'project:missing', position: { x: 0, y: 0 } } }, host: { x: null, y: 0 } } }));
  assert.equal(parsed.mode, 'manual');
  assert.deepEqual(parsed.layout.projects, {});
  assert.deepEqual(parsed.layout.agents, {});
  const layout = reconcileManualGraph(defaultGraphPreferences().layout, [session('__proto__')]);
  assert.ok(Object.hasOwn(layout.agents, '__proto__'));
  assert.deepEqual(parseGraphPreferences(JSON.stringify({ ...defaultGraphPreferences(), layout })).layout, layout);
  assert.equal(moveManualGraphNodes(layout, [{ id: '__proto__', position: { x: NaN, y: 5 } }]), layout);
});

test('moving cards left and above the logical origin preserves world targets and keeps every side tight', () => {
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [session('a'), session('b')]);
  const projectId = graphProjectId('/work');
  const sibling = absolute(initial, 'b');
  const moved = moveManualGraphNodes(initial, [{ id: 'a', position: { x: -480, y: -249 } }]);
  assert.deepEqual(absolute(moved, 'a'), { x: -480, y: -249 });
  assert.deepEqual(absolute(moved, 'b'), sibling);
  assert.ok(moved.agents.a.position.x < 0);
  assert.ok(moved.agents.a.position.y < 0);
  const bounds = tightBounds(moved, projectId);
  assert.deepEqual(bounds.position, { x: -500, y: -355 });
  assert.equal(moveManualGraphNodes(moved, [{ id: 'a', position: absolute(moved, 'a') }]), moved, 'replayed drag-stop position is a no-op');
  assert.deepEqual(parseGraphPreferences(JSON.stringify({ version: 1, mode: 'manual', layout: moved })).layout, moved);
});

test('the enclosing origin follows all cards away from its old left and top without extra padding', () => {
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [session('a'), session('b')]);
  const projectId = graphProjectId('/work');
  const before = tightBounds(initial, projectId);
  const targets = ['a', 'b'].map(id => ({ id, position: { x: absolute(initial, id).x + 700, y: absolute(initial, id).y + 500 } }));
  const moved = moveManualGraphNodes(initial, targets);
  const after = tightBounds(moved, projectId);
  assert.deepEqual(after.position, { x: before.position.x + 700, y: before.position.y + 500 });
  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);
  assert.deepEqual(moved.projects[projectId].position, initial.projects[projectId].position);
  for (const target of targets) assert.deepEqual(absolute(moved, target.id), target.position);
});

test('a single-card project remains minimal while its rectangle follows movement in every direction', () => {
  let layout = reconcileManualGraph(defaultGraphPreferences().layout, [session('a')]);
  const projectId = graphProjectId('/work');
  for (const target of [{ x: 820, y: 901 }, { x: -100, y: 500 }, { x: -200, y: -600 }, { x: 400, y: -200 }]) {
    layout = moveManualGraphNodes(layout, [{ id: 'a', position: target }]);
    const bounds = tightBounds(layout, projectId);
    assert.deepEqual(bounds.position, { x: target.x - 20, y: target.y - 106 });
    assert.equal(bounds.width, 282);
    assert.equal(bounds.height, 328);
    assert.deepEqual(absolute(layout, 'a'), target);
  }
});

test('filtered bounds wrap visible members while hidden placements survive reconciliation and reappear unchanged', () => {
  const items = [session('a'), session('b')];
  const projectId = graphProjectId('/work');
  const layout = moveManualGraphNodes(reconcileManualGraph(defaultGraphPreferences().layout, items), [{ id: 'b', position: { x: 1520, y: 1251 } }]);
  const hidden = absolute(layout, 'b');
  const completeBounds = tightBounds(layout, projectId);
  const visible = new Set(['a']);
  const filtered = reconcileManualGraph(layout, items, true, [items[0]]);
  assert.equal(filtered, layout);
  const visibleBounds = tightBounds(filtered, projectId, visible);
  assert.equal(visibleBounds.width, 282);
  assert.equal(visibleBounds.height, 328);
  assert.ok(visibleBounds.width < completeBounds.width);
  const moved = moveManualGraphNodes(filtered, [{ id: 'a', position: { x: 700, y: 800 } }], visible);
  assert.deepEqual(absolute(moved, 'b'), hidden);
  assert.equal(tightBounds(moved, projectId, visible).width, 282);
  assert.equal(reconcileManualGraph(moved, items), moved);
  tightBounds(moved, projectId);
  assert.deepEqual(absolute(moved, 'b'), hidden);
});

test('dragging a filtered visual folder translates all stored members through repeated frames without a release jump', () => {
  const items = [session('a'), session('hidden'), session('other', { cwd: '/other' })];
  const projectId = graphProjectId('/work');
  const shifted = moveManualGraphNodes(reconcileManualGraph(defaultGraphPreferences().layout, items), [{ id: 'a', position: { x: 900, y: 1200 } }]);
  const visible = new Set(['a', 'other']);
  const originalFrame = tightBounds(shifted, projectId, visible);
  const before = { a: absolute(shifted, 'a'), hidden: absolute(shifted, 'hidden'), other: absolute(shifted, 'other') };
  let layout = shifted;
  for (const delta of [{ x: 30, y: -10 }, { x: 80, y: -50 }, { x: 120, y: 20 }]) {
    const target = { x: originalFrame.position.x + delta.x, y: originalFrame.position.y + delta.y };
    layout = moveManualGraphNodes(layout, [{ id: projectId, position: target }], visible);
    assert.deepEqual(tightBounds(layout, projectId, visible).position, target);
    assert.deepEqual(absolute(layout, 'a'), { x: before.a.x + delta.x, y: before.a.y + delta.y });
    assert.deepEqual(absolute(layout, 'hidden'), { x: before.hidden.x + delta.x, y: before.hidden.y + delta.y });
    assert.deepEqual(absolute(layout, 'other'), before.other);
    assert.equal(layout.agents, shifted.agents);
    assert.equal(layout.host, shifted.host);
    assert.equal(moveManualGraphNodes(layout, [{ id: projectId, position: target }], visible), layout);
  }
});

test('old oversized saved boxes normalize to content without changing stored or world positions', () => {
  const projectId = graphProjectId('/work');
  const stored = { version: 1, mode: 'manual', layout: {
    projects: { [projectId]: { position: { x: -100, y: 400 }, width: 9999, height: 7777 } },
    agents: { a: { projectId, position: { x: 720, y: 900 } }, b: { projectId, position: { x: 990, y: 1400 } } },
    host: { x: 128, y: 0 },
  } };
  const parsed = parseGraphPreferences(JSON.stringify(stored));
  assert.deepEqual(parsed.layout.agents, stored.layout.agents);
  assert.deepEqual(parsed.layout.projects[projectId].position, stored.layout.projects[projectId].position);
  assert.deepEqual(absolute(parsed.layout, 'a'), { x: 620, y: 1300 });
  assert.deepEqual(absolute(parsed.layout, 'b'), { x: 890, y: 1800 });
  const bounds = tightBounds(parsed.layout, projectId);
  assert.deepEqual(bounds, { position: { x: 600, y: 1194 }, width: 552, height: 828 });
  assert.equal(parsed.layout.projects[projectId].width, bounds.width);
  assert.equal(parsed.layout.projects[projectId].height, bounds.height);
  assert.deepEqual(parseGraphPreferences(JSON.stringify(parsed)), parsed);
});

test('new projects use the actual visible right edge and new cards stay near shifted members without collisions', () => {
  const a = session('a');
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [a]);
  const shifted = moveManualGraphNodes(initial, [{ id: 'a', position: { x: 2500, y: 1200 } }]);
  const projectId = graphProjectId('/work');
  const before = tightBounds(shifted, projectId);
  const other = session('other', { cwd: '/other' });
  const addedProject = reconcileManualGraph(shifted, [a, other]);
  const otherBounds = tightBounds(addedProject, graphProjectId('/other'));
  assert.ok(otherBounds.position.x >= before.position.x + before.width + 36);
  assert.deepEqual(absolute(addedProject, 'a'), absolute(shifted, 'a'));
  const addedCard = reconcileManualGraph(shifted, [a, session('new')]);
  assert.equal(addedCard.agents.a, shifted.agents.a);
  const next = absolute(addedCard, 'new');
  assert.equal(next.x, absolute(shifted, 'a').x);
  assert.ok(next.y >= absolute(shifted, 'a').y + AGENT_HEIGHT);
  assert.ok(next.y - absolute(shifted, 'a').y < AGENT_HEIGHT * 2);
  tightBounds(addedCard, projectId);
});

test('batch card targets use world coordinates after folder translation regardless of change ordering', () => {
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [session('a'), session('b')]);
  const projectId = graphProjectId('/work');
  const frame = tightBounds(initial, projectId);
  const folderMove = { id: projectId, position: { x: frame.position.x + 100, y: frame.position.y + 70 } };
  const cardMove = { id: 'a', position: { x: -300, y: -400 } };
  const forward = moveManualGraphNodes(initial, [folderMove, cardMove]);
  const reverse = moveManualGraphNodes(initial, [cardMove, folderMove]);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(absolute(forward, 'a'), cardMove.position);
  assert.deepEqual(absolute(forward, 'b'), { x: absolute(initial, 'b').x + 100, y: absolute(initial, 'b').y + 70 });
  tightBounds(forward, projectId);
});

test('no-op moves preserve identity and moving the host is independent from all projects and cards', () => {
  const initial = moveManualGraphNodes(reconcileManualGraph(defaultGraphPreferences().layout, [session('a')]), [{ id: 'a', position: { x: -350, y: 800 } }]);
  const projectId = graphProjectId('/work');
  assert.equal(moveManualGraphNodes(initial, []), initial);
  assert.equal(moveManualGraphNodes(initial, [{ id: 'missing', position: { x: 2, y: 3 } }]), initial);
  assert.equal(moveManualGraphNodes(initial, [{ id: 'a', position: absolute(initial, 'a') }, { id: projectId, position: manualProjectBounds(initial, projectId)!.position }, { id: 'host', position: initial.host }]), initial);
  assert.equal(reconcileManualGraph(initial, [session('a')]), initial);
  const moved = moveManualGraphNodes(initial, [{ id: 'host', position: { x: -900, y: 12 } }]);
  assert.equal(moved.projects, initial.projects);
  assert.equal(moved.agents, initial.agents);
  assert.deepEqual(moved.host, { x: -900, y: 12 });
});

const workPin: ProjectGroup = { cwd: '/work', title: '진행할 작업', pinned: true };

test('a pin seeds a finite empty frame and keeps its dragged position after reload and layout mode changes', () => {
  const projectId = graphProjectId(workPin.cwd);
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [], true, [], [workPin]);
  assert.deepEqual(Object.keys(initial.projects), [projectId]);
  assert.deepEqual(initial.agents, {});
  const frame = manualProjectBounds(initial, projectId)!;
  assert.equal(frame.width, 282);
  assert.equal(frame.height, 328);
  const moved = moveManualGraphNodes(initial, [{ id: projectId, position: { x: -610, y: 735 } }], new Set());
  let preferences = { ...defaultGraphPreferences(), mode: 'manual' as const, layout: moved };
  const restored = parseGraphPreferences(JSON.stringify(setGraphLayoutMode(setGraphLayoutMode(preferences, 'auto'), 'manual')));
  assert.deepEqual(manualProjectBounds(restored.layout, projectId)!.position, { x: -610, y: 735 });
  assert.equal(reconcileManualGraph(restored.layout, [], true, [], [{ ...workPin, title: '새 이름' }]), restored.layout);
});

test('closing the final moved card preserves the pin frame instead of jumping to its old logical origin', () => {
  const projectId = graphProjectId(workPin.cwd);
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [session('a')], true, [session('a')], [workPin]);
  const moved = moveManualGraphNodes(initial, [{ id: 'a', position: { x: -834, y: -572 } }]);
  const before = manualProjectBounds(moved, projectId)!;
  assert.notDeepEqual(before.position, moved.projects[projectId].position);
  const closed = reconcileManualGraph(moved, [], true, [], [workPin]);
  assert.deepEqual(closed.agents, {});
  assert.deepEqual(manualProjectBounds(closed, projectId), before);
  const restored = parseGraphPreferences(JSON.stringify({ ...defaultGraphPreferences(), layout: closed })).layout;
  assert.deepEqual(manualProjectBounds(restored, projectId), before);
  assert.equal(reconcileManualGraph(restored, [], true, [], [workPin]), restored);
  const reopened = reconcileManualGraph(restored, [session('new')], true, [session('new')], [workPin]);
  assert.deepEqual(manualProjectBounds(reopened, projectId), before);
  assert.deepEqual(absolute(reopened, 'new'), { x: before.position.x + 20, y: before.position.y + 106 });
});

test('filtering every card anchors an empty pin to its stored cards and moving it carries hidden members', () => {
  const projectId = graphProjectId(workPin.cwd);
  const items = [session('a'), session('b')];
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, items, true, items, [workPin]);
  const moved = moveManualGraphNodes(initial, [{ id: 'a', position: { x: -840, y: -540 } }]);
  const storedFrame = manualProjectBounds(moved, projectId)!;
  const hiddenFrame = manualProjectBounds(moved, projectId, new Set())!;
  assert.deepEqual(hiddenFrame.position, storedFrame.position);
  assert.equal(hiddenFrame.width, 282);
  assert.equal(hiddenFrame.height, 328);
  assert.equal(reconcileManualGraph(moved, items, true, [], [workPin]), moved);
  const translated = moveManualGraphNodes(moved, [{ id: projectId, position: { x: hiddenFrame.position.x + 303, y: hiddenFrame.position.y - 217 } }], new Set());
  for (const item of items) assert.deepEqual(absolute(translated, item.id), { x: absolute(moved, item.id).x + 303, y: absolute(moved, item.id).y - 217 });
  assert.deepEqual(manualProjectBounds(translated, projectId, new Set())!.position, { x: hiddenFrame.position.x + 303, y: hiddenFrame.position.y - 217 });
});

test('pins outside the current search retain placement, and unpinning an empty group removes only that group', () => {
  const otherPin: ProjectGroup = { cwd: '/other', title: 'Other', pinned: true };
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [], true, [], [workPin, otherPin]);
  const moved = moveManualGraphNodes(initial, [{ id: graphProjectId('/other'), position: { x: 945, y: -238 } }], new Set());
  assert.equal(reconcileManualGraph(moved, [], true, [], [workPin, otherPin]), moved);
  const unpinned = reconcileManualGraph(moved, [], true, [], [otherPin]);
  assert.deepEqual(Object.keys(unpinned.projects), [graphProjectId('/other')]);
  assert.deepEqual(manualProjectBounds(unpinned, graphProjectId('/other'))!.position, { x: 945, y: -238 });
  assert.deepEqual(reconcileManualGraph(unpinned, [], true, [], []).projects, {});
});
