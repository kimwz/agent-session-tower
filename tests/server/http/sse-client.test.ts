import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { SseClient } from '../../../server/http/sse-client.js';

class Response extends EventEmitter {
  frames: string[] = [];
  accepting = true;
  destroyed = false;
  writableEnded = false;
  write(data: string): boolean { this.frames.push(data); return this.accepting; }
  end(): void { this.writableEnded = true; this.emit('close'); }
}

test('stalled SSE retains only the latest snapshot and delivers it on drain without another broadcast', () => {
  const response = new Response();
  let closes = 0;
  const client = new SseClient(response, () => { closes++; });
  response.accepting = false;
  client.snapshot('initial');
  for (let index = 0; index < 10000; index++) {
    client.snapshot(`snapshot-${index}`);
    client.heartbeat();
  }
  assert.deepEqual(response.frames, ['initial']);
  assert.equal(closes, 0);
  assert.equal(response.destroyed, false);
  response.accepting = true;
  response.emit('drain');
  assert.deepEqual(response.frames, ['initial', 'snapshot-9999']);
  response.emit('drain'); // A consumed write is never sent twice.
  client.heartbeat();
  assert.deepEqual(response.frames, ['initial', 'snapshot-9999', ': heartbeat\n\n']);
  client.end();
});

test('a drained latest snapshot can block again without accumulating intermediate frames', () => {
  const response = new Response();
  const client = new SseClient(response, () => {});
  response.accepting = false;
  client.snapshot('first'); client.snapshot('second');
  response.emit('drain');
  client.snapshot('third'); client.snapshot('final'); client.heartbeat();
  assert.deepEqual(response.frames, ['first', 'second']);
  response.accepting = true;
  response.emit('drain');
  assert.deepEqual(response.frames, ['first', 'second', 'final']);
  client.end();
});

for (const mode of ['remote-close', 'dispose'] as const) {
  test(`SSE ${mode} clears pending data and drain listeners exactly once`, () => {
    const response = new Response();
    let closes = 0;
    const client = new SseClient(response, () => { closes++; });
    response.accepting = false;
    client.snapshot('first'); client.snapshot('pending');
    assert.equal(response.listenerCount('drain'), 1);
    if (mode === 'remote-close') { response.destroyed = true; response.emit('close'); }
    else client.end();
    assert.equal(response.listenerCount('drain'), 0);
    assert.equal(response.listenerCount('close'), 0);
    response.emit('drain'); client.snapshot('late'); client.heartbeat(); client.end();
    assert.deepEqual(response.frames, ['first']);
    assert.equal(closes, 1);
  });
}

test('heartbeat backpressure also waits for drain before writing the latest snapshot', () => {
  const response = new Response();
  const client = new SseClient(response, () => {});
  response.accepting = false;
  client.heartbeat(); client.snapshot('latest'); client.heartbeat();
  assert.deepEqual(response.frames, [': heartbeat\n\n']);
  response.accepting = true; response.emit('drain');
  assert.deepEqual(response.frames, [': heartbeat\n\n', 'latest']);
  client.end();
});

test('a stalled page keeps the newest snapshot of each stream it carries, and gets all of them on drain', () => {
  const response = new Response();
  const client = new SseClient(response, () => {});
  response.accepting = false;
  client.snapshot('own-1');
  for (let index = 0; index < 100; index++) {
    client.update(`own-patch-${index}`, () => `own-${index}`);
    client.update(`b-patch-${index}`, () => `b-${index}`, 'b');
    client.update(`c-patch-${index}`, () => `c-${index}`, 'c');
  }
  client.snapshot('b-removed', 'b');
  assert.deepEqual(response.frames, ['own-1']);
  response.accepting = true;
  response.emit('drain');
  assert.deepEqual(response.frames, ['own-1', 'own-99', 'c-99', 'b-removed'], 'each stream resumes from its own latest complete state');
});
