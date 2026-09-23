import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectGroup, Session } from '../../../shared/types.js';
import { graphProjectId, graphSessionGroups } from '../../../client/src/graph/graph-layout.js';
import { AGENT_HEIGHT, AGENT_WIDTH, defaultGraphPreferences, manualProjectBounds, manualSessionGroups, moveManualGraphNodes, parseGraphPreferences, reconcileManualGraph, setGraphLayoutMode, type ManualGraphLayout } from '../../../client/src/graph/graph-layout-preferences.js';

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
  assert.deepEqual(absolute(moved, 'b'), originalB);
  const grownBounds = tightBounds(moved, projectId);
  assert.ok(grownBounds.width > originalBounds.width);
  assert.ok(grownBounds.height > originalBounds.height);
  assert.deepEqual(moved.projects[projectId].position, grownBounds.position);
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
  assert.deepEqual(absolute(visitHistory, 'recent-a'), absolute(placed, 'recent-a'));
  assert.deepEqual(absolute(visitHistory, 'recent-b'), absolute(placed, 'recent-b'));
  assert.equal(Object.keys(visitHistory.agents).length, 4);
  assert.equal(reconcileManualGraph(visitHistory, all, true, []), visitHistory);
  const revisited = reconcileManualGraph(visitHistory, all, true, recent);
  assert.deepEqual(Object.keys(revisited.agents).sort(), Object.keys(visitHistory.agents).sort());
  for (const id of Object.keys(visitHistory.agents)) assert.deepEqual(absolute(revisited, id), absolute(visitHistory, id));

  const closed = reconcileManualGraph(visitHistory, all.filter(item => item.id !== 'recent-a'), true, [history[99]]);
  assert.equal(Object.hasOwn(closed.agents, 'recent-a'), false);
  assert.deepEqual(absolute(closed, 'recent-b'), absolute(visitHistory, 'recent-b'));
  assert.deepEqual(absolute(closed, history[0].id), absolute(visitHistory, history[0].id));
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
  const bounds = tightBounds(moved, projectId);
  assert.deepEqual(bounds.position, { x: -500, y: -355 });
  assert.deepEqual(moved.projects[projectId].position, bounds.position);
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
  assert.deepEqual(moved.projects[projectId].position, after.position);
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
    assert.equal(layout.host, shifted.host);
    assert.equal(moveManualGraphNodes(layout, [{ id: projectId, position: target }], visible), layout);
  }
});

test('old oversized saved boxes normalize to content without changing world positions', () => {
  const projectId = graphProjectId('/work');
  const stored = { version: 1, mode: 'manual', layout: {
    projects: { [projectId]: { position: { x: -100, y: 400 }, width: 9999, height: 7777 } },
    agents: { a: { projectId, position: { x: 720, y: 900 } }, b: { projectId, position: { x: 990, y: 1400 } } },
    host: { x: 128, y: 0 },
  } };
  const parsed = parseGraphPreferences(JSON.stringify(stored));
  assert.deepEqual(absolute(parsed.layout, 'a'), { x: 620, y: 1300 });
  assert.deepEqual(absolute(parsed.layout, 'b'), { x: 890, y: 1800 });
  const bounds = tightBounds(parsed.layout, projectId);
  assert.deepEqual(bounds, { position: { x: 600, y: 1194 }, width: 552, height: 828 });
  assert.deepEqual(parsed.layout.projects[projectId].position, bounds.position);
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

test('new cards follow the visible folder after card and folder drags without following filtered history', () => {
  const recent = session('recent');
  const history = session('history');
  const next = session('new');
  const projectId = graphProjectId('/work');
  let layout = reconcileManualGraph(defaultGraphPreferences().layout, [recent, history]);
  layout = moveManualGraphNodes(layout, [
    { id: recent.id, position: { x: 1400, y: 1600 } },
    { id: history.id, position: { x: -5000, y: -3000 } },
  ]);
  const visibleIds = new Set([recent.id]);
  layout = moveManualGraphNodes(layout, [{ id: projectId, position: { x: 1880, y: 1744 } }], visibleIds);
  const before = absolute(layout, recent.id);
  const historicalPosition = absolute(layout, history.id);
  const added = reconcileManualGraph(layout, [recent, history, next], true, [recent, next]);
  assert.deepEqual(absolute(added, next.id), { x: before.x, y: before.y + 228 });
  assert.equal(added.agents[recent.id], layout.agents[recent.id]);
  assert.equal(added.agents[history.id], layout.agents[history.id]);
  assert.deepEqual(absolute(added, recent.id), before);
  assert.deepEqual(absolute(added, history.id), historicalPosition);
  assert.deepEqual(added.projects[projectId].position, layout.projects[projectId].position);
  assert.equal(reconcileManualGraph(added, [history, next, recent], true, [next, recent]), added);
});

test('multiple new cards share a row below visible contents while distant saved rows retain their positions', () => {
  const a = session('a'); const b = session('b'); const history = session('history');
  const additions = [session('new-a'), session('new-b'), session('new-c')];
  let layout = reconcileManualGraph(defaultGraphPreferences().layout, [a, b, history]);
  layout = moveManualGraphNodes(layout, [
    { id: a.id, position: { x: 900, y: -400 } },
    { id: b.id, position: { x: 1168, y: -400 } },
    { id: history.id, position: { x: 20000, y: 30000 } },
  ]);
  const added = reconcileManualGraph(layout, [a, b, history, ...additions], true, [a, b, ...additions]);
  const positions = additions.map(item => absolute(added, item.id)).sort((left, right) => left.y - right.y || left.x - right.x);
  assert.deepEqual(positions, [{ x: 900, y: -172 }, { x: 1168, y: -172 }, { x: 900, y: 56 }]);
  for (const item of [a, b, history]) assert.deepEqual(absolute(added, item.id), absolute(layout, item.id));
});

test('new cards align with the visible bottom row even when direct creation reveals distant upper history', () => {
  const history = session('visible-history'); const current = session('current');
  const initial = moveManualGraphNodes(reconcileManualGraph(defaultGraphPreferences().layout, [history, current]), [
    { id: history.id, position: { x: -4513, y: -2863 } },
    { id: current.id, position: { x: 20, y: 1391 } },
  ]);
  const fresh = session('fresh');
  const added = reconcileManualGraph(initial, [history, current, fresh]);
  assert.deepEqual(absolute(added, fresh.id), { x: 20, y: 1619 });
  assert.deepEqual(absolute(added, history.id), absolute(initial, history.id));
  assert.deepEqual(absolute(added, current.id), absolute(initial, current.id));

  const sibling = session('bottom-sibling');
  const row = moveManualGraphNodes(reconcileManualGraph(initial, [history, current, sibling]), [{ id: sibling.id, position: { x: 288, y: 1398 } }]);
  const additions = [session('next-a'), session('next-b')];
  const batch = reconcileManualGraph(row, [history, current, sibling, ...additions]);
  assert.deepEqual(additions.map(item => absolute(batch, item.id)).sort((a, b) => a.x - b.x), [{ x: 20, y: 1626 }, { x: 288, y: 1626 }]);
  assert.deepEqual(absolute(batch, sibling.id), absolute(row, sibling.id));
});

test('a nearby vacant cell avoids hidden cards and another folder without following a long blocked column', () => {
  const recent = session('recent');
  const hidden = Array.from({ length: 30 }, (_, index) => session(`hidden-${index}`));
  const other = session('other', { cwd: '/other' });
  let layout = reconcileManualGraph(defaultGraphPreferences().layout, [recent, ...hidden, other]);
  layout = moveManualGraphNodes(layout, [
    { id: recent.id, position: { x: 1000, y: 1000 } },
    ...hidden.map((item, index) => ({ id: item.id, position: { x: 1000, y: 1228 + index * 228 } })),
    { id: other.id, position: { x: 1268, y: 1228 } },
  ]);
  const next = session('new');
  const added = reconcileManualGraph(layout, [recent, ...hidden, other, next], true, [recent, next]);
  const position = absolute(added, next.id);
  assert.deepEqual(position, { x: 732, y: 1228 });
  for (const item of [recent, ...hidden, other]) {
    const saved = absolute(layout, item.id);
    assert.deepEqual(absolute(added, item.id), saved);
    assert.ok(position.x + AGENT_WIDTH <= saved.x || saved.x + AGENT_WIDTH <= position.x || position.y + AGENT_HEIGHT <= saved.y || saved.y + AGENT_HEIGHT <= position.y);
  }
});

test('new folders use visible bounds and title widths at their current height instead of hidden distant frames', () => {
  const recent = session('recent'); const history = session('history');
  const distant = session('distant', { cwd: '/hidden' });
  const fresh = session('fresh', { cwd: '/new-folder' });
  const hiddenPin: ProjectGroup = { cwd: '/hidden-empty', title: '', pinned: false, hidden: true };
  const projectId = graphProjectId('/work');
  let layout = reconcileManualGraph(defaultGraphPreferences().layout, [recent, history, distant], true, [recent, history, distant], [hiddenPin]);
  layout = moveManualGraphNodes(layout, [
    { id: recent.id, position: { x: -2000, y: 1600 } },
    { id: history.id, position: { x: 40000, y: 50000 } },
    { id: distant.id, position: { x: 90000, y: 90000 } },
    { id: graphProjectId(hiddenPin.cwd), position: { x: 100000, y: 100000 } },
  ]);
  const minimumProjectWidths = new Map([[projectId, 700]]);
  const visibleProjectIds = new Set([projectId, graphProjectId(fresh.cwd)]);
  const before = manualProjectBounds(layout, projectId, new Set([recent.id]), minimumProjectWidths)!;
  const added = reconcileManualGraph(layout, [recent, history, distant, fresh], true, [recent, fresh], [hiddenPin], { visibleProjectIds, minimumProjectWidths });
  const frame = manualProjectBounds(added, graphProjectId(fresh.cwd))!;
  assert.deepEqual(frame.position, { x: before.position.x + before.width + 36, y: before.position.y });
  for (const item of [recent, history, distant]) assert.deepEqual(absolute(added, item.id), absolute(layout, item.id));
  assert.deepEqual(manualProjectBounds(added, graphProjectId(hiddenPin.cwd)), manualProjectBounds(layout, graphProjectId(hiddenPin.cwd)));
  assert.deepEqual(added.projects[projectId].position, layout.projects[projectId].position);
});

test('visible empty frames anchor new folders and title width changes never move saved cards or origins', () => {
  const pin: ProjectGroup = { cwd: '/empty', title: 'A wider visible folder title', pinned: true };
  const projectId = graphProjectId(pin.cwd);
  let layout = reconcileManualGraph(defaultGraphPreferences().layout, [], true, [], [pin]);
  layout = moveManualGraphNodes(layout, [{ id: projectId, position: { x: 800, y: -1200 } }], new Set());
  const widths = new Map([[projectId, 750]]);
  const wider = manualProjectBounds(layout, projectId, new Set(), widths)!;
  assert.deepEqual(wider, { position: { x: 800, y: -1200 }, width: 750, height: 328 });
  const fresh = session('fresh', { cwd: '/new-folder' });
  const added = reconcileManualGraph(layout, [fresh], true, [fresh], [pin], {
    visibleProjectIds: new Set([projectId, graphProjectId(fresh.cwd)]), minimumProjectWidths: widths,
  });
  assert.deepEqual(manualProjectBounds(added, graphProjectId(fresh.cwd))!.position, { x: 1586, y: -1200 });
  assert.deepEqual(added.projects[projectId].position, layout.projects[projectId].position);
  const applied = reconcileManualGraph(layout, [], true, [], [pin], { minimumProjectWidths: widths });
  assert.equal(reconcileManualGraph(applied, [], true, [], [pin], { minimumProjectWidths: widths }), applied);
  const populated = reconcileManualGraph(layout, [session('a', { cwd: pin.cwd })], true, [session('a', { cwd: pin.cwd })], [pin]);
  const ordinary = manualProjectBounds(populated, projectId)!;
  const expanded = manualProjectBounds(populated, projectId, undefined, widths)!;
  assert.deepEqual(expanded.position, ordinary.position);
  assert.equal(expanded.height, ordinary.height);
  assert.equal(expanded.width, 750);
  assert.deepEqual(absolute(populated, 'a'), { x: 820, y: -1094 });
});

test('unseen hidden frames wait for reveal and then get distinct positions while saved hidden frames stay retained', () => {
  const groups: ProjectGroup[] = ['/one', '/two', '/three'].map(cwd => ({ cwd, title: '', pinned: false, hidden: true }));
  const hidden = reconcileManualGraph(defaultGraphPreferences().layout, [], true, [], groups, { visibleProjectIds: new Set() });
  assert.deepEqual(hidden.projects, {});
  const visibleProjectIds = new Set(groups.map(group => graphProjectId(group.cwd)));
  const revealed = reconcileManualGraph(hidden, [], true, [], groups, { visibleProjectIds });
  const frames = [...visibleProjectIds].map(id => manualProjectBounds(revealed, id)!);
  assert.equal(new Set(frames.map(frame => `${frame.position.x},${frame.position.y}`)).size, groups.length);
  for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) {
    assert.ok(frames[i].position.x + frames[i].width + 36 <= frames[j].position.x || frames[j].position.x + frames[j].width + 36 <= frames[i].position.x);
  }
  const moved = moveManualGraphNodes(revealed, [{ id: graphProjectId('/one'), position: { x: -650, y: 1700 } }], new Set());
  assert.equal(reconcileManualGraph(moved, [], true, [], groups, { visibleProjectIds: new Set() }), moved);
  assert.equal(reconcileManualGraph(moved, [], true, [], groups, { visibleProjectIds }), moved);
});

test('a new visible folder stays near the origin without overlapping a saved hidden empty frame', () => {
  const hidden: ProjectGroup = { cwd: '/hidden-empty', title: 'Saved hidden folder', pinned: false, hidden: true };
  const hiddenId = graphProjectId(hidden.cwd);
  const layout = reconcileManualGraph(defaultGraphPreferences().layout, [], true, [], [hidden], { visibleProjectIds: new Set([hiddenId]) });
  const before = manualProjectBounds(layout, hiddenId)!;
  const fresh = session('fresh', { cwd: '/fresh' });
  const freshId = graphProjectId(fresh.cwd);
  const added = reconcileManualGraph(layout, [fresh], true, [fresh], [hidden], { visibleProjectIds: new Set([freshId]) });
  const frame = manualProjectBounds(added, freshId)!;
  assert.deepEqual(frame.position, { x: before.position.x, y: before.position.y + before.height + 36 });
  assert.deepEqual(manualProjectBounds(added, hiddenId), before);
  assert.equal(reconcileManualGraph(added, [fresh], true, [fresh], [hidden], { visibleProjectIds: new Set([freshId, hiddenId]) }), added);
});

test('a new cwd membership is allocated near visible contents without moving siblings or stale history', () => {
  const moving = session('moving', { cwd: '/old-folder' });
  const current = session('current'); const hidden = session('hidden');
  let layout = reconcileManualGraph(defaultGraphPreferences().layout, [moving, current, hidden]);
  layout = moveManualGraphNodes(layout, [
    { id: moving.id, position: { x: 50000, y: 50000 } },
    { id: current.id, position: { x: 900, y: 700 } },
    { id: hidden.id, position: { x: -20000, y: -30000 } },
  ]);
  const changed = { ...moving, cwd: current.cwd };
  const added = reconcileManualGraph(layout, [changed, current, hidden], true, [changed, current]);
  assert.deepEqual(absolute(added, changed.id), { x: 900, y: 928 });
  assert.deepEqual(absolute(added, current.id), absolute(layout, current.id));
  assert.deepEqual(absolute(added, hidden.id), absolute(layout, hidden.id));
  assert.equal(Object.hasOwn(added.projects, graphProjectId('/old-folder')), false);
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

test('a folder whose cards age out of the view stays where it was dragged and new sessions stack from its top', () => {
  const projectId = graphProjectId('/work');
  const [a, b] = [session('a'), session('b')];
  let layout = reconcileManualGraph(defaultGraphPreferences().layout, [a, b]);
  layout = moveManualGraphNodes(layout, [{ id: projectId, position: { x: 900, y: 400 } }], new Set([a.id, b.id]));
  layout = reconcileManualGraph(layout, [a, b], true, [a]);
  assert.deepEqual(manualProjectBounds(layout, projectId, new Set([a.id]))!.position, { x: 900, y: 400 });
  layout = reconcileManualGraph(layout, [a, b], true, []);
  assert.deepEqual(manualProjectBounds(layout, projectId, new Set())!.position, { x: 900, y: 400 });
  const moved = moveManualGraphNodes(layout, [{ id: projectId, position: { x: -300, y: 1200 } }], new Set());
  assert.deepEqual(manualProjectBounds(moved, projectId, new Set())!.position, { x: -300, y: 1200 });
  assert.deepEqual(manualProjectBounds(reconcileManualGraph(moved, [b], true, []), projectId, new Set())!.position, { x: -300, y: 1200 });

  const fresh = session('fresh', { lastRequestAt: '2026-09-16T00:00:00.000Z' });
  const next = session('next', { lastRequestAt: '2026-09-16T01:00:00.000Z' });
  const first = reconcileManualGraph(moved, [a, b, fresh], true, [fresh]);
  assert.deepEqual(absolute(first, fresh.id), { x: -280, y: 1306 });
  assert.deepEqual(manualProjectBounds(first, projectId, new Set([fresh.id]))!.position, { x: -300, y: 1200 });
  assert.equal(Object.hasOwn(first.agents, a.id), false, 'the aged-out card gives its slot to the newer session');
  const second = reconcileManualGraph(first, [a, b, fresh, next], true, [fresh, next]);
  assert.deepEqual(absolute(second, next.id), { x: -280, y: 1534 });
  assert.deepEqual(absolute(second, fresh.id), absolute(first, fresh.id));
  const returned = reconcileManualGraph(second, [a, b, fresh, next], true, [a, b, fresh, next]);
  for (const id of [a.id, b.id]) assert.ok(absolute(returned, id).y > absolute(second, next.id).y, 'returning cards are placed below the folder');
});

test('older saves keep folders without visible cards where they were drawn and migrate only once', () => {
  const projectId = graphProjectId('/work');
  const stored = { version: 1, mode: 'manual', layout: {
    projects: { [projectId]: { position: { x: 50, y: 60 }, width: 282, height: 328 } },
    agents: { a: { projectId, position: { x: 700, y: 900 } }, b: { projectId, position: { x: 400, y: 1300 } } },
    host: { x: 128, y: 0 },
  } };
  const parsed = parseGraphPreferences(JSON.stringify(stored));
  assert.deepEqual(manualProjectBounds(parsed.layout, projectId, new Set())!.position, { x: 430, y: 854 });
  assert.deepEqual(absolute(parsed.layout, 'a'), { x: 750, y: 960 });
  assert.deepEqual(absolute(parsed.layout, 'b'), { x: 450, y: 1360 });
  const narrowed = reconcileManualGraph(parsed.layout, [session('a'), session('b')], true, [session('a')]);
  const reparsed = parseGraphPreferences(JSON.stringify({ ...parsed, layout: narrowed }));
  assert.deepEqual(reparsed.layout, narrowed);
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

test('closing the final moved card preserves the pin frame because the origin follows the visible frame', () => {
  const projectId = graphProjectId(workPin.cwd);
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, [session('a')], true, [session('a')], [workPin]);
  const moved = moveManualGraphNodes(initial, [{ id: 'a', position: { x: -834, y: -572 } }]);
  const before = manualProjectBounds(moved, projectId)!;
  assert.deepEqual(before.position, moved.projects[projectId].position);
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

function titleFixture(xs = [0, 318, 636]) {
  const items = xs.map((_, index) => session(`title-${index}`, { cwd: `/title-${index}` }));
  const ids = items.map(item => graphProjectId(item.cwd));
  const layout = moveManualGraphNodes(reconcileManualGraph(defaultGraphPreferences().layout, items),
    ids.map((id, index) => ({ id, position: { x: xs[index], y: 145 } })));
  return { items, ids, layout };
}

function titleOptions(items: Session[], widths: number[]) {
  return { visibleProjectIds: new Set(items.map(item => graphProjectId(item.cwd))),
    minimumProjectWidths: new Map(items.map((item, index) => [graphProjectId(item.cwd), widths[index]])) };
}

test('legacy title expansion moves only newly intersected right neighbors and cascades without changing relative card positions', () => {
  const { items, ids, layout } = titleFixture();
  const options = titleOptions(items, [584, 458, 282]);
  const repaired = reconcileManualGraph(layout, items, true, items, [], options);
  assert.deepEqual(ids.map(id => manualProjectBounds(repaired, id)!.position), [{ x: 0, y: 145 }, { x: 620, y: 145 }, { x: 1114, y: 145 }]);
  assert.equal(repaired.agents, layout.agents);
  assert.deepEqual(repaired.projects[ids[0]].position, layout.projects[ids[0]].position);
  assert.deepEqual(ids.map(id => repaired.projects[id].appliedHeaderWidth), [584, 458, 282]);
  assert.equal(reconcileManualGraph(repaired, items, true, items, [], options), repaired);
});

test('title repair requires a new rectangle intersection and preserves intentionally overlapping or vertically separate frames', () => {
  for (const [x, width, expected] of [[292, 300, 336], [292, 288, 292], [260, 584, 260]]) {
    const { items, ids, layout } = titleFixture([0, x]);
    const repaired = reconcileManualGraph(layout, items, true, items, [], titleOptions(items, [width, 282]));
    assert.equal(manualProjectBounds(repaired, ids[1])!.position.x, expected);
  }
  const { items, ids, layout } = titleFixture([-2000, -1682]);
  const shifted = moveManualGraphNodes(layout, [{ id: ids[1], position: { x: -1682, y: 2000 } }]);
  const repaired = reconcileManualGraph(shifted, items, true, items, [], titleOptions(items, [584, 282]));
  assert.deepEqual(repaired.projects[ids[0]].position, shifted.projects[ids[0]].position);
  assert.deepEqual(repaired.projects[ids[1]].position, shifted.projects[ids[1]].position);
  const adjacent = reconcileManualGraph(layout, items, true, items, [], titleOptions(items, [584, 282]));
  assert.equal(manualProjectBounds(adjacent, ids[1])!.position.x, -1380);
});

test('persisted title repair is idempotent after reload and does not override later drags or new-card insertion', () => {
  const { items, ids, layout } = titleFixture([0, 318]);
  const options = titleOptions(items, [584, 458]);
  const repaired = reconcileManualGraph(layout, items, true, items, [], options);
  const restored = parseGraphPreferences(JSON.stringify({ version: 1, mode: 'manual', layout: repaired })).layout;
  assert.deepEqual(restored, repaired);
  assert.equal(reconcileManualGraph(restored, items, true, items, [], options), restored);
  const dragged = moveManualGraphNodes(restored, [{ id: ids[1], position: { x: 318, y: 145 } }]);
  assert.equal(reconcileManualGraph(dragged, items, true, items, [], options), dragged);
  const fresh = session('new-card', { cwd: items[0].cwd });
  const added = reconcileManualGraph(dragged, [...items, fresh], true, [...items, fresh], [], options);
  for (const item of items) assert.deepEqual(absolute(added, item.id), absolute(dragged, item.id));
  assert.deepEqual(absolute(added, fresh.id), { x: 20, y: 479 });
  assert.equal(reconcileManualGraph(added, [...items, fresh], true, [...items, fresh], [], options), added);
});

test('automatic viewing leaves legacy title repair pending while new projects initialize their current header width', () => {
  const { items, ids, layout } = titleFixture([0, 318]);
  const options = titleOptions(items, [584, 458]);
  assert.equal(reconcileManualGraph(layout, items, true, items, [], { ...options, repairHeaderWidths: false }), layout);
  const manual = reconcileManualGraph(layout, items, true, items, [], options);
  assert.equal(manualProjectBounds(manual, ids[1])!.position.x, 620);
  const initial = reconcileManualGraph(defaultGraphPreferences().layout, items, true, items, [], options);
  assert.deepEqual(ids.map(id => initial.projects[id].appliedHeaderWidth), [584, 458]);
  assert.equal(reconcileManualGraph(initial, items, true, items, [], options), initial);
});

test('title growth while a neighbor is hidden is repaired once on reveal across repeated growth and reload', () => {
  const { items, ids, layout } = titleFixture([0, 318]);
  const baseline = reconcileManualGraph(layout, items, true, items, [], titleOptions(items, [282, 282]));
  const hidden = reconcileManualGraph(baseline, items, true, [items[0]], [], titleOptions([items[0]], [584]));
  assert.deepEqual(hidden.projects[ids[1]].position, baseline.projects[ids[1]].position);
  const wider = reconcileManualGraph(hidden, items, true, [items[0]], [], titleOptions([items[0]], [700]));
  assert.deepEqual(wider.projects[ids[1]].pendingHeaderRepairs, { [ids[0]]: { width: 282, shiftX: 0 } });
  const restored = parseGraphPreferences(JSON.stringify({ ...defaultGraphPreferences(), layout: wider })).layout;
  const revealed = reconcileManualGraph(restored, items, true, items, [], titleOptions(items, [700, 282]));
  assert.equal(manualProjectBounds(revealed, ids[1])!.position.x, 736);
  assert.equal(revealed.projects[ids[1]].pendingHeaderRepairs, undefined);
  assert.equal(reconcileManualGraph(revealed, items, true, items, [], titleOptions(items, [700, 282])), revealed);
  const smaller = reconcileManualGraph(hidden, items, true, [items[0]], [], titleOptions([items[0]], [282]));
  const harmless = reconcileManualGraph(smaller, items, true, items, [], titleOptions(items, [282, 282]));
  assert.equal(manualProjectBounds(harmless, ids[1])!.position.x, 318);
  assert.equal(harmless.projects[ids[1]].pendingHeaderRepairs, undefined);
});

test('deferred cascades preserve prior left-to-right order even when the shifted source passes a hidden neighbor', () => {
  for (const [width, sourceX, targetX] of [[584, 620, 938], [964, 1000, 1318]]) {
    const { items, ids, layout } = titleFixture([0, 318, 900]);
    const baseline = reconcileManualGraph(layout, items, true, items, [], titleOptions(items, [282, 282, 282]));
    const hidden = reconcileManualGraph(baseline, items, true, items.slice(0, 2), [], titleOptions(items.slice(0, 2), [width, 282]));
    assert.equal(manualProjectBounds(hidden, ids[1])!.position.x, sourceX);
    assert.equal(manualProjectBounds(hidden, ids[2])!.position.x, 900);
    assert.deepEqual(hidden.projects[ids[2]].pendingHeaderRepairs?.[ids[1]], { width: 282, shiftX: sourceX - 318 });
    const restored = parseGraphPreferences(JSON.stringify({ ...defaultGraphPreferences(), layout: hidden })).layout;
    const revealed = reconcileManualGraph(restored, items, true, items, [], titleOptions(items, [width, 282, 282]));
    assert.equal(manualProjectBounds(revealed, ids[1])!.position.x, sourceX);
    assert.equal(manualProjectBounds(revealed, ids[2])!.position.x, targetX);
    assert.equal(revealed.agents, restored.agents);
    assert.equal(revealed.projects[ids[2]].pendingHeaderRepairs, undefined);
    assert.equal(reconcileManualGraph(revealed, items, true, items, [], titleOptions(items, [width, 282, 282])), revealed);
  }
});

test('deferred repair accumulates title-only cascade shifts while preserving a hidden folder historical geometry', () => {
  const { items, ids, layout } = titleFixture([0, 318, 900]);
  const baseline = reconcileManualGraph(layout, items, true, items, [], titleOptions(items, [282, 282, 282]));
  const first = reconcileManualGraph(baseline, items, true, items.slice(0, 2), [], titleOptions(items.slice(0, 2), [584, 282]));
  const second = reconcileManualGraph(first, items, true, items.slice(0, 2), [], titleOptions(items.slice(0, 2), [700, 282]));
  assert.deepEqual(second.projects[ids[2]].pendingHeaderRepairs?.[ids[1]], { width: 282, shiftX: 418 });
  const revealed = reconcileManualGraph(second, items, true, items, [], titleOptions(items, [700, 282, 282]));
  assert.equal(manualProjectBounds(revealed, ids[2])!.position.x, 1054);

  const pair = titleFixture([0, 318]);
  const history = session('history', { cwd: pair.items[1].cwd });
  const all = [...pair.items, history];
  const visited = moveManualGraphNodes(reconcileManualGraph(pair.layout, all), [{ id: history.id, position: { x: -50000, y: -60000 } }]);
  const measured = reconcileManualGraph(visited, all, true, pair.items, [], titleOptions(pair.items, [282, 282]));
  const hidden = reconcileManualGraph(measured, all, true, [pair.items[0]], [], titleOptions([pair.items[0]], [584]));
  assert.deepEqual(absolute(hidden, history.id), absolute(measured, history.id));
  const visible = reconcileManualGraph(hidden, all, true, pair.items, [], titleOptions(pair.items, [584, 282]));
  assert.equal(manualProjectBounds(visible, pair.ids[1], new Set(pair.items.map(item => item.id)))!.position.x, 620);
  assert.equal(visible.agents, hidden.agents);
  assert.deepEqual(absolute(visible, history.id), { x: absolute(hidden, history.id).x + 302, y: absolute(hidden, history.id).y });
});

test('a deferred baseline affects only its target and never reverses an unrelated actual left neighbor', () => {
  const { items, ids, layout } = titleFixture([1000, 700, 1800]);
  const baseline = reconcileManualGraph(layout, items, true, items, [], titleOptions(items, [282, 282, 282]));
  const stored = structuredClone(baseline);
  stored.projects[ids[2]].pendingHeaderRepairs = { [ids[0]]: { width: 282, shiftX: 682 } };
  const restored = parseGraphPreferences(JSON.stringify({ ...defaultGraphPreferences(), layout: stored })).layout;
  const repaired = reconcileManualGraph(restored, items, true, items, [], titleOptions(items, [584, 584, 282]));
  assert.equal(manualProjectBounds(repaired, ids[1])!.position.x, 700, 'the actual left frame stays anchored');
  assert.equal(manualProjectBounds(repaired, ids[0])!.position.x, 1320);
  assert.equal(manualProjectBounds(repaired, ids[2])!.position.x, 1940);
  assert.equal(repaired.agents, restored.agents);
  assert.equal(reconcileManualGraph(repaired, items, true, items, [], titleOptions(items, [584, 584, 282])), repaired);
});

test('a broad first view does not consume title expansion before filtering makes the title determine the frame width', () => {
  const { items, ids, layout } = titleFixture([0, 318]);
  const history = session('far-history', { cwd: items[0].cwd });
  const all = [...items, history];
  const wide = moveManualGraphNodes(reconcileManualGraph(layout, all), [{ id: history.id, position: { x: -4980, y: 251 } }]);
  const options = titleOptions(items, [585, 459]);
  const broad = reconcileManualGraph(wide, all, true, all, [], options);
  assert.equal(broad.projects[ids[0]].appliedHeaderWidth, undefined);
  assert.equal(reconcileManualGraph(broad, all, true, all, [], options), broad);
  const filtered = reconcileManualGraph(broad, all, true, items, [], options);
  assert.equal(manualProjectBounds(filtered, ids[0], new Set(items.map(item => item.id)))!.position.x, 0);
  assert.equal(manualProjectBounds(filtered, ids[1])!.position.x, 621);
  assert.equal(filtered.projects[ids[0]].appliedHeaderWidth, 585);
  assert.equal(reconcileManualGraph(filtered, all, true, items, [], options), filtered);

  const dragged = moveManualGraphNodes(broad, [{ id: history.id, position: { x: 20, y: 251 } }], new Set(all.map(item => item.id)), options.minimumProjectWidths);
  assert.equal(dragged.projects[ids[0]].appliedHeaderWidth, 585);
  assert.equal(reconcileManualGraph(dragged, all, true, all, [], options), dragged, 'ordinary card drag cannot trigger the filter repair');
  assert.equal(manualProjectBounds(dragged, ids[1])!.position.x, 318);
  const movedWide = moveManualGraphNodes(broad, [{ id: ids[0], position: { x: -4800, y: 145 } }], new Set(all.map(item => item.id)), options.minimumProjectWidths);
  assert.equal(movedWide.projects[ids[0]].appliedHeaderWidth, undefined, 'a drag that leaves cards wider than the title does not consume the baseline');
});

test('fresh multi-column folders leave smaller headers eligible for later filtered-width repair', () => {
  const items = [session('a'), session('b'), session('c')];
  const id = graphProjectId('/work');
  const options = titleOptions([items[0]], [458]);
  const layout = reconcileManualGraph(defaultGraphPreferences().layout, items, true, items, [], options);
  assert.equal(manualProjectBounds(layout, id)!.width, 550);
  assert.equal(layout.projects[id].appliedHeaderWidth, undefined);
  const filtered = reconcileManualGraph(layout, items, true, [items[0]], [], options);
  assert.equal(filtered.projects[id].appliedHeaderWidth, 458);
  assert.equal(filtered.agents, layout.agents);
});

test('invalid optional title metadata is ignored without discarding valid projects and removed sources cannot leave deferred repairs', () => {
  const { items, ids, layout } = titleFixture([0, 318]);
  for (const invalid of [null, -1, 0, '584', {}, Infinity]) {
    const stored = structuredClone(layout);
    Object.assign(stored.projects[ids[0]], { appliedHeaderWidth: invalid });
    Object.assign(stored.projects[ids[1]], { appliedHeaderWidth: 282, pendingHeaderRepairs: {
      [ids[0]]: { width: 282, shiftX: 302 }, [ids[1]]: { width: 282, shiftX: 0 }, 'project:missing': { width: 282, shiftX: 0 },
    } });
    const parsed = parseGraphPreferences(JSON.stringify({ version: 1, mode: 'manual', layout: stored })).layout;
    assert.deepEqual(Object.keys(parsed.projects), ids);
    assert.deepEqual(parsed.projects[ids[0]].position, layout.projects[ids[0]].position);
    assert.equal(parsed.projects[ids[0]].appliedHeaderWidth, undefined);
    assert.deepEqual(parsed.projects[ids[1]].pendingHeaderRepairs, { [ids[0]]: { width: 282, shiftX: 302 } });
  }
  for (const invalid of [null, 282, [], { width: -1, shiftX: 0 }, { width: 282, shiftX: -1 }, { width: '282', shiftX: 0 }, { width: 282, shiftX: Infinity }]) {
    const stored = structuredClone(layout);
    Object.assign(stored.projects[ids[1]], { pendingHeaderRepairs: { [ids[0]]: invalid } });
    const parsed = parseGraphPreferences(JSON.stringify({ ...defaultGraphPreferences(), layout: stored })).layout;
    assert.equal(parsed.projects[ids[1]].pendingHeaderRepairs, undefined);
    assert.deepEqual(parsed.projects[ids[1]].position, layout.projects[ids[1]].position);
  }
  const hidden = reconcileManualGraph(layout, items, true, [items[0]], [], titleOptions([items[0]], [584]));
  assert.ok(hidden.projects[ids[1]].pendingHeaderRepairs);
  const removed = reconcileManualGraph(hidden, [items[1]], true, [items[1]], [], { ...titleOptions([items[1]], [282]), repairHeaderWidths: false });
  assert.equal(removed.projects[ids[1]].pendingHeaderRepairs, undefined);
  assert.deepEqual(removed.projects[ids[1]].position, hidden.projects[ids[1]].position);
});
