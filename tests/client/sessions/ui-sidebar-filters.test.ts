import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarFilters } from '../../../client/src/sessions/SidebarFilters.js';

const render = (ready: boolean) => renderToStaticMarkup(createElement(SidebarFilters, {
  status: 'all', onStatusChange() {}, period: '1', onPeriodChange() {},
  total: ready ? 43 : undefined, working: ready ? 4 : undefined, completed: ready ? 9 : undefined,
}));

test('pending visibility keeps filter controls available without showing premature session counts', () => {
  const html = render(false);
  assert.equal(html.match(/<b>—<\/b>/g)?.length, 3);
  assert.doesNotMatch(html, /<b>\d+<\/b>/);
  assert.match(html, /<select/);
  assert.match(html, /value="1" selected/);
  assert.doesNotMatch(html, /disabled=""[^>]*>.*최근 24시간/);
});

test('known visibility displays counts, including a real zero rather than a placeholder', () => {
  assert.match(render(true), /<b>43<\/b>/);
  assert.match(render(true), /<b>4<\/b>/);
  assert.match(render(true), /<b>9<\/b>/);
  const zero = renderToStaticMarkup(createElement(SidebarFilters, {
    status: 'all', onStatusChange() {}, period: '1', onPeriodChange() {}, total: 0, working: 0, completed: 0,
  }));
  assert.equal(zero.match(/<b>0<\/b>/g)?.length, 3);
});
