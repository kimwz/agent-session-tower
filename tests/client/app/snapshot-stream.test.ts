import assert from 'node:assert/strict';
import test from 'node:test';
import { connectSnapshotStream, RECONCILE_MS, RESYNC_MS, SnapshotStore, type SnapshotEventSource } from '../../../client/src/app/snapshot-stream.js';
import type { SnapshotPatch } from '../../../shared/snapshot-patch.js';
import type { Session, Snapshot } from '../../../shared/types.js';

const at = '2026-09-23T00:00:00.000Z';
const session = (id: string, title = id): Session => ({ id, nativeId: id, provider: 'codex', title, cwd: '/fixture', project: 'fixture',
  status: 'idle', statusReason: '', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true });
const snapshot = (title: string): Snapshot => ({ sessions: [session('s1', title), session('s2')], runs: [], providers: [], scanning: false, hostname: 'h', version: 'v', updatedAt: at });
const retitle = (base: number, title: string): SnapshotPatch => ({ base, sessions: { upsert: [session('s1', title)] }, fields: { updatedAt: at } });

class Clock {
  time = 0;
  now = () => this.time;
  private timers: { at: number; callback: () => void; handle: number }[] = [];
  private next = 1;
  setTimeout = (callback: () => void, ms: number) => { const handle = this.next++; this.timers.push({ at: this.time + ms, callback, handle }); return handle; };
  clearTimeout = (handle: unknown) => { this.timers = this.timers.filter(timer => timer.handle !== handle); };
  advance(ms: number) {
    this.time += ms;
    for (;;) {
      const due = this.timers.filter(timer => timer.at <= this.time).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      this.clearTimeout(due.handle);
      due.callback();
    }
  }
}
function displayed() {
  let value: Snapshot | null = null;
  const show = (update: Snapshot | ((current: Snapshot | null) => Snapshot | null)) => { value = typeof update === 'function' ? update(value) : update; };
  return { show, get: () => value };
}
const title = (value: Snapshot | null) => value?.sessions[0].title;

test('patches continue the stream only from the snapshot they name', () => {
  const view = displayed();
  const store = new SnapshotStore(view.show, new Clock());
  assert.equal(store.patch(2, retitle(1, 'Too early')), false, 'no base yet');
  store.complete(1, snapshot('One'));
  assert.equal(store.patch(2, retitle(1, 'Two')), true);
  assert.equal(title(view.get()), 'Two');
  assert.equal(store.patch(4, retitle(3, 'Skipped')), false, 'a gap requires a complete snapshot');
  assert.equal(store.patch(3, { base: 2, sessions: { order: ['missing'] } }), false, 'a patch that does not fit is rejected');
  assert.equal(title(view.get()), 'Two');
});

test('a late mutation response that hides newer stream state is corrected from the stream', () => {
  const clock = new Clock();
  const view = displayed();
  const store = new SnapshotStore(view.show, clock);
  store.setConnected(true);
  store.complete(1, snapshot('Old'));
  store.patch(2, retitle(1, 'Newest'));
  // The response to an earlier rename arrives after the stream already reported a newer one.
  store.provisional(current => current && { ...current, sessions: current.sessions.map(item => item.id === 's1' ? { ...item, title: 'Stale' } : item) });
  assert.equal(title(view.get()), 'Stale');
  clock.advance(RECONCILE_MS - 1);
  assert.equal(title(view.get()), 'Stale');
  clock.advance(1);
  assert.equal(title(view.get()), 'Newest');
});

test('a confirming stream frame replaces a provisional change without waiting', () => {
  const clock = new Clock();
  const view = displayed();
  const store = new SnapshotStore(view.show, clock);
  store.setConnected(true);
  store.complete(1, snapshot('Before'));
  store.provisional(current => current && { ...current, sessions: current.sessions.map(item => item.id === 's1' ? { ...item, title: 'Renamed' } : item) });
  store.patch(2, retitle(1, 'Renamed'));
  clock.advance(RECONCILE_MS * 2);
  assert.equal(title(view.get()), 'Renamed');
});

test('snapshot responses apply only when newest and not overtaken by the stream', () => {
  const clock = new Clock();
  const view = displayed();
  const store = new SnapshotStore(view.show, clock);
  const initial = store.beginRequest();
  store.response(initial, snapshot('Initial response'));
  assert.equal(title(view.get()), 'Initial response', 'before the stream starts, a response is all there is');
  store.setConnected(true);
  store.complete(1, snapshot('Stream'));
  const older = store.beginRequest();
  const newer = store.beginRequest();
  store.response(newer, snapshot('Newer response'));
  store.response(older, snapshot('Older response'));
  assert.equal(title(view.get()), 'Newer response', 'an earlier request arriving last is discarded');
  const overtaken = store.beginRequest();
  store.patch(2, retitle(1, 'Stream moved on'));
  store.response(overtaken, snapshot('Overtaken response'));
  assert.equal(title(view.get()), 'Stream moved on');
});

test('while the stream is disconnected, provisional state is not replaced by an outdated stream snapshot', () => {
  const clock = new Clock();
  const view = displayed();
  const store = new SnapshotStore(view.show, clock);
  store.setConnected(true);
  store.complete(1, snapshot('Before outage'));
  store.setConnected(false);
  store.provisional(snapshot('Fetched during outage'));
  clock.advance(RECONCILE_MS * 3);
  assert.equal(title(view.get()), 'Fetched during outage');
});

class FakeSource implements SnapshotEventSource {
  static opened: FakeSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor(readonly url: string) { FakeSource.opened.push(this); }
  addEventListener(type: 'snapshot' | 'patch', listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type: 'snapshot' | 'patch', id: number, data: unknown) {
    this.listeners.get(type)!({ data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId: String(id) } as MessageEvent<string>);
  }
}

test('a patch that does not continue the stream reconnects for a complete snapshot, at most once per interval', () => {
  FakeSource.opened = [];
  const clock = new Clock();
  const view = displayed();
  const store = new SnapshotStore(view.show, clock);
  let unreadable = 0;
  const disconnect = connectSnapshotStream(store, { onFrame: () => {}, onOpen: () => {}, onError: () => {}, onUnreadable: () => { unreadable++; } },
    url => new FakeSource(url), clock);
  const first = FakeSource.opened[0];
  assert.equal(first.url, '/api/events?patch=1');
  first.onopen?.(new Event('open'));
  first.emit('snapshot', 5, snapshot('Five'));
  first.emit('patch', 7, retitle(6, 'Gap'));
  assert.equal(first.closed, true);
  clock.advance(0);
  const second = FakeSource.opened[1];
  assert.ok(second, 'the first recovery reconnects at once');
  first.emit('patch', 6, retitle(5, 'Ignored from a closed source'));
  assert.equal(title(view.get()), 'Five');
  second.emit('snapshot', 1, snapshot('Restarted'));
  second.emit('patch', 3, retitle(2, 'Gap again'));
  clock.advance(RESYNC_MS - 1);
  assert.equal(FakeSource.opened.length, 2, 'repeated recovery waits for the interval');
  clock.advance(1);
  assert.equal(FakeSource.opened.length, 3);
  FakeSource.opened[2].emit('snapshot', 9, 'not json');
  assert.equal(unreadable, 1);
  disconnect();
  assert.equal(FakeSource.opened[2].closed, true);
});
