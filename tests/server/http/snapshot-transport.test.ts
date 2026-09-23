import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorServer } from '../../../server/http/server.js';
import { conversationRevision } from '../../../client/src/sessions/session-read-state.js';
import type { Session, Run, Snapshot } from '../../../shared/types.js';
import type { SnapshotPatch } from '../../../shared/snapshot-patch.js';
import { until } from '../../helpers/until.ts';

test('HTTP and successive SSE snapshots omit accumulated output while retaining exact unread changes', async t => {
  const session: Session = { id: 'claude:transport-fixture', nativeId: 'transport-fixture', provider: 'claude', title: 'Transport fixture', cwd: '/fixture', project: 'fixture', status: 'working', statusReason: '', createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z', lastMessage: 'Original', messageCount: 1, isSubagent: false, resumable: true, filePath: '/private/native.jsonl' };
  const run: Run = { id: 'active', sessionId: session.id, prompt: 'Keep working', status: 'running', createdAt: session.createdAt, output: 'PRIVATE_ACCUMULATED_OUTPUT'.repeat(2500) };
  const original = run.output;
  const source: Snapshot = { sessions: [session], runs: [run], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: session.updatedAt };
  let publish!: () => void;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: '/tmp', backend: {
    snapshot: () => source, detail: async () => undefined, enqueue: async () => run, cancel: async () => {}, subscribe: listener => { publish = listener; return () => {}; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const expected = conversationRevision(session, [run]);
  const response = await fetch(`${base}/api/snapshot`);
  const text = await response.text();
  assert.ok(text.length < 5000, 'Snapshot size should not scale with unused accumulated output.');
  assert.doesNotMatch(text, /PRIVATE_ACCUMULATED_OUTPUT|private\/native/);
  const snapshot = JSON.parse(text) as Snapshot;
  assert.equal(conversationRevision(snapshot.sessions[0], snapshot.runs), expected);
  assert.equal(run.output, original, 'Projection must preserve stored output.');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = events.body!.getReader();
  let buffer = '';
  const nextSnapshot = async (): Promise<Snapshot> => {
    while (true) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) return JSON.parse(data.slice(6));
        continue;
      }
      const result = await reader.read();
      assert.equal(result.done, false, 'SSE should remain connected.');
      buffer += new TextDecoder().decode(result.value);
    }
  };
  const initial = await nextSnapshot();
  assert.equal(conversationRevision(initial.sessions[0], initial.runs), expected);
  run.output += 'New response';
  publish();
  const changed = await nextSnapshot();
  assert.equal(changed.runs[0].output, '');
  assert.equal(conversationRevision(changed.sessions[0], changed.runs), conversationRevision(session, [run]));
  assert.notEqual(conversationRevision(changed.sessions[0], changed.runs), expected);
  controller.abort();
});

test('SSE sends nothing for unchanged content, patches to pages that ask, and complete snapshots to older pages', async t => {
  const sessions: Session[] = Array.from({ length: 40 }, (_, index) => ({ id: `claude:patch-${index}`, nativeId: `patch-${index}`, provider: 'claude', title: `Patch ${index}`, cwd: '/fixture', project: 'fixture', status: 'idle', statusReason: '', createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z', lastMessage: 'Original', messageCount: 1, isSubagent: false, resumable: true }));
  const run: Run = { id: 'streaming', sessionId: sessions[0].id, prompt: 'Keep working', status: 'running', createdAt: sessions[0].createdAt, output: 'first' };
  let publish!: () => void;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: '/tmp', backend: {
    snapshot: () => ({ sessions, runs: [run], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: new Date().toISOString() }),
    detail: async () => undefined, enqueue: async () => run, cancel: async () => {}, subscribe: listener => { publish = listener; return () => {}; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const open = async (path: string) => {
    const reader = (await fetch(`${base}${path}`, { signal: controller.signal })).body!.getReader();
    let buffer = '';
    const frames: string[] = [];
    void (async () => {
      for (;;) {
        const result = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (result.done) return;
        buffer += new TextDecoder().decode(result.value);
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (frame.includes('event: ')) frames.push(frame); }
      }
    })();
    return frames;
  };
  const patchPage = await open('/api/events?patch=1');
  const fullPage = await open('/api/events');
  await until(() => patchPage.length === 1 && fullPage.length === 1);
  publish();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(patchPage.length, 1, 'an unchanged snapshot is not sent again');
  assert.equal(fullPage.length, 1);
  run.output += ' and more';
  publish();
  await until(() => patchPage.length === 2 && fullPage.length === 2);
  assert.match(patchPage[1], /^id: \d+\nevent: patch\n/);
  const patch = JSON.parse(patchPage[1].split('\n').find(line => line.startsWith('data: '))!.slice(6)) as SnapshotPatch;
  assert.deepEqual(patch.sessions?.upsert?.map(session => session.id), [sessions[0].id], 'only the session whose read revision changed is sent');
  assert.equal(patch.runs, undefined, 'private output changes do not resend the run');
  assert.doesNotMatch(patchPage[1], /and more/);
  assert.match(fullPage[1], /^id: \d+\nevent: snapshot\n/);
  assert.ok(patchPage[1].length * 5 < fullPage[1].length);
  controller.abort();
});
