import { createHash, randomUUID } from 'node:crypto';
import { carriesOutsideContent, type Trigger, type TriggerActor, type TriggerEvent, type TriggerPolicy } from '../../shared/triggers.js';
import { consumeOnce } from './once.js';
import { writeRows, recordIndexedReplacement, UNFINISHED, type EngineState } from './state.js';

const MAX_FIRED_PER_TRIGGER = 20_000;
const MAX_WAITING_PER_TRIGGER = 5;

/** Deterministic, so a retried claim for the same slot is recognized by the run registry. */
export function triggerRequestId(triggerId: string, dedupKey: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['trigger', triggerId, dedupKey])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Records one firing on the state being committed. Overlap and hourly limits decide whether it waits, joins or is
 * skipped; a once reservation is consumed in the same change. `by` is who asked for a run now: one asked for from a
 * controlling computer counts as started there. Answers the event, or, when the trigger cannot record more runs, the
 * capacity warning its caller notes in the same commit.
 */
export function fire(state: EngineState, trigger: Trigger, dedupKey: string, at: number, kind: TriggerEvent['kind'], now: () => number, by?: TriggerActor, overlapOverride?: TriggerPolicy['overlap']): { event?: TriggerEvent; capacity?: string } {
  const key = `${trigger.id} ${dedupKey}`;
  if (trigger.source.schedule.type === 'once' && state.onceConsumed[trigger.id]) return {};
  if (state.fired[key]) {
    if (trigger.source.schedule.type === 'once') consumeOnce(state, trigger, state.events.find(event => event.triggerId === trigger.id && event.dedupKey === dedupKey)?.id, now);
    return {};
  }
  const time = now();
  const iso = new Date(time).toISOString();
  // Checked before anything is stored: a trigger at its record limit adds nothing more.
  if (Object.keys(state.fired).filter(item => item.startsWith(`${trigger.id} `)).length >= MAX_FIRED_PER_TRIGGER) {
    return { capacity: `"${trigger.name}" has ${MAX_FIRED_PER_TRIGGER} runs recorded in the last 30 days; new runs are not accepted until older ones expire.` };
  }
  writeRows(state,'fired',key);
  state.fired[key] = iso;
  const previousRecentLength = state.recentFires.length;
  const firstExpired = state.recentFires.findIndex(item => item.at <= time - 60 * 60 * 1000);
  state.recentFires = [...state.recentFires.filter(item => item.at > time - 60 * 60 * 1000), { at: time, triggerId: trigger.id }];
  recordIndexedReplacement(state,'recentFires',previousRecentLength,firstExpired === -1 ? previousRecentLength : firstExpired);
  const handler = trigger.handler;
  const untrustedInput = carriesOutsideContent(trigger.source);
  const remote = by?.controllerId ? { controllerId: by.controllerId } : trigger.remoteEdited;
  // Open issues decide their own overlap from how many may be worked on at once.
  const overlap = overlapOverride ?? trigger.policy.overlap;
  const watch = trigger.source.kind === 'github' ? trigger.source.watch : undefined;
  const issue = trigger.source.kind === 'github' && watch?.type === 'issues'
    ? { issue: { account: trigger.source.account, assign: watch.assign, close: watch.close && handler.kind === 'task' } } : {};
  // What runs is frozen with the event: a task's instructions and target, or a coordinator's rules.
  const input: TriggerEvent['input'] = handler.kind === 'task'
    ? { instructions: handler.instructions, provider: handler.provider, ...(handler.model ? { model: handler.model } : {}), ...(handler.effort ? { effort: handler.effort } : {}),
      approvals: handler.approvals, target: handler.target, untrustedInput, overlap, ...(remote ? { remote: { controllerId: remote.controllerId } } : {}), ...issue }
    : { instructions: '', provider: handler.rules[0].provider, approvals: handler.approvals, target: { node: 'local', mode: 'auto' }, untrustedInput, overlap, ...issue,
      handler: 'coordinator', rules: structuredClone(handler.rules),
      ...(trigger.source.kind === 'github' && trigger.source.watch.type === 'review-requested' ? { review: { verdicts: trigger.source.watch.verdicts } } : {}) };
  const event: TriggerEvent = { id: randomUUID(), triggerId: trigger.id, triggerName: trigger.name, triggerRevision: trigger.revision, kind, dedupKey,
    occurredAt: new Date(at).toISOString(), receivedAt: iso, updatedAt: iso, status: 'queued', requestId: triggerRequestId(trigger.id, dedupKey),
    input,
    summary: kind === 'manual' ? 'Run now' : `Scheduled for ${new Date(at).toISOString()}` };
  // The firing just recorded counts too, so the limit is the number that may run in any hour.
  const recent = state.recentFires.slice(0, -1);
  const unfinished = state.events.filter(item => item.triggerId === trigger.id && UNFINISHED.has(item.status));
  if (recent.filter(item => item.triggerId === trigger.id).length >= trigger.policy.maxEventsPerHour) {
    event.status = 'skipped';
    event.reason = `Paused: more than ${trigger.policy.maxEventsPerHour} runs in an hour. Turn the trigger on again to resume.`;
    writeRows(state,'cursors',trigger.id);
    state.cursors[trigger.id] = { ...(state.cursors[trigger.id] ?? { anchorAt: time }), paused: { reason: event.reason, at: iso } };
  } else if (recent.length >= state.settings.maxEventsPerHour) {
    event.status = 'skipped'; event.reason = `Skipped: all triggers together reached ${state.settings.maxEventsPerHour} runs in an hour.`;
  } else if (unfinished.length && overlap === 'skip') {
    event.status = 'skipped'; event.reason = 'Skipped: the previous run of this trigger is still working.';
  } else if (unfinished.some(item => item.status === 'queued') && overlap === 'queue') {
    event.status = 'coalesced'; event.reason = 'Joined the run already waiting for the previous one to finish.';
  } else if (unfinished.filter(item => item.status === 'queued').length >= MAX_WAITING_PER_TRIGGER) {
    event.status = 'skipped'; event.reason = `Skipped: ${MAX_WAITING_PER_TRIGGER} runs of this trigger are already waiting.`;
  } else if (state.events.filter(item => item.status === 'queued').length >= 50) {
    event.status = 'skipped'; event.reason = 'Skipped: 50 trigger runs are already waiting.';
  }
  state.events.push(event); writeRows(state,'events',event.id);
  if (trigger.source.schedule.type === 'once') {
    if (event.status === 'skipped') event.reason = `${event.reason ?? 'Skipped.'} This once reservation is consumed; create a new reservation to retry.`;
    consumeOnce(state, trigger, event.id, now);
  }
  return { event };
}
