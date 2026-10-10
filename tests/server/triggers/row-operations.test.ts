import assert from 'node:assert/strict';
import test from 'node:test';
import type { Trigger, TriggerEvent } from '../../../shared/triggers.js';
import { appendAudit } from '../../../server/triggers/audit.js';
import { fire } from '../../../server/triggers/firing.js';
import { MAX_AUDIT } from '../../../server/triggers/limits.js';
import { beginRowOperations, empty, mergeRowOperations, pruneState, removeRows, writeRows } from '../../../server/triggers/state.js';
import { rowsOf, stateOf, type TriggerChange, type TriggerRow } from '../../../server/triggers/storage-codec.js';
import { mutationProjection, rowsForOperations } from '../../../server/triggers/store.js';

const now = () => Date.parse('2026-10-10T00:00:00Z');
const actor = { kind: 'owner' as const,via: 'ui' as const };
function event(id: string): TriggerEvent {
  return { id,triggerId: 'trigger',triggerName: 'fixture',triggerRevision: 1,kind: 'schedule',dedupKey: id,
    requestId: id,occurredAt: '2026-10-01T00:00:00Z',receivedAt: '2026-10-01T00:00:00Z',updatedAt: '2026-10-01T00:00:00Z',
    status: 'completed',summary: '',input: { instructions: 'fixture',provider: 'codex',approvals: 'auto',untrustedInput: false,
      overlap: 'skip',target: { node: 'local',mode: 'auto' } } };
}
function apply(rows: TriggerRow[], changes: TriggerChange[]): TriggerRow[] {
  const result = new Map(rows.map(row => [JSON.stringify([row.kind,row.id]),row]));
  for (const row of changes) {
    const key = JSON.stringify([row.kind,row.id]);
    if (row.remove) result.delete(key); else result.set(key,{ kind: row.kind,id: row.id,ordinal: row.ordinal,json: row.json });
  }
  return [...result.values()];
}

test('declared cursor mutation never reads or serializes unrelated collections or nested records', () => {
  const state = empty(); state.cursors.target = { anchorAt: 1 }; state.cursors.other = { anchorAt: 2 };
  const previous = rowsOf(state);
  Object.defineProperty(state.cursors.other,'observed',{ enumerable: true,get: () => assert.fail('unrelated cursor getter') });
  const draft = mutationProjection(state,{ type: 'cursor',id: 'target' }), operations = beginRowOperations(draft);
  assert.equal(draft.cursors.other,state.cursors.other,'only the writable cursor is cloned');
  Object.defineProperty(draft,'revisions',{ get: () => assert.fail('unrelated collection read') });
  draft.cursors.target.lastSlot = 42; writeRows(draft,'cursors','target');
  const changes = rowsForOperations(previous,draft,operations);
  assert.deepEqual(changes.map(row => [row.kind,row.id]),[['cursors','target']]);
  assert.equal(JSON.parse(changes[0].json).lastSlot,42);
});

test('explicit event deletion moves only its ordinal tail using immutable saved JSON', () => {
  const state = empty(); state.events = [event('first'),event('middle'),event('last')];
  const previous = rowsOf(state), operations = beginRowOperations(state);
  removeRows(state,'events','middle'); state.events.splice(1,1);
  Object.defineProperty(state.events[1],'input',{ enumerable: true,get: () => assert.fail('tail row serialized') });
  const changes = rowsForOperations(previous,state,operations);
  assert.deepEqual(changes.map(row => [row.id,row.ordinal,!!row.remove]),[['middle',1,true],['last',1,false]]);
  assert.equal(changes[1].json,previous.find(row => row.id === 'last')!.json);
  assert.deepEqual(stateOf(apply(previous,changes)).events.map(row => row.id),['first','last']);
});

test('prune explicitly returns removed IDs, positional replacement and event payload writes', () => {
  const state = empty(); state.events = Array.from({ length: 502 },(_,index) => event(`event-${index}`));
  state.events[501].payload = { status: 200,url: 'fixture',selected: 'x'.repeat(400) };
  state.cursors = { orphan: { anchorAt: 1 } }; state.secretGrants = { orphan: ['gone'] };
  state.fired = { expired: '2026-08-01T00:00:00Z',retained: '2026-10-01T00:00:00Z' };
  state.recentFires = [{ at: 1,triggerId: 'gone' },{ at: now(),triggerId: 'live' }];
  const previous = rowsOf(state), operations = beginRowOperations(state);
  const pruned = pruneState(state,now); mergeRowOperations(state,pruned);
  for (const [kind,id] of [['events','event-0'],['events','event-1'],['cursors','orphan'],['secretGrants','orphan'],['fired','expired'],['recentFires','1']] as const)
    assert.equal(pruned.rows.get(kind)!.get(id),'remove');
  const changes = rowsForOperations(previous,state,operations);
  assert.deepEqual(stateOf(apply(previous,changes)),state);
  assert.equal(changes.find(row => row.id === 'event-501')?.remove,undefined);
  assert.equal((state.events[499].payload as { trimmed: boolean }).trimmed,true);
});

test('audit producer names the new entry and eviction, retaining the ordered tail without reencoding it', () => {
  const state = empty();
  state.audit = Array.from({ length: MAX_AUDIT },(_,index) => ({ id: `audit-${index}`,at: '2026-10-01T00:00:00Z',actor,
    action: 'settings' as const,triggerId: '',triggerName: '',summary: 'fixture' }));
  const previous = rowsOf(state), operations = beginRowOperations(state);
  appendAudit(state,now,{ actor,action: 'settings',triggerId: '',triggerName: '',summary: 'new' });
  Object.defineProperty(state.audit[0],'summary',{ enumerable: true,get: () => assert.fail('retained audit serialized') });
  const changes = rowsForOperations(previous,state,operations);
  assert.equal(changes.find(row => row.id === 'audit-0')!.remove,true);
  const restored = stateOf(apply(previous,changes));
  assert.equal(restored.audit.length,MAX_AUDIT); assert.equal(restored.audit.at(-1)!.summary,'new');
  assert.equal(restored.audit[0].id,'audit-1');
});

test('once firing producer declares event, dedup, consumption, definition, cursor, revision and audit in one batch', () => {
  const state = empty();
  const trigger: Trigger = { id: 'trigger',name: 'once',enabled: true,revision: 1,createdAt: '2026-10-01T00:00:00Z',updatedAt: '2026-10-01T00:00:00Z',createdBy: actor,updatedBy: actor,
    source: { kind: 'schedule',schedule: { type: 'once',at: '2026-12-01T00:00:00Z' },catchUp: 'latest' },
    handler: { kind: 'task',provider: 'codex',instructions: 'fixture',approvals: 'auto',target: { node: 'local',mode: 'auto' } },policy: { overlap: 'skip',maxEventsPerHour: 20 } };
  state.triggers = [trigger]; state.cursors.trigger = { anchorAt: now(),nextAt: now() + 1 };
  const previous = rowsOf(state), operations = beginRowOperations(state);
  const fired = fire(state,trigger,'fixed-slot',now(),'manual',now,actor).event!;
  const changes = rowsForOperations(previous,state,operations), restored = stateOf(apply(previous,changes));
  assert.deepEqual(restored,state); assert.equal(restored.onceConsumed.trigger.eventId,fired.id);
  assert.deepEqual(new Set(changes.map(row => row.kind)),new Set(['events','fired','recentFires','onceConsumed','triggers','revisions','cursors','audit']));
  assert.equal(restored.events[0].requestId,fired.requestId);
  assert.equal(fire(state,trigger,'fixed-slot',now(),'manual',now,actor).event,undefined,'consumption prevents replay');
});

test('a recurring firing appends the known recent index without serializing retained recent entries', () => {
  const state = empty();
  const trigger: Trigger = { id: 'repeat',name: 'repeat',enabled: true,revision: 1,createdAt: '2026-10-01T00:00:00Z',updatedAt: '2026-10-01T00:00:00Z',createdBy: actor,updatedBy: actor,
    source: { kind: 'schedule',schedule: { type: 'interval',everySeconds: 3600 },catchUp: 'latest' },
    handler: { kind: 'task',provider: 'codex',instructions: 'fixture',approvals: 'auto',target: { node: 'local',mode: 'auto' } },policy: { overlap: 'skip',maxEventsPerHour: 20 } };
  state.triggers = [trigger]; state.recentFires = [{ at: now() - 1,triggerId: trigger.id }];
  const previous = rowsOf(state), operations = beginRowOperations(state);
  Object.defineProperty(state.recentFires[0],'toJSON',{ value: () => assert.fail('retained recent firing serialized') });
  fire(state,trigger,'new-slot',now(),'schedule',now);
  const changes = rowsForOperations(previous,state,operations);
  assert.deepEqual(changes.filter(row => row.kind === 'recentFires').map(row => row.id),['1']);
  assert.deepEqual(stateOf(apply(previous,changes)).recentFires,[{ at: now() - 1,triggerId: trigger.id },{ at: now(),triggerId: trigger.id }]);
});
