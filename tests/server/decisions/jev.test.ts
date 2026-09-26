import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionError } from '../../../server/decisions/engine.js';
import { JEV_ENDPOINT, JevEngine } from '../../../server/decisions/jev.js';

const questions = {
  project: { type: 'choice' as const, instructions: 'Which project?', options: { d1: 'Web app', none: 'None fits' } },
  urgent: { type: 'yesNo' as const, instructions: 'Is it a bug?' },
  size: { type: 'score' as const, instructions: 'How big?', levels: ['tiny', 'medium', 'huge'] },
};
// The shape Jev answered with when checked by hand.
const answered = { model: 'jev-1.13.0', answers: {
  project: { type: 'choice', choice: 'd1', confidence: 0.98, probabilities: { none: 0.01, d1: 0.99 } },
  urgent: { type: 'noul', noul: 0.98 },
  size: { type: 'score', score: 0.55, confidence: 0.32, legend: { 0: 'tiny', 1: 'medium', 2: 'huge' }, probabilities: { 0: 0.45, 1: 0.55, 2: 0 } },
}, usage: { input_tokens: 407, output_tokens: 71 } };

function engine(respond: (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>, timeoutMs?: number) {
  const requests: Array<{ url: string; body: Record<string, unknown>; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), body, init: init! });
    return respond(body, init!);
  }) as typeof fetch;
  return { engine: new JevEngine('secret-key-1234', fetcher, timeoutMs), requests };
}

test('Jev receives typed questions in its own shape and its answers come back in the contract shape', async () => {
  const { engine: jev, requests } = engine(() => Response.json(answered));
  const answers = await jev.decide({ state: { request: 'Fix the login bug' }, questions });
  assert.equal(requests[0].url, JEV_ENDPOINT);
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer secret-key-1234');
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(requests[0].body, { model: 'jev-latest', state: { request: 'Fix the login bug' }, questions: {
    project: { type: 'choice', instructions: 'Which project?', criteria: { d1: 'Web app', none: 'None fits' } },
    urgent: { type: 'noul', instructions: 'Is it a bug?' },
    size: { type: 'score', instructions: 'How big?', criteria: ['tiny', 'medium', 'huge'] },
  } });
  assert.deepEqual(answers, {
    project: { choice: 'd1', confidence: 0.98, probabilities: { d1: 0.99, none: 0.01 } },
    urgent: { yes: 0.98 },
    size: { score: 0.55, confidence: 0.32, probabilities: [0.45, 0.55, 0] },
  });
});

test('answers that do not fit the questions are refused instead of guessed', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['unknown choice', { ...answered.answers, project: { ...answered.answers.project, choice: 'd9' } }],
    ['missing answer', { urgent: answered.answers.urgent, size: answered.answers.size }],
    ['probability out of range', { ...answered.answers, urgent: { type: 'noul', noul: 1.5 } }],
    ['not a number', { ...answered.answers, urgent: { type: 'noul', noul: Number.NaN } }],
    ['missing score level', { ...answered.answers, size: { ...answered.answers.size, probabilities: { 0: 0.5, 1: 0.5 } } }],
    ['wrong type', { ...answered.answers, urgent: { type: 'choice', choice: 'd1' } }],
  ];
  for (const [name, answers] of cases) {
    const { engine: jev } = engine(() => Response.json({ answers }));
    await assert.rejects(jev.decide({ state: 'x', questions }), (error: unknown) => error instanceof DecisionError && error.kind === 'invalid-response', name);
  }
});

test('failures are named by kind and never repeat the API key or the request', async () => {
  const statuses: Array<[number, string]> = [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate-limited'], [422, 'invalid-request'], [529, 'unavailable'], [500, 'unavailable']];
  for (const [status, kind] of statuses) {
    const { engine: jev } = engine(() => new Response('{"error":"secret-key-1234 Fix the login bug"}', { status }));
    await assert.rejects(jev.decide({ state: 'Fix the login bug', questions }), (error: unknown) => {
      assert.ok(error instanceof DecisionError); assert.equal(error.kind, kind);
      assert.doesNotMatch(error.message, /secret-key|login bug/);
      return true;
    });
  }
  const { engine: offline } = engine(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(offline.decide({ state: 'x', questions }), { kind: 'unavailable' });
});

test('a slow answer times out and a cancelled one says so', async () => {
  // Like a real request, a pending answer keeps the process alive; abort timers alone do not.
  const hang = (_body: Record<string, unknown>, init: RequestInit) => new Promise<Response>((_, reject) => {
    const alive = setInterval(() => {}, 1000);
    init.signal!.addEventListener('abort', () => { clearInterval(alive); reject(init.signal!.reason); });
  });
  await assert.rejects(engine(hang, 20).engine.decide({ state: 'x', questions }), { kind: 'timeout' });
  const controller = new AbortController();
  const pending = engine(hang).engine.decide({ state: 'x', questions, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { kind: 'cancelled' });
});

test('requests Jev cannot take are refused before anything is sent', async () => {
  const { engine: jev, requests } = engine(() => Response.json(answered));
  const many = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`o${index}`, 'An option']));
  await assert.rejects(jev.decide({ state: 'x', questions: { pick: { type: 'choice', instructions: 'Pick', options: many } } }), { kind: 'invalid-request' });
  await assert.rejects(jev.decide({ state: 'x', questions: { rate: { type: 'score', instructions: 'Rate', levels: Array.from({ length: 11 }, (_, index) => `level ${index}`) } } }), { kind: 'invalid-request' });
  await assert.rejects(jev.decide({ state: 'x'.repeat(120_000), questions }), { kind: 'invalid-request' });
  await assert.rejects(jev.decide({ state: 'x', questions: { 'has space': { type: 'yesNo', instructions: 'Yes?' } } }), { kind: 'invalid-request' });
  await assert.rejects(jev.decide({ state: 'x', questions: { one: { type: 'choice', instructions: 'Pick', options: { only: 'One option' } } } }), { kind: 'invalid-request' });
  assert.equal(requests.length, 0);
});
