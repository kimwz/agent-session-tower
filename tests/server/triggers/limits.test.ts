import assert from 'node:assert/strict';
import test from 'node:test';
import type { Trigger } from '../../../shared/triggers.js';
import { fire } from '../../../server/triggers/firing.js';
import { MAX_FIRED_PER_TRIGGER } from '../../../server/triggers/limits.js';
import { empty } from '../../../server/triggers/state.js';

const now = () => Date.parse('2026-10-10T00:00:00Z');
const actor = { kind: 'owner' as const, via: 'ui' as const };

/** The service tests use a small `firedPerTrigger`; without one, a trigger records up to 20,000 runs. */
test('without a test limit a trigger records up to 20,000 runs, and the next one is refused with nothing stored', () => {
  assert.equal(MAX_FIRED_PER_TRIGGER, 20_000);
  const trigger: Trigger = { id: 'repeat', name: 'repeat', enabled: true, revision: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', createdBy: actor, updatedBy: actor,
    source: { kind: 'schedule', schedule: { type: 'interval', everySeconds: 3600 }, catchUp: 'latest' },
    handler: { kind: 'task', provider: 'codex', instructions: 'fixture', approvals: 'auto', target: { node: 'local', mode: 'auto' } }, policy: { overlap: 'parallel', maxEventsPerHour: 20 } };
  const state = empty(); state.triggers = [trigger];
  for (let index = 0; index < 19_999; index++) state.fired[`${trigger.id} old:${index}`] = '2026-10-09T00:00:00.000Z';
  assert.ok(fire(state, trigger, 'last-slot', now(), 'schedule', now).event, 'the 20,000th run is recorded');
  assert.equal(Object.keys(state.fired).length, 20_000);
  const refused = fire(state, trigger, 'one-more', now(), 'schedule', now);
  assert.equal(refused.event, undefined);
  assert.match(refused.capacity ?? '', /"repeat" has 20000 runs recorded/);
  assert.equal(Object.keys(state.fired).length, 20_000);
});
