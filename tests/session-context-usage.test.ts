import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionContextUsage } from '../shared/types.js';
import { SessionContextIcon } from '../client/src/SessionContextIcon.js';
import { contextUsageLabel, contextUsageMeter } from '../client/src/session-context-usage.js';
import { getLanguage, setLanguage } from '../client/src/i18n.js';

const originalLanguage = getLanguage();
test.afterEach(() => setLanguage(originalLanguage));

test('context colors change strictly above 30, 50 and 75 percent', () => {
  for (const [percent, tone] of [[0, 'low'], [30, 'low'], [30.001, 'medium'], [50, 'medium'], [50.001, 'high'], [75, 'high'], [75.001, 'critical'], [100, 'critical']] as const) {
    assert.deepEqual(contextUsageMeter({ usedTokens: 1, usedPercent: percent }), { percent, arc: percent, tone });
  }
});

test('over-capacity values fill one ring while retaining the actual percentage', () => {
  const usage = { usedTokens: 140_000, contextWindow: 100_000, usedPercent: 140 };
  assert.deepEqual(contextUsageMeter(usage), { percent: 140, arc: 100, tone: 'critical' });
  setLanguage('en');
  assert.equal(contextUsageLabel(usage), 'Context used: 140% · 140,000 / 100,000 tokens');
});

test('missing and invalid percentages stay unknown; observed zero remains known', () => {
  const inputs = [undefined, { usedTokens: 100 }, { usedTokens: 100, contextWindow: 1000 }, ...[NaN, Infinity, -Infinity, -1].map(usedPercent => ({ usedTokens: 100, usedPercent }))];
  for (const usage of inputs) assert.deepEqual(contextUsageMeter(usage), { arc: 0, tone: 'unknown' });
  for (const usedPercent of ['30', null]) assert.deepEqual(contextUsageMeter({ usedTokens: 100, usedPercent } as unknown as SessionContextUsage), { arc: 0, tone: 'unknown' });
  assert.deepEqual(contextUsageMeter({ usedTokens: 0, usedPercent: 0 }), { percent: 0, arc: 0, tone: 'low' });
});

test('context tooltips localize percentages and available token counts without inventing capacity', () => {
  const usage = { usedTokens: 30_000, contextWindow: 100_000, usedPercent: 30 };
  setLanguage('ko');
  assert.equal(contextUsageLabel(usage), '컨텍스트 사용량: 30% · 30,000 / 100,000 토큰');
  assert.equal(contextUsageLabel({ usedTokens: 1234 }), '컨텍스트 사용량: 알 수 없음 · 사용한 토큰: 1,234');
  setLanguage('en');
  assert.equal(contextUsageLabel(usage), 'Context used: 30% · 30,000 / 100,000 tokens');
  assert.equal(contextUsageLabel({ usedTokens: 1234 }), 'Context usage unavailable · Tokens used: 1,234');
  assert.equal(contextUsageLabel({ usedTokens: 0, usedPercent: 0 }), 'Context used: 0% · Tokens used: 0');
  assert.equal(contextUsageLabel({ usedTokens: NaN, contextWindow: -100 }), 'Context usage unavailable');
  assert.equal(contextUsageLabel({ usedTokens: NaN, contextWindow: 100_000 }), 'Context usage unavailable · Context window: 100,000 tokens');
});

test('rendered context meters expose a description and keep the colored ring outside the provider face', () => {
  setLanguage('en');
  const known = renderToStaticMarkup(createElement(SessionContextIcon, { provider: 'codex', usage: { usedTokens: 90_000, usedPercent: 90 }, descriptionId: 'context-known' }));
  assert.match(known, /title="Context used: 90% · Tokens used: 90,000"/);
  assert.match(known, /<span class="agent-orb codex">[\s\S]+<\/span><svg class="session-context-ring critical"/);
  assert.match(known, /stroke-dasharray="90 100"/);
  assert.match(known, /id="context-known" class="sr-only">Context used: 90%/);
  const over = renderToStaticMarkup(createElement(SessionContextIcon, { provider: 'claude', usage: { usedTokens: 140, usedPercent: 140 }, descriptionId: 'context-over' }));
  assert.match(over, /stroke-dasharray="100 100"/);
  const unknown = renderToStaticMarkup(createElement(SessionContextIcon, { provider: 'claude', descriptionId: 'context-unknown' }));
  assert.match(unknown, /session-context-ring unknown/);
  assert.match(unknown, /Context usage unavailable/);
  assert.doesNotMatch(unknown, /session-context-fill|0%/);
  const zero = renderToStaticMarkup(createElement(SessionContextIcon, { provider: 'claude', usage: { usedTokens: 0, usedPercent: 0 }, descriptionId: 'context-zero' }));
  assert.match(zero, /session-context-ring low/);
  assert.match(zero, /Context used: 0%/);
  assert.doesNotMatch(zero, /session-context-fill|unavailable/);
});
