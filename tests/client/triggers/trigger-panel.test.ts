import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { blankTrigger, eventStatusLabel, scheduleLabel, TriggerButton } from '../../../client/src/triggers/TriggerPanel.js';
import { setLanguage, translate } from '../../../client/src/i18n/i18n.js';
import { TriggerInputSchema } from '../../../shared/triggers.js';

test('a new scheduled run from the panel is exactly what the server accepts once named and instructed', () => {
  const input = blankTrigger();
  assert.equal(TriggerInputSchema.safeParse(input).success, false, 'an unnamed trigger is refused');
  const parsed = TriggerInputSchema.parse({ ...input, name: 'Weekday standup notes', handler: { ...input.handler, instructions: 'Summarize yesterday’s merged PRs' } });
  assert.equal(parsed.handler.approvals, 'auto', 'unattended runs approve automatically unless the owner chooses otherwise');
  assert.equal(parsed.source.kind, 'schedule');
});

test('schedules and run states read naturally in both languages', () => {
  for (const language of ['ko', 'en'] as const) {
    setLanguage(language);
    const t = (key: string, values?: Record<string, string | number>) => translate(key, values);
    assert.equal(scheduleLabel({ source: { kind: 'schedule', schedule: { type: 'interval', everySeconds: 7200 }, catchUp: 'skip' } }, t), language === 'en' ? 'Every 2 h' : '2시간마다');
    assert.equal(scheduleLabel({ source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Seoul' }, catchUp: 'latest' } }, t), '0 9 * * 1-5 · Asia/Seoul');
    assert.equal(eventStatusLabel('uncertain', t), language === 'en' ? 'Uncertain' : '확인 불가');
  }
});

test('the header trigger button marks runs that need attention', () => {
  const markup = (status: 'completed' | 'error') => renderToStaticMarkup(createElement(TriggerButton, { token: 't', providers: [], projects: [], sessions: [],
    overview: { recent: [], triggers: [{ id: 'a', name: 'Nightly', enabled: true, kind: 'schedule', revision: 1, updatedAt: '', updatedBy: { kind: 'owner', via: 'ui' }, lastEvent: { id: 'e', status, occurredAt: '' } }] } }));
  assert.doesNotMatch(markup('completed'), /attention/);
  assert.match(markup('error'), /attention/);
});
