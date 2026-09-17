import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderUsage, ProviderUsageMeter } from '../client/src/providers/ProviderUsage.js';
import type { ProviderHealth } from '../shared/types.js';

const health = (patch: Partial<ProviderHealth> = {}): ProviderHealth => ({ provider: 'claude', available: true, sessionCount: 2, ...patch });
const meter = (patch: Partial<ProviderHealth> = {}) =>
  renderToStaticMarkup(createElement(ProviderUsageMeter, { provider: 'claude', health: health(patch) }));

test('the meter shows the five-hour limit as the headline number', () => {
  // A shorter window is listed first on purpose: the five-hour limit is still the one users plan around.
  const markup = meter({ usage: { status: 'available', windows: [{ id: 'hourly', usedPercent: 4, windowMinutes: 60 }, { id: 'seven_day', usedPercent: 12, windowMinutes: 10080 }, { id: 'five_hour', usedPercent: 41.4, windowMinutes: 300 }] } });
  assert.match(markup, /<strong>41%<\/strong><small>Claude · 5시간<\/small>/);
  assert.match(markup, /aria-label="Claude Code 계정 사용량: 41% 5시간 사용"/);
  assert.match(markup, /class="usage-fill"[^>]*stroke-dasharray="41.4 100"/);
});

test('an account without usage data reports that instead of showing zero', () => {
  const markup = meter({ usage: { status: 'unavailable', windows: [], reason: 'not_signed_in' } });
  assert.match(markup, /<strong>—<\/strong><small>Claude · 정보 없음<\/small>/);
  assert.doesNotMatch(markup, /usage-fill/);
  assert.match(meter(), /aria-label="Claude Code 계정 사용량: 정보 없음"/);
});

test('usage kept from an earlier check is marked as no longer current', () => {
  const markup = meter({ usage: { status: 'error', stale: true, windows: [{ id: 'five_hour', usedPercent: 30, windowMinutes: 300 }] } });
  assert.match(markup, /class="provider-usage-meter claude stale/);
  assert.match(markup, /<strong>30%<i aria-hidden="true">\*<\/i><\/strong>/);
  assert.match(markup, / · 이전 정보"/);
});

test('the usage details stay closed until the meter is opened', () => {
  const markup = meter({ usage: { status: 'available', windows: [{ id: 'five_hour', usedPercent: 30, windowMinutes: 300 }] } });
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /role="tooltip"/);
  assert.doesNotMatch(markup, /모든 기기에서 공유하는 계정 한도입니다/);
});

test('both local agents are always offered a usage ring under one shared-account label', () => {
  const markup = renderToStaticMarkup(createElement(ProviderUsage, { providers: [health()] }));
  assert.match(markup, /class="provider-usage" aria-label="계정 사용량 · 모든 기기"/);
  assert.match(markup, /provider-usage-meter claude/);
  assert.match(markup, /provider-usage-meter codex/);
  assert.match(markup, /class="provider-usage-scope">계정 사용량 · 모든 기기</);
});
