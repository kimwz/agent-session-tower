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

test('heartbeat settings expose the 30-minute default and separate internal no-op from action audit', () => {
  setLanguage('ko');
  const html = render({ heartbeat: { nextDueAt: '2026-10-08T13:00:00Z', lastCheck: { id: 'check-noop', at: '2026-10-08T12:30:00Z', state: 'noop', taskIds: ['task-a'] }, actions: [] } });
  assert.match(html, /heartbeat 활성화/);
  assert.match(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /min="1" max="1440" step="1" value="30"/);
  assert.match(html, /점검 지시 프롬프트/);
  assert.match(html.replace(/<[^>]*>/g, ''), /최근 내부 점검: 조치 없음/);
  assert.match(html, /실제 조치 감사 기록/);
  assert.match(html, /master\.heartbeat/);
  const action = render({ heartbeat: { actions: [{ checkId: 'check-action', at: '2026-10-08T12:30:00Z', taskIds: ['task-a'], cause: 'Repeated review', evidence: 'same result twice', recommendation: 'Use existing hosted CI', delivery: 'sent', runId: 'run-action' }] } });
  for (const text of ['Repeated review', 'same result twice', 'Use existing hosted CI', 'run-action', 'task-a']) assert.ok(action.includes(text));
  const broken = render({ heartbeat: { actions: [], problem: 'Heartbeat 기록을 읽지 못했습니다. 교정 기록을 읽지 못해 교정 조치를 중지했습니다.' } });
  assert.match(broken, /role="alert"[^>]*>Heartbeat 기록을 읽지 못했습니다\. 교정 기록을 읽지 못해/);
});

test('the reading models are offered with Eleven v4 Turbo first and chosen by default, in either language', () => {
  setLanguage('ko');
  const options = [...render().matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(options, [['eleven_v4_turbo', 'v4 터보 (빠름, 추천)'], ['eleven_v3_conversational', 'v3 대화형 (빠름)'], ['eleven_v3', 'v3 (표현력, 느림, 두 배 비쌈)'], ['eleven_flash_v2_5', 'flash v2.5 (가장 빠름, 밝은 말투 없음)']]);
  assert.match(render(), /<option value="eleven_v4_turbo" selected="">/);
  setLanguage('en');
  assert.match(render(), /<option value="eleven_v4_turbo" selected="">v4 Turbo \(fast, recommended\)<\/option>/);
});
