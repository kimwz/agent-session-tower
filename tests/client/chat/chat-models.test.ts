import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { draftFromRun, finishComposerSend, getComposerState, setComposerDraft, startComposerSend } from '../../../client/src/chat/chat-drafts.js';
import { EffortPicker, modelChoices, modelEfforts, ModelPicker, supportedEffort } from '../../../client/src/chat/ModelPicker.js';
import { setLanguage } from '../../../client/src/i18n/i18n.js';
import type { ProviderHealth, Run } from '../../../shared/types.js';

const provider: ProviderHealth = { provider: 'codex', available: true, sessionCount: 1, defaultModel: 'provider-default', models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }] };
const run = (model?: string): Run => ({ id: 'r', sessionId: 's', status: 'error', prompt: 'Original prompt', output: '', createdAt: '2026-09-15T00:00:00Z', ...(model ? { model } : {}) });

test('the model catalog keeps observed or selected models without inventing a default override', () => {
  assert.deepEqual(modelChoices(provider, 'session-native', 'last-selected').map(model => model.id), ['model-a', 'model-b', 'session-native', 'last-selected']);
  assert.equal(modelChoices(provider, 'model-a', 'model-a').length, 2);
  assert.deepEqual(modelChoices(undefined), []);
  setLanguage('en');
  const html = renderToStaticMarkup(createElement(ModelPicker, { provider, observedModel: 'session-native', onChange() {} }));
  assert.match(html, /value="" selected=""/);
  assert.match(html, /Agent default \(no override\)/);
  assert.match(html, /<option value="" selected="">session-native<\/option>/);
  assert.match(html, /aria-label="Model"/);
  assert.doesNotMatch(html, /<label|model-picker-hint|Keep existing model/);
  const current = renderToStaticMarkup(createElement(ModelPicker, { provider, observedModel: 'model-a', onChange() {} }));
  assert.match(current, /<option value="" selected="">Model A<\/option>/);
  assert.equal((current.match(/>Model A<\/option>/g) || []).length, 1);
  const explicitCurrent = renderToStaticMarkup(createElement(ModelPicker, { provider, observedModel: 'model-a', value: 'model-a', onChange() {} }));
  assert.match(explicitCurrent, /<option value="model-a" selected="">Model A<\/option>/);
  assert.match(explicitCurrent, /<option value="">Agent default<\/option>/);
  assert.equal((explicitCurrent.match(/>Model A<\/option>/g) || []).length, 1);
  assert.match(renderToStaticMarkup(createElement(ModelPicker, { provider, onChange() {} })), /<option value="" selected="">provider-default<\/option>/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ModelPicker, { onChange() {} })), /disabled=""/);
  setLanguage('ko');
});

test('model choices survive successful sends, panel navigation, and failed-send drafts independently per session', () => {
  const first = `model-${crypto.randomUUID()}`;
  const second = `default-${crypto.randomUUID()}`;
  setComposerDraft(first, { prompt: 'first', attachments: [], model: 'model-a' });
  setComposerDraft(second, { prompt: 'second', attachments: [] });
  const submitted = startComposerSend(first)!;
  assert.equal(submitted.model, 'model-a');
  finishComposerSend(first, submitted);
  assert.deepEqual(getComposerState(first).draft, { prompt: '', attachments: [], model: 'model-a' });
  assert.equal(getComposerState(second).draft.model, undefined);
  const failed = { prompt: 'retry me', attachments: [], model: 'model-b' };
  setComposerDraft(first, failed);
  finishComposerSend(first, startComposerSend(first)!, 'offline');
  assert.equal(getComposerState(first).draft, failed);
});

test('retry restores the original run model even after a different selection, including original no-override requests', () => {
  const id = `retry-${crypto.randomUUID()}`;
  setComposerDraft(id, { prompt: 'newer', attachments: [], model: 'model-b' });
  setComposerDraft(id, draftFromRun(run('model-a')));
  assert.equal(getComposerState(id).draft.model, 'model-a');
  assert.equal(startComposerSend(id)?.model, 'model-a');
  finishComposerSend(id, getComposerState(id).draft);
  setComposerDraft(id, draftFromRun(run()));
  assert.equal(getComposerState(id).draft.model, undefined);
  assert.equal(Object.hasOwn(getComposerState(id).draft, 'model'), false);
});

const claude: ProviderHealth = { provider: 'claude', available: true, sessionCount: 1, efforts: [{ id: 'low' }, { id: 'max' }],
  models: [{ id: 'opus', label: 'Opus', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] }, { id: 'haiku', label: 'Haiku', efforts: [] }] };
const codex: ProviderHealth = { ...provider, models: [{ id: 'model-a', label: 'Model A', defaultEffort: 'medium', efforts: [{ id: 'medium' }, { id: 'xhigh', description: 'Deepest' }] }, { id: 'model-b', label: 'Model B' }] };

test('effort choices follow the selected, observed or catalog model and drop levels the next model cannot use', () => {
  assert.deepEqual(modelEfforts(codex, 'model-a'), { efforts: [{ id: 'medium' }, { id: 'xhigh', description: 'Deepest' }], defaultEffort: 'medium' });
  assert.deepEqual(modelEfforts(codex, 'model-b').efforts, []);
  assert.equal(modelEfforts({ ...codex, defaultEffort: 'xhigh' }, 'model-a').defaultEffort, 'xhigh', 'the native configured effort wins');
  assert.equal(modelEfforts({ ...codex, defaultEffort: 'ultra' }, 'model-a').defaultEffort, 'medium', 'an unsupported configured effort falls back to the model default');
  assert.deepEqual(modelEfforts(claude, 'claude-opus-5-5').efforts.map(effort => effort.id), ['low', 'high', 'max']);
  assert.deepEqual(modelEfforts(claude, 'claude-haiku-4-5').efforts, []);
  assert.deepEqual(modelEfforts(claude, 'custom-model').efforts.map(effort => effort.id), ['low', 'max']);
  assert.equal(supportedEffort(codex, 'model-a', 'xhigh'), 'xhigh');
  assert.equal(supportedEffort(codex, 'model-b', 'xhigh'), undefined);
  assert.equal(supportedEffort(claude, 'haiku', 'high'), undefined);
  assert.equal(supportedEffort(claude, 'opus', undefined), undefined);
});

test('the effort picker offers only supported levels with a no-override default and hides for models without effort control', () => {
  setLanguage('en');
  const html = renderToStaticMarkup(createElement(EffortPicker, { provider: codex, model: 'model-a', onChange() {} }));
  assert.match(html, /aria-label="Reasoning effort"/);
  assert.match(html, /<option value="" selected="">Default effort \(Medium\)<\/option>/);
  assert.match(renderToStaticMarkup(createElement(EffortPicker, { provider: { ...codex, defaultEffort: 'xhigh' }, model: 'model-a', onChange() {} })), /<option value="" selected="">Default effort \(Extra high\)<\/option>/);
  assert.match(html, /<option value="xhigh" title="Deepest">Extra high<\/option>/);
  assert.match(renderToStaticMarkup(createElement(EffortPicker, { provider: codex, model: 'model-a', value: 'xhigh', onChange() {} })), /<option value="xhigh" title="Deepest" selected="">/);
  assert.match(renderToStaticMarkup(createElement(EffortPicker, { provider: claude, model: 'opus', value: 'unsupported', onChange() {} })), /<option value="" selected="">Default effort<\/option>/);
  assert.equal(renderToStaticMarkup(createElement(EffortPicker, { provider: claude, model: 'haiku', onChange() {} })), '');
  assert.equal(renderToStaticMarkup(createElement(EffortPicker, { onChange() {} })), '');
  setLanguage('ko');
});

test('the chosen effort survives a successful send and retry restores the original effort', () => {
  const id = `effort-${crypto.randomUUID()}`;
  setComposerDraft(id, { prompt: 'think', attachments: [], model: 'model-a', effort: 'xhigh' });
  const submitted = startComposerSend(id)!;
  finishComposerSend(id, submitted);
  assert.deepEqual(getComposerState(id).draft, { prompt: '', attachments: [], model: 'model-a', effort: 'xhigh' });
  setComposerDraft(id, draftFromRun({ ...run('model-b'), effort: 'low' }));
  assert.equal(getComposerState(id).draft.effort, 'low');
  setComposerDraft(id, draftFromRun(run()));
  assert.equal(Object.hasOwn(getComposerState(id).draft, 'effort'), false);
});

test('a fresh composer restores the effort of the session\'s latest request, and a worker older than the page is flagged', async () => {
  const { getComposerState, restoreComposerEffort, setComposerDraft } = await import('../../../client/src/chat/chat-drafts.js');
  const { outdatedRunner } = await import('../../../client/src/common/lib.js');
  const run = (id: string, createdAt: string, effort?: string) => ({ id, sessionId: 's1', prompt: '', status: 'completed' as const, createdAt, output: '', ...(effort ? { effort } : {}) });
  restoreComposerEffort('s1', [run('a', '2026-09-23T01:00:00Z', 'max'), run('b', '2026-09-23T02:00:00Z', 'high')], effort => effort);
  assert.equal(getComposerState('s1').draft.effort, 'high');
  setComposerDraft('s1', { prompt: 'typing', attachments: [], effort: 'low' });
  restoreComposerEffort('s1', [run('c', '2026-09-23T03:00:00Z', 'max')], effort => effort);
  assert.equal(getComposerState('s1').draft.effort, 'low', 'an existing composer is never overwritten');
  restoreComposerEffort('s2', [{ ...run('d', '2026-09-23T01:00:00Z', 'max'), sessionId: 's2' }], () => undefined);
  assert.equal(getComposerState('s2').draft.effort, undefined, 'levels the current model cannot use are dropped');
  restoreComposerEffort('s3', [{ ...run('e', '2026-09-23T01:00:00Z', 'max'), sessionId: 's3' }, { ...run('f', '2026-09-23T02:00:00Z'), sessionId: 's3' }], effort => effort);
  assert.equal(getComposerState('s3').draft.effort, undefined, 'a later default request wins');
  assert.equal(outdatedRunner({ version: '1.12.2', runnerVersion: 'legacy' }), 'legacy');
  assert.equal(outdatedRunner({ version: '1.12.2', runnerVersion: '1.12.2' }), undefined);
  assert.equal(outdatedRunner({ version: '1.12.2', runnerVersion: '1.12.1' }), '1.12.1');
  assert.equal(outdatedRunner({ version: '1.12.2', runnerVersion: '1.13.0' }), undefined, 'a newer worker left by an undone update is not waiting to be replaced');
  assert.equal(outdatedRunner({ version: '1.12.2' }), undefined);
});
