import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PickRow } from '../../../client/src/models/ModelsPanel.tsx';
import { CLAUDE_MODELS } from '../../../server/providers/capabilities.ts';

const claude = { provider: 'claude' as const, available: true, sessionCount: 0, models: CLAUDE_MODELS.map(model => ({ ...model })) };
const render = (pick: { model?: string; effort?: string }) => renderToStaticMarkup(createElement(PickRow, { provider: 'claude', labelled: false, pick, health: claude, off: true, disabled: false, onChange() {} }));

test('a role\'s model is chosen from the computer\'s whole list, whatever is selected now', () => {
  const html = render({ model: 'opus' });
  for (const label of ['Claude 기본값', 'Fable 5.1 (fable)', 'Opus 5.5 (opus)', 'Sonnet 5.5 (sonnet)', 'Haiku 4.5 (haiku)', '직접 입력…']) assert.ok(html.includes(label), label);
  assert.match(html, /<option value="opus" selected="">/);
  assert.doesNotMatch(html, /<input/, 'no text field for a listed model');
});

test('a model the list does not have is shown in a text field beside the list', () => {
  const html = render({ model: 'claude-opus-5-5', effort: 'high' });
  assert.match(html, /<option value="__custom__" selected="">/);
  assert.match(html, /<input[^>]*value="claude-opus-5-5"/);
  assert.match(html, /목록에 없는 모델/);
});
