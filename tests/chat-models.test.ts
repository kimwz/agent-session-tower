import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { draftFromRun, finishComposerSend, getComposerState, setComposerDraft, startComposerSend } from '../client/src/chat/chat-drafts.js';
import { modelChoices, ModelPicker } from '../client/src/chat/ModelPicker.js';
import { setLanguage } from '../client/src/i18n/i18n.js';
import type { ProviderHealth, Run } from '../shared/types.js';

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
