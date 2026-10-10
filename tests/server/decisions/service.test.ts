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
  assert.deepEqual(service.overview(), { provider: 'jev', label: 'Jev', configured: false, features: { autoPromptSuggestions: true, attentionNotifications: true, steerTiming: true, sessionOutcomes: true, relatedSessions: true, slackFollowUps: true, voiceTurnEnd: true }, providers: [{ id: 'jev', label: 'Jev' }], recent: [] });
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
  assert.deepEqual(service.overview().features, { autoPromptSuggestions: true, attentionNotifications: false, steerTiming: true, sessionOutcomes: true, relatedSessions: true, slackFollowUps: true, voiceTurnEnd: true });
});

test('settings refuse unknown fields, providers, features, and malformed keys', async t => {
  const service = new DecisionService(await directory(t));
  await service.start();
  await assert.rejects(service.update({ token: 'x' }), { kind: 'invalid' });
  await assert.rejects(service.update({ provider: 'other' }), { kind: 'invalid' });
  await assert.rejects(service.update({ features: { everything: true } }), { kind: 'invalid' });
  await assert.rejects(service.update({ features: { autoPromptSuggestions: 'yes' } }), { kind: 'invalid' });
  for (const apiKey of ['short', 'has space inside', 'x'.repeat(513), 42]) await assert.rejects(service.update({ apiKey }), { kind: 'invalid' });
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

test('a cached engine checks service authority then each request scope immediately before sending', async t => {
  const events: string[] = [];
  const sent: unknown[] = [];
  const denied = new Error('authority fence refused');
  let allowed = false;
  let scope = 'blocked';
  const fetcher: typeof fetch = async (_url, init) => {
    events.push(`send:${scope}`);
    sent.push(JSON.parse(String(init?.body)).state);
    return Response.json({ answers: { finished: { type: 'noul', noul: 0.9 } } });
  };
  const service = new DecisionService(await directory(t), DECISION_PROVIDERS, fetcher, async () => {
    await Promise.resolve();
    events.push(`service:${scope}`);
    if (!allowed) throw denied;
  });
  await service.start();
  await service.update({ apiKey: 'fixture-key-0001' });
  const engine = service.engine('autoPromptSuggestions')!;
  assert.equal(service.engine('attentionNotifications'), engine, 'composed wrapper is cached too');
  const questions = { finished: { type: 'yesNo' as const, instructions: 'Is the work finished?' } };
  await assert.rejects(engine.decide({ state: scope, questions, beforeSend: async () => { events.push('request:blocked'); } }), error => error === denied);
  assert.deepEqual(events, ['service:blocked']);
  assert.equal(sent.length, 0, 'authority refusal sends no provider request');
  allowed = true;
  scope = 'request-denied';
  await assert.rejects(engine.decide({ state: scope, questions, beforeSend: async () => {
    await Promise.resolve();
    events.push(`request:${scope}`);
    throw denied;
  } }), error => error === denied);
  assert.equal(sent.length, 0, 'request scope refusal sends no provider request');
  for (const current of ['first', 'second']) {
    scope = current;
    assert.equal(service.engine('attentionNotifications'), engine);
    assert.deepEqual(await engine.decide({ state: current, questions, beforeSend: async () => {
      await Promise.resolve();
      events.push(`request:${current}`);
      assert.equal(scope, current);
    } }), { finished: { yes: 0.9 } });
  }
  scope = 'without-callback';
  await engine.decide({ state: scope, questions });
  assert.deepEqual(events, [
    'service:blocked', 'service:request-denied', 'request:request-denied',
    'service:first', 'request:first', 'send:first',
    'service:second', 'request:second', 'send:second',
    'service:without-callback', 'send:without-callback',
  ]);
  assert.deepEqual(sent, ['first', 'second', 'without-callback']);
});

test('checking a key asks one made-up question and words a refusal for the owner', async t => {
  let answer: () => Promise<unknown> = async () => ({ finished: { yes: 0.9 } });
  const { providers } = standIn(() => answer());
  const service = new DecisionService(await directory(t), providers);
  await service.start();
  await assert.rejects(service.test(), { kind: 'conflict' });
  await service.update({ apiKey: 'tsk-abcdefgh1234' });
  assert.equal((await service.test()).configured, true);
  answer = async () => { throw new DecisionError('unauthorized', 'no'); };
  await assert.rejects(service.test(), { kind: 'invalid', message: /API 키를 거부/ });
  answer = async () => { throw new DecisionError('unavailable', 'no'); };
  await assert.rejects(service.test(), { kind: 'upstream' });
});

test('a damaged settings file starts with suggestions off rather than failing', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, 'decisions.json'), JSON.stringify({ provider: 'gone', apiKey: 'no', features: { autoPromptSuggestions: 'maybe' } }), { mode: 0o600 });
  const service = new DecisionService(dir);
  await service.start();
  assert.deepEqual(service.overview(), { provider: 'jev', label: 'Jev', configured: false, features: { autoPromptSuggestions: true, attentionNotifications: true, steerTiming: true, sessionOutcomes: true, relatedSessions: true, slackFollowUps: true, voiceTurnEnd: true }, providers: [{ id: 'jev', label: 'Jev' }], recent: [] });
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

test('recent judgments are listed newest first, rounded, and only the latest ones are kept', async t => {
  const service = new DecisionService(await directory(t));
  await service.start();
  for (let index = 0; index < 45; index++) service.record({ feature: 'attentionNotifications', subject: `turn ${index}`, result: 'notify', probabilities: { done: 0.123456, progress: 0.01 }, ms: 201.7 });
  const recent = service.overview().recent!;
  assert.equal(recent.length, 40);
  assert.equal(recent[0].subject, 'turn 44');
  assert.deepEqual(recent[0].probabilities, { done: 0.12, progress: 0.01 });
  assert.equal(recent[0].ms, 202);
});
