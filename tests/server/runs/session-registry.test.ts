import assert from 'node:assert/strict';
import test from 'node:test';
import { CreatedSessionRegistry } from '../../../server/runs/session-registry.js';
import type { Run } from '../../../shared/types.js';

const NATIVE = '30000000-0000-4000-8000-000000000001';
const run = { id: 'run-1', sessionId: 'codex:created-1', createdAt: '2026-10-31T00:00:00.000Z', status: 'queued' } as Run;

test('a native ID maps to the monitor ID only once confirmed, from creation and from saved records alike', () => {
  const registry = new CreatedSessionRegistry({ native: () => undefined, persist: () => {} });
  registry.add({ provider: 'codex', cwd: '/fixture', prompt: 'hello' }, 'codex:created-1', NATIVE, run, '', { kind: 'owner' } as never, false);
  assert.equal(registry.monitorId(`codex:${NATIVE}`), `codex:${NATIVE}`, 'an unconfirmed creation claims no native ID');
  assert.equal(registry.nativeId('codex:created-1'), 'codex:created-1');
  assert.equal(registry.confirm('codex:created-1', NATIVE), true);
  assert.equal(registry.monitorId(`codex:${NATIVE}`), 'codex:created-1');
  assert.equal(registry.nativeId(`codex:${NATIVE}`), `codex:${NATIVE}`);
  assert.equal(registry.monitorId('codex:unknown'), 'codex:unknown');

  const restarted = new CreatedSessionRegistry({ native: () => undefined, persist: () => {} });
  restarted.load(JSON.parse(registry.serialize()));
  assert.equal(restarted.monitorId(`codex:${NATIVE}`), 'codex:created-1');
});
