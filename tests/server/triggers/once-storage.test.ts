import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeOnceTrigger, encodeOnceTrigger, ONCE_FALLBACK } from '../../../server/triggers/once-storage.js';
import { nextSlot, previewSlots, validateSchedule } from '../../../server/triggers/schedule.js';
import { RepeatingScheduleSchema, TriggerInputSchema, type Trigger } from '../../../shared/triggers.js';
const trigger: Trigger = { id: 'test', revision: 1, name: 'Reservation', enabled: true, createdAt: '', updatedAt: '', createdBy: { kind: 'owner', via: 'ui' }, updatedBy: { kind: 'owner', via: 'ui' },
  source: { kind: 'schedule', schedule: { type: 'once', at: '2027-10-03T00:00:00.000Z' }, catchUp: 'latest' }, handler: { kind: 'task', provider: 'codex', approvals: 'auto', instructions: 'Check once', target: { node: 'local', mode: 'auto' } }, policy: { overlap: 'skip', maxEventsPerHour: 20 } };
test('once storage remains a readable disabled legacy definition with no next execution time', () => {
  const stored = encodeOnceTrigger(trigger);
  assert.equal(stored.enabled, false);
  assert.ok(RepeatingScheduleSchema.safeParse(stored.source.schedule).success);
  validateSchedule(ONCE_FALLBACK);
  assert.equal(nextSlot(ONCE_FALLBACK, Date.now(), Date.now()), undefined);
  assert.deepEqual(previewSlots(ONCE_FALLBACK, Date.now()), []);
  assert.deepEqual(decodeOnceTrigger(stored), { trigger, changed: false });
});
test('an older engine changing any revision cannot silently rearm a once reservation', () => {
  const stored = encodeOnceTrigger(trigger);
  for (const change of [{ revision: 2, enabled: true }, { revision: 2, enabled: false }, { enabled: true }]) {
    const decoded = decodeOnceTrigger({ ...stored, ...change });
    assert.equal((decoded.trigger as Trigger).enabled, false);
    assert.equal((decoded.trigger as Trigger).source.schedule.type, 'once');
    assert.equal(decoded.changed, true);
  }
  const edited = decodeOnceTrigger({ ...stored, source: { kind: 'schedule', schedule: { type: 'interval', everySeconds: 3600 }, catchUp: 'latest' } });
  assert.equal((edited.trigger as Trigger).source.schedule.type, 'interval');
  assert.equal('onceSchedule' in (edited.trigger as Trigger), false);
});
test('one absolute reservation previews once even across years and polling sources refuse it', () => {
  const schedule = { type: 'once', at: '2027-10-03T00:00:00.000Z' } as const;
  assert.deepEqual(previewSlots(schedule, Date.parse('2026-10-03T00:00:00Z')), [schedule.at]);
  assert.equal(nextSlot(schedule, Date.parse(schedule.at), 0), undefined);
  assert.equal(TriggerInputSchema.safeParse({ ...trigger, id: undefined }).success, false, 'runtime metadata is not create input');
  assert.equal(RepeatingScheduleSchema.safeParse(schedule).success, false);
});
