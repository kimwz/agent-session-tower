import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { SseClient } from '../../../server/http/sse-client.js';
import { SnapshotStream } from '../../../server/http/snapshot-stream.js';
import { applySnapshotPatch, type SnapshotPatch } from '../../../shared/snapshot-patch.js';
import type { Session, Snapshot } from '../../../shared/types.js';

class Response extends EventEmitter {
  frames: string[] = [];
  accepting = true;
  destroyed = false;
  writableEnded = false;
  write(data: string): boolean { this.frames.push(data); return this.accepting; }
  end(): void { this.writableEnded = true; this.emit('close'); }
}
interface Event { id: number; event: string; data: unknown }
function events(response: Response): Event[] {
  return response.frames.flatMap(frame => frame.split('\n\n')).filter(block => block.includes('event: ')).map(block => {
    const lines = block.split('\n');
    const value = (name: string) => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? '';
    return { id: Number(value('id')), event: value('event'), data: JSON.parse(value('data')) };
  });
}
/** Replays a page's view of the stream: complete snapshots replace, patches must fit the last id. */
function replay(response: Response): Snapshot {
  let state: Snapshot | undefined;
  let last = 0;
  for (const event of events(response)) {
    if (event.event === 'snapshot') state = event.data as Snapshot;
    else {
      const patch = event.data as SnapshotPatch;
      assert.equal(patch.base, last, 'a patch must continue the last received snapshot');
      state = applySnapshotPatch(state!, patch);
    }
    last = event.id;
  }
  return state!;
}

const at = '2026-09-23T00:00:00.000Z';
const session = (id: string, lastMessage = ''): Session => ({ id, nativeId: id, provider: 'claude', title: id, cwd: '/fixture', project: 'fixture',
  status: 'idle', statusReason: '', createdAt: at, updatedAt: at, lastMessage, messageCount: 1, isSubagent: false, resumable: true });

function fixture() {
  let state: Snapshot = { sessions: [session('s1'), session('s2')], runs: [], providers: [], scanning: false, hostname: 'host', version: 'test', updatedAt: at };
  let reads = 0;
  const stream = new SnapshotStream(() => { reads++; return { ...state, updatedAt: new Date(Date.now() + reads).toISOString() }; });
  const connect = (patches: boolean) => {
    const response = new Response();
    const client = new SseClient(response, () => stream.detach(client));
    stream.attach(client, patches);
    return { response, client };
  };
  return { stream, connect, set: (next: Partial<Snapshot>) => { state = { ...state, ...next }; }, state: () => state };
}

test('unchanged content sends nothing to patch or complete-snapshot pages', () => {
  const f = fixture();
  const patchPage = f.connect(true);
  const fullPage = f.connect(false);
  for (let index = 0; index < 5; index++) f.stream.publish();
  assert.equal(patchPage.response.frames.length, 1);
  assert.equal(fullPage.response.frames.length, 1);
});

test('a change reaches patch pages as the changed session only and older pages as a complete snapshot', () => {
  const f = fixture();
  const patchPage = f.connect(true);
  const fullPage = f.connect(false);
  const many = Array.from({ length: 50 }, (_, index) => session(`s${index}`));
  f.set({ sessions: many }); f.stream.publish();
  f.set({ sessions: [session('s0', 'New reply'), ...many.slice(1)] });
  f.stream.publish();
  const patch = events(patchPage.response).at(-1)!;
  assert.equal(patch.event, 'patch');
  assert.deepEqual((patch.data as SnapshotPatch).sessions, { upsert: [session('s0', 'New reply')] });
  assert.ok(patchPage.response.frames.at(-1)!.length * 10 < fullPage.response.frames.at(-1)!.length, 'a one-session patch is a small fraction of the snapshot');
  assert.deepEqual(events(fullPage.response).map(event => event.event), ['snapshot', 'snapshot', 'snapshot']);
  for (const page of [patchPage, fullPage]) assert.deepEqual({ ...replay(page.response), updatedAt: at }, { ...f.state(), updatedAt: at });
});

test('a joining page shares the sequence of pages that were connected before it', () => {
  const f = fixture();
  const first = f.connect(true);
  f.set({ sessions: [session('s1', 'Before the second page')] });
  // No publish yet: the broadcast is still waiting for its debounce when the second page joins.
  const second = f.connect(true);
  f.set({ sessions: [session('s1', 'After both pages joined')] });
  f.stream.publish();
  for (const page of [first, second]) assert.deepEqual({ ...replay(page.response), updatedAt: at }, { ...f.state(), updatedAt: at });
  assert.equal(events(first.response).at(-1)!.id, events(second.response).at(-1)!.id);
});

test('a page whose socket was blocked receives the newest complete snapshot, then patches continue from it', () => {
  const f = fixture();
  const page = f.connect(true);
  page.response.accepting = false;
  f.set({ sessions: [session('s1', 'first')] }); f.stream.publish();
  f.set({ sessions: [session('s1', 'second')] }); f.stream.publish();
  f.set({ sessions: [session('s1', 'third')] }); f.stream.publish();
  page.response.accepting = true;
  page.response.emit('drain');
  assert.deepEqual(events(page.response).map(event => event.event), ['snapshot', 'patch', 'snapshot']);
  f.set({ sessions: [session('s1', 'fourth')] }); f.stream.publish();
  assert.equal(events(page.response).at(-1)!.event, 'patch');
  assert.deepEqual({ ...replay(page.response), updatedAt: at }, { ...f.state(), updatedAt: at });
});

test('publishing without any page reads nothing, and the last page leaving drops the retained snapshot', () => {
  let reads = 0;
  const stream = new SnapshotStream(() => { reads++; return { sessions: [], runs: [], providers: [], scanning: false, hostname: 'h', version: 'v', updatedAt: at }; });
  stream.publish();
  assert.equal(reads, 0);
  const response = new Response();
  const client = new SseClient(response, () => stream.detach(client));
  stream.attach(client, true);
  client.end();
  assert.equal(stream.size, 0);
  stream.publish();
  assert.equal(reads, 1);
});
