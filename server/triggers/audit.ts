import { randomUUID } from 'node:crypto';
import type { Trigger, TriggerActor, TriggerAuditEntry } from '../../shared/triggers.js';
import { MAX_AUDIT } from './limits.js';
import type { EngineState } from './state.js';
import { writeRows, removeRows } from './row-operations.js';

/** Adds an entry to the audit log, keeping the newest MAX_AUDIT. `now` is read once, for the entry's time. */
export function appendAudit(state: EngineState, now: () => number, entry: Omit<TriggerAuditEntry, 'id' | 'at'>): void {
  const next = { id: randomUUID(), at: new Date(now()).toISOString(), ...entry };
  removeRows(state,'audit',...state.audit.slice(0,Math.max(0,state.audit.length + 1 - MAX_AUDIT)).map(item => item.id));
  writeRows(state,'audit',next.id);
  state.audit = [...state.audit,next].slice(-MAX_AUDIT);
}

/** An entry about one trigger. */
export function logTrigger(state: EngineState, now: () => number, actor: TriggerActor, action: TriggerAuditEntry['action'], trigger: Trigger, fromRevision: number | undefined, toRevision: number | undefined, summary: string): void {
  appendAudit(state, now, { actor, action, triggerId: trigger.id, triggerName: trigger.name,
    ...(fromRevision !== undefined ? { fromRevision } : {}), ...(toRevision !== undefined ? { toRevision } : {}), summary: summary.slice(0, 500) });
}

/** A trigger in a few words: its name, what it calls and when. */
export function describeTrigger(trigger: Trigger): string {
  const schedule = trigger.source.schedule;
  const when = schedule.type === 'once' ? `once at ${schedule.at}` : schedule.type === 'cron' ? `${schedule.expression} ${schedule.timezone}` : `every ${schedule.everySeconds}s`;
  const request = trigger.source.kind === 'http' ? `${trigger.source.request.method} ${new URL(trigger.source.request.url).origin}, `
    : trigger.source.kind === 'github' ? `GitHub ${trigger.source.watch.type}${trigger.source.watch.repos?.length ? ` ${trigger.source.watch.repos.join(' ')}` : ''} as ${trigger.source.account}, ` : '';
  return `"${trigger.name}" (${request}${when})`;
}

/** Which parts of a definition changed. */
export function changedFields(before: Trigger, after: Trigger): string {
  const fields = (['name', 'enabled', 'source', 'handler', 'policy'] as const).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return fields.length ? fields.join(', ') : 'nothing';
}
