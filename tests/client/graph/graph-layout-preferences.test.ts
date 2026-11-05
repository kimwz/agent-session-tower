import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../../../shared/types.js';
import { clearHostPosition, graphProjectId, graphSessionGroups, HOST_CLEARANCE, HOST_HEIGHT, HOST_WIDTH } from '../../../client/src/graph/graph-layout.js';
import { sessionStaysShown } from '../../../shared/session-activity.js';
import { defaultGraphPreferences, manualSessionGroups, moveManualGraphNodes, parseGraphPreferences, PROJECT_GAP, projectColumns, projectGrid, reconcileManualGraph, setGraphLayoutMode, setProjectColumns, type ManualGraphLayout, type ManualProject, type ProjectFrame } from '../../../client/src/graph/graph-layout-preferences.js';

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
  assert.deepEqual(next.projects[other].position, { x: -318, y: 145 }, 'beside the only group there is, on the side the computer card leaves free');
  assertClear(next.projects, [other]);
});

const FAR = 2000;
const named = (name: string) => graphProjectId(`/${name}`);
const fresh = named('fresh');
/** A folder saved at a corner, sized as one holding `count` sessions. */
const placedAt = (x: number, y: number, count = 1): ManualProject => {
  const { width, height } = frame('', count);
  return { position: { x, y }, width, height };
};
const layoutOf = (places: Record<string, ManualProject>, extra: Partial<ManualGraphLayout> = {}): ManualGraphLayout => ({ projects: Object.fromEntries(Object.entries(places).map(([name, place]) => [named(name), place])), host: { x: 128, y: -400 }, ...extra });
const framesOf = (layout: ManualGraphLayout): ProjectFrame[] => Object.entries(layout.projects).map(([id, { width, height }]) => ({ id, width, height }));
/** Empty space between two boxes along whichever axis separates them most; negative when they overlap. */
const clearance = (a: ManualProject, b: ManualProject) => Math.max(b.position.x - a.position.x - a.width, a.position.x - b.position.x - b.width, b.position.y - a.position.y - a.height, a.position.y - b.position.y - b.height);
function assertClear(projects: Record<string, ManualProject>, added: string[]) {
  for (const id of added) for (const [other, place] of Object.entries(projects)) if (other !== id) {
    assert.ok(clearance(projects[id], place) >= PROJECT_GAP, `${decodeURIComponent(id)} keeps clear of ${decodeURIComponent(other)}`);
  }
}
function addFresh(layout: ManualGraphLayout, avoid: ManualProject[] = []) {
  const next = reconcileManualGraph(layout, [...framesOf(layout), frame(fresh)], undefined, () => false, avoid);
  for (const [id, place] of Object.entries(layout.projects)) assert.deepEqual(next.projects[id], place, `${decodeURIComponent(id)} stays where it was placed`);
  assertClear(next.projects, [fresh]);
  return next.projects[fresh].position;
}
const inside = (place: { x: number; y: number }, left: number, top: number, right: number, bottom: number) => place.x >= left && place.x <= right && place.y >= top && place.y <= bottom;

const mainGroup = { alpha: placedAt(0, 145, 2), beta: placedAt(318, 145), gamma: placedAt(636, 145), delta: placedAt(318, 517, 2), epsilon: placedAt(636, 517) };

test('one folder far off does not pull a new folder away from where the sessions are', () => {
  for (const outlier of [placedAt(5200, -1500), placedAt(-5200, 145), placedAt(0, 9000), placedAt(5200, 9000)]) {
    const place = addFresh(layoutOf({ ...mainGroup, outlier }));
    assert.ok(inside(place, -400, -300, 1300, 1500), `${JSON.stringify(place)} is by the main group, not by ${JSON.stringify(outlier.position)}`);
  }
});

test('with several groups a new folder joins the one holding the most, never the empty corner between them', () => {
  const small = { zeta: placedAt(3000, 1900), eta: placedAt(3318, 1900) };
  const place = addFresh(layoutOf({ ...small, ...mainGroup }));
  assert.ok(inside(place, -400, -300, 1300, 1500), JSON.stringify(place));
  // A row of single-session folders the earlier rule left far away does not outweigh a group with more sessions.
  const row = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`row${index}`, placedAt(5000 + index * 318, 145)]));
  const bigger = { alpha: placedAt(0, 145, 4), beta: placedAt(318, 145, 4) };
  assert.ok(inside(addFresh(layoutOf({ ...row, ...bigger })), -400, -300, 1000, 2000));
});

test('groups of the same size: a new folder joins the first one listed, the most recently active', () => {
  const left = { a: placedAt(0, 145) };
  const right = { b: placedAt(FAR * 3, 145) };
  assert.ok(addFresh(layoutOf({ ...left, ...right })).x < FAR);
  assert.ok(addFresh(layoutOf({ ...right, ...left })).x > FAR);
});

test('folders with a clearly visible stretch between them count as separate groups', () => {
  const place = addFresh(layoutOf({ a: placedAt(0, 145), b: placedAt(282 + 400, 145), c: placedAt(2 * (282 + 400), 145, 2) }));
  assert.ok(place.x >= 1364 - 318 && place.x <= 1364 + 318, `${JSON.stringify(place)} is beside the largest folder, which is apart from the others`);
  const joined = addFresh(layoutOf({ a: placedAt(0, 145), b: placedAt(282 + 399, 145), c: placedAt(5000, 145, 2) }));
  assert.ok(joined.x < 1100, `${JSON.stringify(joined)}: two folders within reach outweigh the bigger lone one`);
});

test('the first folders on an empty canvas form the usual row, and sessions with nothing saved place nothing', () => {
  const empty = defaultGraphPreferences().layout;
  assert.equal(reconcileManualGraph(empty, []), empty);
  const row = reconcileManualGraph(empty, [frame(work), frame(other, 2), frame(fresh)]);
  assert.deepEqual([row.projects[work].position, row.projects[other].position, row.projects[fresh].position], [{ x: 0, y: 145 }, { x: 318, y: 145 }, { x: 636, y: 145 }]);
  assert.deepEqual(row.host, empty.host);
});

test('a new folder on an empty canvas stays off a monitor dragged where the row would start', () => {
  const monitor = { position: { x: 0, y: 145 }, width: 300, height: 400 };
  const { projects } = reconcileManualGraph(defaultGraphPreferences().layout, [frame(work), frame(other)], undefined, () => false, [monitor]);
  assert.ok(clearance(projects[work], monitor) >= PROJECT_GAP && clearance(projects[other], monitor) >= PROJECT_GAP, JSON.stringify(projects));
  assert.ok(clearance(projects[work], projects[other]) >= PROJECT_GAP, JSON.stringify(projects));
});

test('the first folder on an empty canvas leaves a computer card moved by hand where it is', () => {
  const host = { x: 0, y: 200 };
  const { projects } = reconcileManualGraph({ projects: {}, host }, [frame(work), frame(other)]);
  const boxes = [projects[work], projects[other]];
  assert.deepEqual(clearHostPosition(host, boxes), host);
  for (const box of boxes) assert.ok(clearance(box, { position: host, width: HOST_WIDTH, height: HOST_HEIGHT }) >= HOST_CLEARANCE, JSON.stringify(box));
});

test('a session in a folder already there takes no new place: the folder grows where it is', () => {
  const layout = layoutOf({ alpha: placedAt(0, 145), beta: placedAt(318, 145), lone: placedAt(5200, -1500) });
  const shown = framesOf(layout);
  const next = reconcileManualGraph(layout, shown.map(item => item.id === named('alpha') ? frame(item.id, 2) : item));
  assert.deepEqual(Object.keys(next.projects), Object.keys(layout.projects));
  assert.deepEqual(next.projects[named('alpha')], { ...placedAt(0, 145, 2) });
  assert.deepEqual(next.projects[named('beta')], layout.projects[named('beta')]);
  assert.deepEqual(next.projects[named('lone')], layout.projects[named('lone')]);
});

test('several new folders at once each get their own free place by the same group', () => {
  const layout = layoutOf(mainGroup);
  const added = Array.from({ length: 6 }, (_, index) => named(`new${index}`));
  const next = reconcileManualGraph(layout, [...framesOf(layout), ...added.map(id => frame(id, 1 + added.indexOf(id) % 3))]);
  assertClear(next.projects, added);
  for (const id of Object.keys(layout.projects)) assert.deepEqual(next.projects[id], layout.projects[id]);
  for (const id of added) assert.ok(inside(next.projects[id].position, -1000, -1000, 2200, 2400), `${decodeURIComponent(id)} at ${JSON.stringify(next.projects[id].position)}`);
});

test('a new folder is as near as the room allows when the spots beside the group are taken', () => {
  // A hole in the middle of the group that fits one folder and its gaps is used.
  const ring = { nw: placedAt(0, 0), n: placedAt(318, 0), ne: placedAt(636, 0), w: placedAt(0, 372), e: placedAt(636, 372), sw: placedAt(0, 744), s: placedAt(318, 744), se: placedAt(636, 744) };
  assert.deepEqual(addFresh(layoutOf(ring)), { x: 318, y: 372 });
  // The same hole too narrow for the gaps is not.
  const tight = { ...ring, w: placedAt(40, 372), e: placedAt(600, 372) };
  const place = addFresh(layoutOf(tight));
  assert.notDeepEqual(place, { x: 318, y: 372 });
});

test('a new folder keeps off folders the filter hides, computer cards and a dragged monitor', () => {
  const hidden = named('hidden');
  const layout = layoutOf({ a: placedAt(0, 145), hidden: placedAt(318, 145) });
  const shown = framesOf(layout).filter(item => item.id !== hidden);
  const next = reconcileManualGraph(layout, [...shown, frame(fresh)]);
  assert.deepEqual(next.projects[hidden], layout.projects[hidden]);
  assertClear(next.projects, [fresh]);

  const b = 'b'.repeat(32);
  for (const host of [{ x: 318, y: 145 }, { x: 0, y: 517 }]) {
    const withHost = layoutOf({ a: placedAt(0, 145) }, { host, hosts: { [b]: { x: 318, y: 145 } } });
    const place = addFresh(withHost);
    const frameBoxes = [withHost.projects[named('a')]];
    const card = { position: clearHostPosition(host, frameBoxes), width: HOST_WIDTH, height: HOST_HEIGHT };
    assert.ok(clearance({ position: place, ...frame('') }, card) >= HOST_CLEARANCE, `${JSON.stringify(place)} clear of the card at ${JSON.stringify(card.position)}`);
    assert.deepEqual(clearHostPosition(host, [...frameBoxes, { position: place, ...frame('') }]), card.position, 'the card does not have to move out of the way');
    assert.ok(clearance({ position: place, ...frame('') }, { position: { x: 318, y: 145 }, width: HOST_WIDTH, height: HOST_HEIGHT }) >= HOST_CLEARANCE, 'the joined computer card too');
  }

  const monitor = { position: { x: 318, y: 145 }, width: 400, height: 500 };
  const layoutWithMonitor = layoutOf({ a: placedAt(0, 145) });
  const place = addFresh(layoutWithMonitor, [monitor]);
  assert.ok(clearance({ position: place, ...frame('') }, monitor) >= PROJECT_GAP, JSON.stringify(place));
});

test('a joined computer\'s new folder goes with that computer\'s folders, and this one\'s with its own', () => {
  const b = 'b'.repeat(32);
  const local = named('local');
  const remote = graphProjectId(`@${b}//remote`);
  const added = graphProjectId(`@${b}//added`);
  const layout = { host: { x: 128, y: -400 }, projects: { [local]: placedAt(0, 145, 4), [remote]: placedAt(5000, 145) } };
  const next = reconcileManualGraph(layout, [frame(local, 4), frame(remote), frame(added), frame(fresh)]);
  assert.ok(next.projects[added].position.x > 4000, JSON.stringify(next.projects[added]));
  assert.ok(next.projects[fresh].position.x < 1000, JSON.stringify(next.projects[fresh]));
  assertClear(next.projects, [added, fresh]);
  // A computer's first folder has no folders of its own to join.
  const first = reconcileManualGraph({ ...layout, projects: { [local]: placedAt(0, 145, 4) } }, [frame(local, 4), frame(added)]);
  assert.ok(first.projects[added].position.x < 1000, JSON.stringify(first.projects[added]));
});

test('a new folder keeps off the card of a joined computer nobody placed by hand', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const folderOfA = graphProjectId(`@${a}//app`), folderOfB = graphProjectId(`@${b}//big`), added = graphProjectId(`@${b}//added`);
  const wide = { width: 550, height: 336 };
  const layout: ManualGraphLayout = { host: { x: 5000, y: 5000 }, projects: { [folderOfA]: placedAt(0, 0), [folderOfB]: { position: { x: 0, y: -744 }, ...wide } } };
  const next = reconcileManualGraph(layout, [frame(folderOfA), { id: folderOfB, ...wide }, frame(added)]);
  const cardOfA = { position: { x: 0, y: -HOST_HEIGHT - 40 }, width: HOST_WIDTH, height: HOST_HEIGHT };
  assert.ok(clearance(next.projects[added], cardOfA) >= HOST_CLEARANCE, JSON.stringify(next.projects[added]));
  assertClear(next.projects, [added]);
});

test('with only a hidden group saved, a new folder still joins it instead of starting over', () => {
  const layout = layoutOf({ far: placedAt(4000, 3000) });
  const next = reconcileManualGraph(layout, [frame(fresh)]);
  assert.ok(inside(next.projects[fresh].position, 3500, 2500, 4500, 3500), JSON.stringify(next.projects[fresh]));
  assertClear(next.projects, [fresh]);
});

test('placement decides once and the same layout gives the same place, so the drawn and saved values never differ', () => {
  const layout = layoutOf({ ...mainGroup, outlier: placedAt(5200, -1500) });
  const shown = [...framesOf(layout), frame(fresh)];
  const first = reconcileManualGraph(layout, shown);
  assert.deepEqual(reconcileManualGraph(layout, shown), first);
  assert.equal(reconcileManualGraph(first, shown), first, 'a settled layout comes back unchanged');
  const moved = moveManualGraphNodes(first, [{ id: fresh, position: { x: -700, y: 40 } }]);
  assert.deepEqual(reconcileManualGraph(moved, shown).projects[fresh].position, { x: -700, y: 40 }, 'once dragged it stays');
});

test('whatever the arrangement, a new folder touches nothing, moves nothing and lands by a group', () => {
  // A fixed sequence, so a failure repeats exactly.
  let state = 224;
  const next = (limit: number) => { state = (state * 1103515245 + 12345) % 2147483648; return state % limit; };
  for (let round = 0; round < 60; round++) {
    const places = Object.fromEntries(Array.from({ length: 1 + next(25) }, (_, index) => {
      const spread = next(2) ? 3000 : 12000;
      return [`f${index}`, placedAt(next(spread) - spread / 2, next(spread) - spread / 2, 1 + next(4))];
    }));
    const layout = layoutOf(places);
    const place = addFresh(layout);
    const nearest = Math.min(...Object.values(layout.projects).map(other => clearance({ position: place, ...frame('') }, other)));
    assert.ok(nearest < 1200, `round ${round}: ${JSON.stringify(place)} is ${nearest} away from the nearest folder`);
  }
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
