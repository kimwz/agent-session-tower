import type { Trigger, TriggerEvent } from '../../shared/triggers.js';
import { evaluate, type HttpOutcome } from './http.js';

const MAX_PAYLOAD_BODY = 16_000;
/** The line an open-issues run ends its report with to keep its issue open. */
export const KEEP_OPEN = 'TOWER_KEEP_ISSUE_OPEN';
/** Whether a report ends with the line asking Tower to keep its issue open; a mention elsewhere does not count. */
export function asksToKeepOpen(output: string): boolean {
  return output.trimEnd().split('\n').at(-1)?.trim() === KEEP_OPEN;
}
/** The issue an open-issues event is about, as the check recorded it. */
export function issueRef(event: TriggerEvent): { repository: string; number: number } | undefined {
  const { repository, number } = event.input.issue ?? {};
  return typeof repository === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository) && Number.isInteger(number) ? { repository, number: number! } : undefined;
}
/** JSON for a prompt, cut to `max` characters with a visible mark. */
export function excerpt(value: unknown, max: number): string {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length <= max ? text : `${text.slice(0, max)}\n… [${text.length - max} more characters cut]`;
}
/** At most `max` bytes of UTF-8, never splitting a character. */
export const cutBytes = (text: string, max: number): string => {
  const bytes = Buffer.from(text);
  return bytes.length <= max ? text : bytes.subarray(0, max).toString('utf8').replace(/\uFFFD+$/, '');
};
/** A selected value as it is, unless it is large. */
export const small = (value: unknown): unknown => Buffer.byteLength(JSON.stringify(value) ?? '') <= 4000 ? value : cutBytes(excerpt(value, 4000), 4000);

/** What a run keeps of the response that fired it. */
export function responsePayload(trigger: Trigger, outcome: Extract<HttpOutcome, { ok: true }>, selected?: unknown): unknown {
  const selection = selected !== undefined ? selected : trigger.source.kind === 'http' && trigger.source.condition.type !== 'every-success'
    ? evaluate(trigger.source.condition, outcome, undefined).selected : undefined;
  return { status: outcome.status, url: outcome.url, ...(outcome.contentType ? { contentType: outcome.contentType } : {}),
    ...(selection !== undefined ? { selected: small(selection) } : {}),
    body: cutBytes(outcome.body, MAX_PAYLOAD_BODY), ...(outcome.truncated || Buffer.byteLength(outcome.body) > MAX_PAYLOAD_BODY ? { truncated: true } : {}) };
}

/** A run's one-line summary of the response that fired it. */
export function responseSummary(outcome: Extract<HttpOutcome, { ok: true }>, selected: unknown): string {
  const value = selected === undefined ? '' : typeof selected === 'string' ? selected : JSON.stringify(selected) ?? '';
  return `HTTP ${outcome.status}${value ? ` · ${value.slice(0, 120)}` : ''}`;
}
