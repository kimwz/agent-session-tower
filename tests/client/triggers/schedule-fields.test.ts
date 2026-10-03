import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TriggerEditor } from '../../../client/src/triggers/TriggerEditor.js';
import { blankGitHubSource, blankHttpSource, blankTrigger, browserZone, type Source, type SourceKind } from '../../../client/src/triggers/trigger-helpers.js';
import { INTERVAL_MAX_SECONDS, INTERVAL_MIN_SECONDS, RepeatingScheduleSchema, ScheduleSchema } from '../../../shared/triggers.js';

type Schedule = Source['schedule'];
type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const editorProps = (kind: SourceKind) => ({ kind, token: '', providers: [], projects: [] as [string, string][], sessions: [], busy: false, onCancel() {}, onSave() {} });

/** The first element in a rendered tree that matches. */
function find(node: unknown, match: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found; } return undefined; }
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const element = node as Element;
  return match(element) ? element : find(element.props.children, match);
}

/** The schedule fields of an editor of `kind`: what they emit, their method choice and their interval input. Call the handlers only after rendering. */
function probe(kind: SourceKind, schedule?: Schedule) {
  const got: Schedule[] = [];
  const found: { choice?: Element; number?: Element } = {};
  function Probe() {
    const fields = find(TriggerEditor(editorProps(kind)), element => (element.type as { name?: string }).name === 'ScheduleFields');
    assert.ok(fields, 'the editor renders ScheduleFields');
    const rendered = (fields.type as (props: unknown) => ReactNode)({ ...fields.props, ...(schedule ? { schedule } : {}), onChange: (next: Schedule) => got.push(next) });
    found.choice = find(rendered, element => (element.type as { name?: string }).name === 'Choice');
    found.number = find(rendered, element => element.type === 'input' && element.props.type === 'number');
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.ok(found.choice, 'the schedule fields offer a Choice of method');
  const choice = found.choice.props as { options: Array<[string, string]>; onChange: (type: string) => void };
  return { got, number: found.number?.props, options: choice.options.map(([option]) => option), choose: (type: string) => { choice.onChange(type); return got.at(-1); } };
}

test('the interval field offers 1 to 44640 minutes and shows whole minutes', () => {
  const markup = renderToStaticMarkup(createElement(TriggerEditor, editorProps('http')));
  assert.match(markup, /<input type="number" required="" min="1" max="44640" value="5"\/>/);
  const { number } = probe('schedule', { type: 'interval', everySeconds: 90 });
  assert.ok(number);
  assert.equal(number.value, 2);
  assert.equal(number.min, 1);
  assert.equal(number.max, 44640);
});

test('switching a scheduled run to an interval starts at one hour', () => {
  const fields = probe('schedule');
  assert.deepEqual(fields.choose('interval'), { type: 'interval', everySeconds: 3600 });
  assert.deepEqual(fields.choose('cron'), { type: 'cron', expression: '0 9 * * 1-5', timezone: browserZone() });
});

test('switching an HTTP or GitHub check to an interval starts at five minutes', () => {
  for (const kind of ['http', 'github'] as const) {
    const fields = probe(kind);
    assert.deepEqual(fields.choose('interval'), { type: 'interval', everySeconds: 300 }, kind);
    assert.deepEqual(fields.choose('cron'), { type: 'cron', expression: '*/15 9-18 * * 1-5', timezone: browserZone() }, kind);
  }
});

test('typed intervals are normalised to whole seconds of at least a minute', () => {
  const { number, got } = probe('schedule', { type: 'interval', everySeconds: 3600 });
  assert.ok(number);
  const onChange = number.onChange as (event: { target: { value: string } }) => void;
  for (const value of ['0', '', 'abc', '-3', '5', '2.5', '44640', '50000']) onChange({ target: { value } });
  assert.deepEqual(got.map(schedule => schedule.type === 'interval' && schedule.everySeconds), [60, 60, 60, 60, 300, 150, 2678400, 3000000], 'over the maximum is left for the server to refuse');
});

test('the server accepts one minute to 31 days and nothing outside', () => {
  for (const schema of [RepeatingScheduleSchema, ScheduleSchema]) {
    for (const everySeconds of [60, 2678400]) assert.equal(schema.safeParse({ type: 'interval', everySeconds }).success, true, String(everySeconds));
    for (const everySeconds of [59, 2678401, 90.5]) assert.equal(schema.safeParse({ type: 'interval', everySeconds }).success, false, String(everySeconds));
  }
});

test('new HTTP and GitHub checks start every 5 minutes', () => {
  assert.deepEqual(blankHttpSource().schedule, { type: 'interval', everySeconds: 300 });
  assert.deepEqual(blankGitHubSource().schedule, { type: 'interval', everySeconds: 300 });
  const { source } = blankTrigger();
  assert.equal(source.kind === 'schedule' && source.schedule.type, 'cron');
});

test('a scheduled run offers once, cron and interval, and once starts an hour ahead', t => {
  assert.deepEqual(probe('http').options, ['interval', 'cron']);
  const fields = probe('schedule');
  assert.deepEqual(fields.options, ['once', 'cron', 'interval']);
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  assert.deepEqual(fields.choose('once'), { type: 'once', at: new Date(now + 3600000).toISOString() });
});

test('the editor\'s limits are the schema\'s', () => {
  assert.equal(INTERVAL_MIN_SECONDS / 60, 1);
  assert.equal(INTERVAL_MAX_SECONDS / 60, 44640);
  const accepts = (everySeconds: number) => RepeatingScheduleSchema.safeParse({ type: 'interval', everySeconds }).success;
  assert.deepEqual([accepts(INTERVAL_MIN_SECONDS - 1), accepts(INTERVAL_MIN_SECONDS), accepts(INTERVAL_MAX_SECONDS), accepts(INTERVAL_MAX_SECONDS + 1)], [false, true, true, false]);
});
