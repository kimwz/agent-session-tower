import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClosedSessionStore } from '../../../server/stores/closed-sessions.js';
import type { Session } from '../../../shared/types.js';

const session: Session = {
  id: 'codex:isolated-fixture', nativeId: 'isolated-fixture', provider: 'codex', title: 'Fixture',
  cwd: '/tmp', project: 'tmp', status: 'working', statusReason: 'Fixture',
  createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', lastMessage: '',
  messageCount: 0, isSubagent: false, resumable: true,
};

test('a reload paused after reading cannot roll back a completed close; flush shares the queue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'closed-owner-reload-'));
  const path = join(dir, 'closed-sessions.json');
  await writeFile(path, '[]', { mode: 0o600 });
  const sample = await open(path, 'r');
  const prototype: { chmod: typeof sample.chmod } = Object.getPrototypeOf(sample);
  const original = prototype.chmod;
  await sample.close();
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const atChmod = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  let setCompleted = false;
  let flushed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const store = new ClosedSessionStore(dir);
  let reload: Promise<void> | undefined;
  let save: Promise<void> | undefined;
  let flush: Promise<void> | undefined;
  try {
    prototype.chmod = async function (...args) {
      if (first) { first = false; entered(); await paused; }
      return original.apply(this, args);
    };
    reload = store.start();
    await atChmod;
    save = store.set(session, true).then(result => {
      setCompleted = true;
      assert.equal(result.closed, true);
      assert.equal(store.apply(session).closed, true);
    });
    flush = store.flush().then(() => { flushed = true; });
    // Same actual-file ordering and bounded wait as the confirmed baseline repro.
    await Promise.race([save, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
    assert.equal(setCompleted, false, 'set must wait for the older reload in the owner queue');
    assert.equal(flushed, false, 'flush must wait for both queued operations');
    release();
    await save;
    await reload;
    await flush;
    assert.equal(store.closedIds().has(session.id), true, 'zero rollbacks after completed set');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).includes(session.id), true);
  } finally {
    clearTimeout(timer);
    release();
    await Promise.allSettled([reload, save, flush]);
    prototype.chmod = original;
  }
});

test('normal start and queued writes recover after mkdir and reload failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'closed-owner-recovery-'));
  const stateDir = join(dir, 'state');
  await writeFile(stateDir, 'blocked');
  const store = new ClosedSessionStore(stateDir);
  await assert.rejects(store.start());
  await store.flush();
  await rename(stateDir, join(dir, 'blocked'));
  await store.start();
  const path = join(stateDir, 'closed-sessions.json');
  await writeFile(path, 'invalid');
  const failedStart = store.start();
  const failedSet = store.set(session, true);
  await Promise.all([
    assert.rejects(failedStart, SyntaxError),
    assert.rejects(failedSet, { kind: 'unavailable' }),
  ]);
  await store.flush();
  assert.equal(store.apply(session).closed, undefined);
  await writeFile(path, JSON.stringify([session.id]));
  await store.start();
  assert.equal(store.apply(session).closed, true);
  const reopened = await store.set(session, false);
  assert.equal(reopened.closed, undefined);
  assert.equal(reopened.status, session.status);
  await store.flush();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
});
