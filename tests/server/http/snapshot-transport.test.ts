import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorServer } from '../../../server/http/server.js';
import { conversationRevision } from '../../../client/src/sessions/session-read-state.js';
import type { Session, Run, Snapshot } from '../../../shared/types.js';

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
