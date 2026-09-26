import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionError, type DecisionEngine } from '../../../server/decisions/engine.js';
import { DECISION_PROVIDERS, type DecisionProvider } from '../../../server/decisions/providers.js';
import { DecisionService } from '../../../server/decisions/service.js';

async function directory(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-decisions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A stand-in service: features only ever see the contract, so any provider can take Jev's place. */
function standIn(answer: () => Promise<unknown> = async () => ({ finished: { yes: 0.9 } })) {
  const created: string[] = [];
  const provider: DecisionProvider = { label: 'Stand-in', create: apiKey => {
    created.push(apiKey);
    return { provider: 'jev', label: 'Stand-in', decide: answer } as unknown as DecisionEngine;
  } };
  return { providers: { ...DECISION_PROVIDERS, jev: provider }, created };
}

test('without an API key nothing uses fast judgments, and a saved key is never shown again', async t => {
  const dir = await directory(t);
  const service = new DecisionService(dir);
  await service.start();
  assert.equal(service.engine('autoPromptSuggestions'), undefined);
  assert.equal(service.engine('attentionNotifications'), undefined);
  assert.deepEqual(service.overview(), { provider: 'jev', label: 'Jev', configured: false, features: { autoPromptSuggestions: true, attentionNotifications: true }, providers: [{ id: 'jev', label: 'Jev' }] });
  const overview = await service.update({ apiKey: '  tsk-abcdefgh1234  ' });
  assert.equal(overview.configured, true);
  assert.equal(overview.keyHint, '…1234');
  assert.ok(!JSON.stringify(overview).includes('abcdefgh'), 'the key stays on the server');
  assert.equal((await stat(join(dir, 'decisions.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(dir, 'decisions.json'), 'utf8')).apiKey, 'tsk-abcdefgh1234');
  assert.ok(service.engine('autoPromptSuggestions'));
  const reopened = new DecisionService(dir);
  await reopened.start();
  assert.equal(reopened.overview().keyHint, '…1234');
  await reopened.update({ apiKey: null });
  assert.equal(reopened.overview().configured, false);
  assert.equal(reopened.engine('autoPromptSuggestions'), undefined);
});

test('each feature can be turned off on its own and keeps its usual behaviour then', async t => {
  const service = new DecisionService(await directory(t));
  await service.start();
  await service.update({ apiKey: 'tsk-abcdefgh1234', features: { attentionNotifications: false } });
  assert.ok(service.engine('autoPromptSuggestions'));
  assert.equal(service.engine('attentionNotifications'), undefined);
  assert.deepEqual(service.overview().features, { autoPromptSuggestions: true, attentionNotifications: false });
});

test('settings refuse unknown fields, providers, features, and malformed keys', async t => {
  const service = new DecisionService(await directory(t));
  await service.start();
  await assert.rejects(service.update({ token: 'x' }), { statusCode: 400 });
  await assert.rejects(service.update({ provider: 'other' }), { statusCode: 400 });
  await assert.rejects(service.update({ features: { everything: true } }), { statusCode: 400 });
  await assert.rejects(service.update({ features: { autoPromptSuggestions: 'yes' } }), { statusCode: 400 });
  for (const apiKey of ['short', 'has space inside', 'x'.repeat(513), 42]) await assert.rejects(service.update({ apiKey }), { statusCode: 400 });
  assert.equal(service.overview().configured, false);
});

test('the provider is chosen by settings alone, so replacing Jev needs only another adapter', async t => {
  const { providers, created } = standIn();
  const service = new DecisionService(await directory(t), providers);
  await service.start();
  await service.update({ apiKey: 'first-key-0001' });
  const engine = service.engine('autoPromptSuggestions');
  assert.equal(engine?.label, 'Stand-in');
  assert.equal(service.engine('attentionNotifications'), engine, 'one engine per key');
  await service.update({ apiKey: 'second-key-0002' });
  assert.notEqual(service.engine('autoPromptSuggestions'), engine);
  assert.deepEqual(created, ['first-key-0001', 'second-key-0002']);
  assert.equal(service.overview().label, 'Stand-in');
});

test('checking a key asks one made-up question and words a refusal for the owner', async t => {
  let answer: () => Promise<unknown> = async () => ({ finished: { yes: 0.9 } });
  const { providers } = standIn(() => answer());
  const service = new DecisionService(await directory(t), providers);
  await service.start();
  await assert.rejects(service.test(), { statusCode: 409 });
  await service.update({ apiKey: 'tsk-abcdefgh1234' });
  assert.equal((await service.test()).configured, true);
  answer = async () => { throw new DecisionError('unauthorized', 'no'); };
  await assert.rejects(service.test(), { statusCode: 400, message: /API 키를 거부/ });
  answer = async () => { throw new DecisionError('unavailable', 'no'); };
  await assert.rejects(service.test(), { statusCode: 502 });
});

test('a damaged settings file starts with suggestions off rather than failing', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, 'decisions.json'), JSON.stringify({ provider: 'gone', apiKey: 'no', features: { autoPromptSuggestions: 'maybe' } }), { mode: 0o600 });
  const service = new DecisionService(dir);
  await service.start();
  assert.deepEqual(service.overview(), { provider: 'jev', label: 'Jev', configured: false, features: { autoPromptSuggestions: true, attentionNotifications: true }, providers: [{ id: 'jev', label: 'Jev' }] });
});

test('changes apply one at a time, so a deleted key never comes back through a change made at the same moment', async t => {
  const service = new DecisionService(await directory(t));
  await service.start();
  await service.update({ apiKey: 'tsk-abcdefgh1234' });
  await Promise.all([service.update({ apiKey: null }), service.update({ features: { attentionNotifications: false } })]);
  assert.equal(service.overview().configured, false);
  assert.equal(service.overview().features.attentionNotifications, false);
  const reopened = new DecisionService((service as unknown as { stateDir: string }).stateDir);
  await reopened.start();
  assert.equal(reopened.overview().configured, false);
});
