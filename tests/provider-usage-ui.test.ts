import test from 'node:test';
import assert from 'node:assert/strict';
import { usagePercent, usageUnavailableReason, usageWindowLabel, usageWindows } from '../client/src/providers/provider-usage.js';
import { clearHostPosition, HOST_HEIGHT } from '../client/src/graph/graph-layout.js';
import { setLanguage } from '../client/src/i18n/i18n.js';
import type { ProviderUsage } from '../shared/types.js';

const window = { id: 'primary', usedPercent: 42, windowMinutes: 10080 };

test('provider usage derives weekly-only labels from duration and never reports unavailable data as zero usage', () => {
  setLanguage('en');
  assert.equal(usageWindowLabel(window), 'Weekly');
  assert.equal(usageWindowLabel({ ...window, windowMinutes: 300 }), '5 hours');
  assert.equal(usageWindowLabel({ ...window, id: 'seven_day_sonnet' }), 'Weekly · Sonnet');
  assert.deepEqual(usageWindows({ status: 'unavailable', windows: [window], reason: 'not_supported' }), []);
  assert.deepEqual(usageWindows(), []);
  assert.deepEqual(usageWindows({ status: 'available', windows: [{ ...window, usedPercent: 0 }] }).map(item => item.usedPercent), [0]);
  assert.match(usageUnavailableReason({ status: 'unavailable', windows: [], reason: 'not_signed_in' }), /Sign in/);
  setLanguage('ko');
  assert.equal(usageWindowLabel(window), '주간');
  assert.match(usageUnavailableReason({ status: 'loading', windows: [] }), /확인 중/);
});

test('stale usage retains the last valid windows while invalid values stay absent', () => {
  const usage: ProviderUsage = { status: 'error', stale: true, windows: [window, { ...window, id: 'five_hour', windowMinutes: 300, usedPercent: 64.4 }, { ...window, usedPercent: NaN }, { ...window, usedPercent: -1 }] };
  assert.deepEqual(usageWindows(usage).map(window => window.id), ['five_hour', 'primary']);
  assert.equal(usagePercent(64.4), '64%');
  assert.equal(usagePercent(0), '0%');
  assert.deepEqual(usageWindows({ ...usage, stale: false }), []);
});

test('adding host usage clears saved project frames without rewriting manual positions', () => {
  const savedHost = { x: 128, y: 0 };
  const frame = { position: { x: 0, y: 100 }, width: 600, height: 350 };
  const original = structuredClone(frame);
  const placed = clearHostPosition(savedHost, [frame]);
  assert.ok(placed.y + HOST_HEIGHT < frame.position.y);
  assert.deepEqual(savedHost, { x: 128, y: 0 });
  assert.deepEqual(frame, original);
  assert.deepEqual(clearHostPosition(savedHost, [{ ...frame, position: { x: 900, y: 100 } }]), savedHost);
  assert.deepEqual(clearHostPosition(savedHost, [{ ...frame, position: { x: 0, y: 185 } }]), savedHost);
  const stacked = clearHostPosition(savedHost, [frame, { ...frame, position: { x: 0, y: -300 } }]);
  assert.ok(stacked.y + HOST_HEIGHT < -300);
});
