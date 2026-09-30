import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunnerUpdateBadge } from '../../../client/src/app/AutoUpdate.js';
import { setLanguage } from '../../../client/src/i18n/i18n.js';

const base = { version: '1.86.0', runnerVersion: '1.85.0', runnerUpdate: 'automatic' as const, runs: [] };

test('an older worker shows the pending badge, and "update now" only when it can switch on request', t => {
  t.after(() => setLanguage('ko'));
  setLanguage('ko');
  const plain = renderToStaticMarkup(createElement(RunnerUpdateBadge, { snapshot: base, token: 'x' }));
  assert.match(plain, /실행 워커 업데이트 대기/);
  assert.doesNotMatch(plain, /지금 업데이트/);
  const offered = renderToStaticMarkup(createElement(RunnerUpdateBadge, { snapshot: { ...base, runnerForceUpdate: true }, token: 'x' }));
  assert.match(offered, /<button[^>]*>지금 업데이트<\/button>/);
  setLanguage('en');
  assert.match(renderToStaticMarkup(createElement(RunnerUpdateBadge, { snapshot: { ...base, runnerForceUpdate: true }, token: 'x' })), />Update now</);
  assert.equal(renderToStaticMarkup(createElement(RunnerUpdateBadge, { snapshot: { ...base, runnerVersion: '1.86.0' }, token: 'x' })), '');
});

test('while running turns wrap up, the badge counts them and the time left', t => {
  t.after(() => setLanguage('ko'));
  setLanguage('ko');
  const deadline = new Date(Date.now() + 125_000).toISOString();
  const waiting = renderToStaticMarkup(createElement(RunnerUpdateBadge, { snapshot: { ...base, updateDrain: { startedAt: new Date().toISOString(), deadline, running: 2 } }, token: 'x' }));
  assert.match(waiting, /업데이트 중 · 턴 2개 마무리 대기 · 2:0[45]/);
  const switching = renderToStaticMarkup(createElement(RunnerUpdateBadge, { snapshot: { ...base, updateDrain: { startedAt: new Date().toISOString(), deadline, running: 0 } }, token: 'x' }));
  assert.match(switching, /새 버전으로 전환 중/);
});
