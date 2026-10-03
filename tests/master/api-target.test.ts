import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_REFUSED, apiTarget } from '../../server/tower-tools/api-target.js';
import { classify } from '../../server/tower-tools/tower-client.js';

const NODE = 'a'.repeat(32);

test('a call is filed by what the server says about running it before its HTTP status', () => {
  for (const status of [409, 502, 503, 504]) assert.equal(classify(status, { disposition: 'uncertain' }), 'uncertain', String(status));
  assert.equal(classify(503, { disposition: 'not-admitted' }), 'not-admitted');
  assert.equal(classify(503, { disposition: 'handoff' }), 'not-admitted');
  assert.equal(classify(409, { disposition: 'not-admitted' }), 'failed');
  assert.equal(classify(200, {}), 'succeeded');
  assert.equal(classify(400, { error: 'bad' }), 'failed');
  assert.equal(classify(500, {}), 'uncertain');
  assert.equal(classify(502, {}), 'uncertain');
});

test('the master calls the same routes as the pages, and refuses paths the server could read differently', () => {
  const create = apiTarget('POST', '/api/sessions');
  assert.equal(create.write, true);
  assert.equal(apiTarget('POST', '/api/v1/triggers.list').write, false, 'reading operations are not changes');
  assert.equal(apiTarget('POST', '/api/runs/r1/cancel').write, true);
  const remote = apiTarget('GET', '/api/sessions/x?limit=5', NODE);
  assert.equal(remote.path, `/api/nodes/${NODE}/sessions/x?limit=5`);
  assert.equal(remote.node, NODE);
  assert.equal(remote.local, '/api/sessions/x');
  assert.equal(apiTarget('POST', `/api/nodes/${NODE}/runs/r/cancel`).node, NODE);
  for (const [method, path] of [['GET', '/api/master'], ['POST', '/api/master/messages'], ['POST', '/api/auth/login'], ['GET', '/api/events'], ['GET', '/api/workspace/terminals/x/events'],
    ['GET', '/api/sessions/%2e%2e/x'], ['GET', '/api/a%2fb'], ['GET', '/api//snapshot'], ['GET', '/api/../x'], ['DELETE', '/api/snapshot'], ['GET', '/other'], ['GET', `/api/nodes/${NODE}/nodes/${NODE}/snapshot`]]) {
    assert.throws(() => apiTarget(method, path), { kind: 'invalid' }, `${method} ${path}`);
  }
  assert.throws(() => apiTarget('GET', `/api/nodes/${NODE}/snapshot`, NODE), { kind: 'invalid' });
  assert.throws(() => apiTarget('GET', '/api/snapshot', 'not-a-node'), { kind: 'invalid' });
});

test('an approval answers the ID the run gave, encoded slash included, and only there', () => {
  const answer = apiTarget('POST', '/api/runs/run-1/approvals/request%2F1');
  assert.equal(answer.path, '/api/runs/run-1/approvals/request%2F1', 'sent as written, as the page sends it');
  assert.equal(answer.write, true);
  assert.equal(apiTarget('POST', '/api/runs/run-1/approvals/request%2F1', NODE).path, `/api/nodes/${NODE}/runs/run-1/approvals/request%2F1`);
  assert.equal(apiTarget('POST', `/api/nodes/${NODE}/runs/run-1/approvals/a%2Fb`).node, NODE);
  for (const path of ['/api/runs/run-1/cancel%2Fx', '/api/sessions/a%2Fb/messages', '/api/runs/r%2Fx/approvals']) assert.throws(() => apiTarget('POST', path), { kind: 'invalid' }, path);
});

test('an agent of the owner\'s may call the master\'s routes too, but never sign-in or live streams', () => {
  assert.equal(apiTarget('POST', '/api/master/settings', undefined, AGENT_REFUSED).local, '/api/master/settings');
  assert.equal(apiTarget('GET', '/api/master/state', undefined, AGENT_REFUSED).write, false);
  for (const [method, path] of [['POST', '/api/auth/logout'], ['POST', '/api/auth/login'], ['GET', '/api/bootstrap'], ['GET', '/api/events'], ['GET', '/api/master/events'], ['GET', '/api/workspace/terminals/x/events']]) {
    assert.throws(() => apiTarget(method, path, undefined, AGENT_REFUSED), { kind: 'invalid' }, `${method} ${path}`);
  }
  assert.throws(() => apiTarget('POST', '/api/master/settings'), { kind: 'invalid' }, 'the master itself keeps off them');
});
