import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { blankGitHubSource, blankHttpSource, blankTrigger, eventStatusLabel, scheduleLabel, TriggerButton } from '../../../client/src/triggers/TriggerPanel.js';
import { setLanguage, translate } from '../../../client/src/i18n/i18n.js';
import { TriggerInputSchema } from '../../../shared/triggers.js';

test('a new scheduled run from the panel is exactly what the server accepts once named and instructed', () => {
  const input = blankTrigger();
  assert.equal(TriggerInputSchema.safeParse(input).success, false, 'an unnamed trigger is refused');
  const parsed = TriggerInputSchema.parse({ ...input, name: 'Weekday standup notes', handler: { ...input.handler, instructions: 'Summarize yesterday’s merged PRs' } });
  assert.equal(parsed.handler.approvals, 'auto', 'unattended runs approve automatically unless the owner chooses otherwise');
  assert.equal(parsed.source.kind, 'schedule');
});

test('a new HTTP trigger from the panel is accepted once it has a URL, and starts from the first response', () => {
  const input = { ...blankTrigger(), name: 'Status page', source: blankHttpSource(), handler: { ...blankTrigger().handler, instructions: 'Investigate' } };
  assert.equal(TriggerInputSchema.safeParse(input).success, false, 'a request needs a URL');
  const parsed = TriggerInputSchema.parse({ ...input, source: { ...input.source, request: { ...input.source.request, url: 'https://status.example.com/api' } } });
  assert.equal(parsed.source.kind === 'http' && parsed.source.condition.type, 'changed');
  assert.equal(parsed.source.schedule.type === 'interval' && parsed.source.schedule.everySeconds, 300);
  setLanguage('en');
  assert.equal(scheduleLabel(parsed, (key, values) => translate(key, values)), 'GET status.example.com · Every 5 min');
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

test('a new GitHub trigger from the panel needs repositories and a checked account before the server accepts it', () => {
  const base = { ...blankTrigger(), name: 'Issues', source: blankGitHubSource(), handler: { ...blankTrigger().handler, instructions: 'Triage it' } };
  assert.equal(TriggerInputSchema.safeParse(base).success, false);
  const source = blankGitHubSource();
  const ready = { ...base, source: { ...source, account: 'octocat', watch: { ...source.watch, repos: ['octo/app', 'octo/lib'] } } };
  const parsed = TriggerInputSchema.parse(ready);
  assert.equal(parsed.source.kind === 'github' && parsed.source.watch.type === 'issue-opened' && JSON.stringify(parsed.source.watch.authorAssociation), '["OWNER","MEMBER","COLLABORATOR"]');
  setLanguage('en');
  assert.equal(scheduleLabel(parsed, (key, values) => translate(key, values)), 'GitHub · New issues · octo/app +1 · Every 5 min');
});

