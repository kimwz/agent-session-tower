import { z } from 'zod';
import { OnceScheduleSchema, type Trigger } from '../../shared/triggers.js';

// A previous engine must keep recurring definitions readable without ever scheduling an unknown reservation.
export const ONCE_FALLBACK = { type: 'cron', expression: '0 0 31 2 *', timezone: 'UTC' } as const;
const markerSchema = z.object({ at: OnceScheduleSchema.shape.at, enabled: z.boolean(), revision: z.number().int().positive() }).strict();

export function encodeOnceTrigger(trigger: Trigger): Trigger {
  if (trigger.source.kind !== 'schedule' || trigger.source.schedule.type !== 'once') return trigger;
  return { ...trigger, enabled: false, source: { ...trigger.source, schedule: ONCE_FALLBACK },
    onceSchedule: { at: trigger.source.schedule.at, enabled: trigger.enabled, revision: trigger.revision } } as Trigger;
}

export function decodeOnceTrigger(value: unknown): { trigger: unknown; changed: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { trigger: value, changed: false };
  const { onceSchedule, ...trigger } = value as Record<string, any>;
  if (onceSchedule === undefined) return { trigger: value, changed: false };
  const marker = markerSchema.safeParse(onceSchedule);
  const schedule = trigger.source?.schedule;
  if (!marker.success || trigger.source?.kind !== 'schedule' || schedule?.type !== 'cron'
    || schedule.expression !== ONCE_FALLBACK.expression || schedule.timezone !== ONCE_FALLBACK.timezone) return { trigger, changed: true };
  const unchanged = trigger.revision === marker.data.revision && trigger.enabled === false;
  return { trigger: { ...trigger, enabled: unchanged ? marker.data.enabled : false,
    source: { ...trigger.source, schedule: { type: 'once', at: marker.data.at } } }, changed: !unchanged };
}
