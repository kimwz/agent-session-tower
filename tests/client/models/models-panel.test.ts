import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PickRow, SettingsProblem } from '../../../client/src/models/ModelsPanel.tsx';
import { setLanguage } from '../../../client/src/i18n/i18n.ts';
import { CLAUDE_MODELS } from '../../../server/providers/capabilities.ts';

const claude = { provider: 'claude' as const, available: true, sessionCount: 0, models: CLAUDE_MODELS.map(model => ({ ...model })) };
const render = (pick: { model?: string; effort?: string }) => renderToStaticMarkup(createElement(PickRow, { provider: 'claude', labelled: false, pick, health: claude, off: true, disabled: false, onChange() {} }));

test('a role\'s model is chosen from the computer\'s whole list, whatever is selected now', () => {
  const html = render({ model: 'opus' });
  for (const label of ['Claude 기본값', 'Fable 5.1 (fable)', 'Opus 5.5 (opus)', 'Sonnet 5.5 (sonnet)', 'Haiku 5.5 (haiku)', '직접 입력…']) assert.ok(html.includes(label), label);
  assert.match(html, /<option value="opus" selected="">/);
  assert.doesNotMatch(html, /<input/, 'no text field for a listed model');
});

test('a model the list does not have is shown in a text field beside the list', () => {
  const html = render({ model: 'claude-opus-5-5', effort: 'high' });
  assert.match(html, /<option value="__custom__" selected="">/);
  assert.match(html, /<input[^>]*value="claude-opus-5-5"/);
  assert.match(html, /목록에 없는 모델/);
});

test("a role's verified initial model is not flagged although the list names only aliases", () => {
  const html = renderToStaticMarkup(createElement(PickRow, { provider: 'claude', labelled: false, pick: { model: 'claude-haiku-5-5' }, health: claude, off: true, disabled: false, verified: 'claude-haiku-5-5', onChange() {} }));
  assert.match(html, /<input[^>]*value="claude-haiku-5-5"/);
  assert.doesNotMatch(html, /목록에 없는 모델/);
});

test('the settings problem is shown, and nothing when the computer sends none', () => {
  setLanguage('ko');
  const problem = '모델 설정 파일(models.json)을 읽을 수 없어 기본값을 쓰고 있습니다. 원래 파일은 그대로 두고 /state/models.json.unreadable-0123456789abcdef에 복사해 두었습니다. 저장하면 이 화면의 설정으로 바뀝니다.';
  assert.equal(renderToStaticMarkup(createElement(SettingsProblem, {})), '');
  assert.match(renderToStaticMarkup(createElement(SettingsProblem, { problem })), /^<p role="alert" class="slack-error">모델 설정 파일\(models\.json\)을 읽을 수 없어/);
  setLanguage('en');
  assert.match(renderToStaticMarkup(createElement(SettingsProblem, { problem })), /The model settings file \(models\.json\) cannot be read, so the defaults are in use\. The file is left as it is, with a copy at \/state\/models\.json\.unreadable-0123456789abcdef\./);
  assert.match(renderToStaticMarkup(createElement(SettingsProblem, { problem: '모델 설정 파일을 읽지 못해 기본값을 쓰고 있습니다: EACCES: permission denied. 파일은 그대로 두었습니다.' })),
    /The model settings file could not be read, so the defaults are in use: EACCES: permission denied\. The file is left as it is\./);
  setLanguage('ko');
});

test('a computer\'s settings problem is kept with its settings and cleared by a save there', async t => {
  const { loadModelSettings, saveModelSettings: save } = await import('../../../client/src/models/model-settings.ts');
  const { initialModelSettings } = await import('../../../shared/models.ts');
  const answers: unknown[] = [{ settings: initialModelSettings(), problem: 'kept' }, { settings: initialModelSettings() }];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ result: answers.shift() }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const { problemFor } = await import('../../../client/src/models/model-settings.ts');
  await loadModelSettings('token', undefined, true);
  assert.equal(problemFor(undefined), 'kept');
  await save('token', initialModelSettings());
  assert.equal(problemFor(undefined), undefined);
});
