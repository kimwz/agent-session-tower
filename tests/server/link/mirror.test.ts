import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ControllerLinks } from '../../../server/link/controller.js';
import { NodeMirrors } from '../../../server/link/mirror.js';
import type { Snapshot } from '../../../shared/types.js';

const NODE = 'b'.repeat(32);
const now = new Date().toISOString();
const snapshot = (title: string): Snapshot => ({ sessions: [{ id: 'codex:1', nativeId: '1', provider: 'codex', title, cwd: '/work', project: 'work', status: 'idle', statusReason: '',
  createdAt: now, updatedAt: now, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true }], runs: [], providers: [], scanning: false, hostname: 'b', version: 'test', updatedAt: now });

class Stream extends EventEmitter {
  destroyed = false;
  close() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); }
  frame(event: string, id: number, data: unknown) { this.emit('data', Buffer.from(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
}
/** A controller with one joined computer whose event stream the test writes by hand. */
function setup() {
  const streams: Stream[] = [];
  const links = new EventEmitter() as EventEmitter & Pick<ControllerLinks, 'list' | 'session'>;
  links.list = () => [{ id: NODE, name: 'b', fingerprint: '', status: 'connected', features: [], pairedAt: now }];
  links.session = () => ({ request: () => { const stream = new Stream(); streams.push(stream); queueMicrotask(() => stream.emit('response', { ':status': 200 })); return stream; } }) as never;
  const mirrors = new NodeMirrors(links as unknown as ControllerLinks);
  return { links, mirrors, streams };
}

test('a frame that would not make a usable snapshot restarts that computer’s stream and keeps its last good state', async t => {
  const { mirrors, streams } = setup();
  t.after(() => mirrors.close());
  await new Promise(resolve => setImmediate(resolve));
  streams[0].frame('snapshot', 1, snapshot('good'));
  assert.equal(mirrors.snapshot(NODE)?.sessions[0].title, 'good');
  streams[0].frame('patch', 2, { base: 1, fields: { sessions: null } });
  assert.equal(streams[0].destroyed, true, 'the stream starts over from a complete snapshot');
  assert.equal(mirrors.snapshot(NODE)?.sessions[0].title, 'good');
  assert.equal(mirrors.live(NODE), false);
});

test('a listener that cannot use a frame does not take this Tower down; the stream starts over', async t => {
  const { mirrors, streams } = setup();
  t.after(() => mirrors.close());
  await new Promise(resolve => setImmediate(resolve));
  streams[0].frame('snapshot', 1, snapshot('good'));
  mirrors.on('change', () => { if (mirrors.snapshot(NODE)?.sessions[0].title === 'breaks') throw new Error('listener failed'); });
  assert.doesNotThrow(() => streams[0].frame('snapshot', 2, snapshot('breaks')));
  assert.equal(streams[0].destroyed, true);
  assert.equal(mirrors.snapshot(NODE)?.sessions[0].title, 'good');
});

test('a first frame that arrives before its answer’s status is kept, and a refused stream is not read', async t => {
  const streams: Stream[] = [];
  const statuses = [200, 403];
  const links = new EventEmitter() as EventEmitter & Pick<ControllerLinks, 'list' | 'session'>;
  links.list = () => [{ id: NODE, name: 'b', fingerprint: '', status: 'connected', features: [], pairedAt: now }];
  links.session = () => ({ request: () => { const stream = new Stream(); streams.push(stream); return stream; } }) as never;
  const mirrors = new NodeMirrors(links as unknown as ControllerLinks);
  t.after(() => mirrors.close());
  // The snapshot frame, then the status: both reach this side, in that order.
  streams[0].frame('snapshot', 1, snapshot('early'));
  assert.equal(mirrors.snapshot(NODE), undefined, 'not used before the status says it is the stream');
  streams[0].emit('response', { ':status': statuses[0] });
  assert.equal(mirrors.snapshot(NODE)?.sessions[0].title, 'early');
  assert.equal(mirrors.live(NODE), true);
  const refused = new NodeMirrors(links as unknown as ControllerLinks);
  t.after(() => refused.close());
  streams[1].frame('snapshot', 1, snapshot('refused'));
  streams[1].emit('response', { ':status': statuses[1] });
  assert.equal(refused.snapshot(NODE), undefined);
  assert.equal(streams[1].destroyed, true, 'it starts over');
});
