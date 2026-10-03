import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MasterSettingsView } from '../../client/src/master/MasterSettings.js';
import { getLanguage, setLanguage } from '../../client/src/i18n/i18n.js';
import { DEFAULT_MASTER_SETTINGS, type MasterOverview } from '../../shared/master.js';

const original = getLanguage();
test.afterEach(() => setLanguage(original));

const render = (change: Partial<MasterOverview> = {}) => renderToStaticMarkup(createElement(MasterSettingsView, { token: 't', onNewSession() {},
  overview: { available: true, version: 'x', settings: DEFAULT_MASTER_SETTINGS, voiceConfigured: false, activeTasks: 0, ...change } }));

test('followed work that could not be read is shown, in either language; an older host shows nothing', () => {
  setLanguage('ko');
  assert.doesNotMatch(render(), /role="alert"/);
  assert.match(render({ followState: 'moved-aside' }), /role="alert"[^>]*>마스터가 지켜보던 일의 기록을 읽지 못해 따로 옮겨 두고 새로 시작했습니다/);
  assert.match(render({ followState: 'not-saved' }), /role="alert"[^>]*>마스터가 지켜보던 일의 기록을 읽지 못해 그대로 두었습니다/);
  setLanguage('en');
  assert.match(render({ followState: 'moved-aside' }), /role="alert"[^>]*>The master’s record of followed work could not be read; it was moved aside and started over/);
  assert.match(render({ followState: 'not-saved' }), /role="alert"[^>]*>The master’s record of followed work could not be read and was left as it is/);
});
