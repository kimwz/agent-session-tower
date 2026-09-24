import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLanguage } from '../../../client/src/i18n/i18n.js';
import { TriggerTypePicker } from '../../../client/src/triggers/TriggerKinds.js';
import { towerOperation } from '../../../client/src/triggers/trigger-helpers.js';

const NODE = 'b'.repeat(32);

test('another computer’s triggers are reached through it, and a change there carries one request ID until it is answered', async t => {
  const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const replies: Array<() => Response> = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    return replies.shift()!();
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  const ok = (result: unknown) => () => new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
  const lost = () => new Response(JSON.stringify({ error: 'lost', disposition: 'uncertain' }), { status: 502, headers: { 'content-type': 'application/json' } });
  replies.push(ok({ triggers: [] }));
  await towerOperation('token', 'triggers.list', {}, NODE);
  assert.equal(sent[0].url, `/api/nodes/${NODE}/v1/triggers.list`);
  assert.equal(sent[0].headers['X-Tower-Request-Id'], undefined, 'reading needs no request ID');
  replies.push(lost, ok({ trigger: { id: 't' } }), ok({ trigger: { id: 'u' } }));
  const input = { trigger: { name: 'Digest' } };
  await assert.rejects(towerOperation('token', 'triggers.create', input, NODE));
  await towerOperation('token', 'triggers.create', input, NODE);
  await towerOperation('token', 'triggers.create', input, NODE);
  const [first, again, next] = sent.slice(1).map(item => item.headers['X-Tower-Request-Id']);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(again, first, 'the same change sent again after a lost answer is the same request');
  assert.notEqual(next, first, 'once answered, the next change is a new request');
});

test('adding a trigger on another computer offers only the kinds that need nothing checked there', () => {
  setLanguage('ko');
  const markup = renderToStaticMarkup(createElement(TriggerTypePicker, { onPick: () => {}, slackConnected: false, remote: true }));
  assert.match(markup, /예약 실행/);
  assert.match(markup, /HTTP 응답/);
  assert.doesNotMatch(markup, /GitHub 이슈|Slack 멘션/);
});
