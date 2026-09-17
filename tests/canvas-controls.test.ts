import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarFilters } from '../client/src/sessions/SidebarFilters.js';
import { CanvasSettings } from '../client/src/graph/CanvasSettings.js';
import { getLanguage, setLanguage, translate } from '../client/src/i18n/i18n.js';

const originalLanguage = getLanguage();
test.afterEach(() => setLanguage(originalLanguage));
const filters = { onStatusChange() {}, onPeriodChange() {}, period: '1', total: 12, working: 2, completed: 7 };

test('sidebar major status buttons and period preserve their selected values in both languages', () => {
  for (const language of ['ko', 'en'] as const) {
    setLanguage(language);
    const markup = renderToStaticMarkup(createElement(SidebarFilters, { ...filters, status: 'working' }));
    assert.match(markup, /class="working selected" aria-pressed="true"/);
    assert.equal((markup.match(/aria-pressed="true"/g) || []).length, 1);
    assert.match(markup, language === 'en' ? />Working<\/span><b>2<\/b>/ : />작업 중<\/span><b>2<\/b>/);
    assert.match(markup, /<option value="1" selected="">/);
    assert.match(markup, /<option value="" disabled="" selected="">/);
    assert.match(markup, language === 'en' ? /Last 24 hours/ : /최근 24시간/);
  }
});

test('idle and error use the secondary status selector with no misleading major selection', () => {
  setLanguage('en');
  for (const status of ['idle', 'error'] as const) {
    const markup = renderToStaticMarkup(createElement(SidebarFilters, { ...filters, status, period: '30' }));
    assert.doesNotMatch(markup, /aria-pressed="true"/);
    assert.match(markup, new RegExp(`<option value="${status}" selected="">`));
    assert.match(markup, /<option value="30" selected="">/);
    assert.match(markup, /aria-label="Other session status"/);
  }
});

test('closed settings expose only the cog and keep all popup controls out of keyboard navigation', () => {
  setLanguage('en');
  const props = { manual: false, onLayoutChange() {}, motion: true, onMotionChange() {}, showHidden: false, onShowHiddenChange() {}, suspended: false };
  const markup = renderToStaticMarkup(createElement(CanvasSettings, props));
  assert.match(markup, /aria-label="Canvas settings"/);
  assert.match(markup, /aria-expanded="false" aria-controls="[^"]+"/);
  assert.equal((markup.match(/<button /g) || []).length, 1);
  assert.doesNotMatch(markup, /<input|<section|canvas-settings-popover/);
  const suspended = renderToStaticMarkup(createElement(CanvasSettings, { ...props, suspended: true }));
  assert.match(suspended, /aria-expanded="false"[^>]*disabled=""/);
  assert.doesNotMatch(suspended, /<input|<section/);
});

test('canvas summary and settings labels localize without changing counts', () => {
  setLanguage('ko');
  assert.equal(translate('{0} / {1}개 세션 표시 · {2}개 작업 중', { 0: 8, 1: 12, 2: 2 }), '8 / 12개 세션 표시 · 2개 작업 중');
  assert.equal(translate('연결선 애니메이션'), '연결선 애니메이션');
  setLanguage('en');
  assert.equal(translate('{0} / {1}개 세션 표시 · {2}개 작업 중', { 0: 8, 1: 12, 2: 2 }), 'Showing 8 / 12 sessions · 2 working');
  assert.equal(translate('연결선 애니메이션'), 'Animate connections');
});
