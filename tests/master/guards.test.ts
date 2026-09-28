import test from 'node:test';
import assert from 'node:assert/strict';
import { apiTarget, refusalFor, type TurnScope } from '../../server/master/guards.js';
import { classify } from '../../server/master/tower-client.js';
import { SecretVault } from '../../server/master/secrets.js';
import { DEFAULT_MASTER_GUARDS, type MasterGuards } from '../../shared/master.js';

const NODE = 'a'.repeat(32);
const owner: TurnScope = { local: true, cause: 'owner', irreversible: 0 };

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
  assert.equal(create.irreversible, false);
  assert.equal(apiTarget('POST', '/api/v1/triggers.list').write, false, 'reading operations are not changes');
  assert.equal(apiTarget('POST', '/api/runs/r1/cancel').irreversible, true);
  const remote = apiTarget('GET', '/api/sessions/x?limit=5', NODE);
  assert.equal(remote.path, `/api/nodes/${NODE}/sessions/x?limit=5`);
  assert.equal(remote.node, NODE);
  assert.equal(remote.local, '/api/sessions/x');
  assert.equal(apiTarget('POST', `/api/nodes/${NODE}/runs/r/cancel`).node, NODE);
  for (const [method, path] of [['GET', '/api/master'], ['POST', '/api/master/messages'], ['POST', '/api/auth/login'], ['GET', '/api/events'], ['GET', '/api/workspace/terminals/x/events'],
    ['GET', '/api/sessions/%2e%2e/x'], ['GET', '/api/a%2fb'], ['GET', '/api//snapshot'], ['GET', '/api/../x'], ['DELETE', '/api/snapshot'], ['GET', '/other'], ['GET', `/api/nodes/${NODE}/nodes/${NODE}/snapshot`]]) {
    assert.throws(() => apiTarget(method, path), { statusCode: 400 }, `${method} ${path}`);
  }
  assert.throws(() => apiTarget('GET', `/api/nodes/${NODE}/snapshot`, NODE), { statusCode: 400 });
  assert.throws(() => apiTarget('GET', '/api/snapshot', 'not-a-node'), { statusCode: 400 });
});

test('by default the master may do everything the owner asks, except what Tower keeps for this computer itself', () => {
  const guards = DEFAULT_MASTER_GUARDS;
  assert.equal(refusalFor(guards, owner, apiTarget('POST', '/api/runs/r/cancel')), undefined);
  assert.equal(refusalFor(guards, { ...owner, cause: 'event' }, apiTarget('POST', '/api/sessions')), undefined);
  assert.equal(refusalFor(guards, owner, apiTarget('POST', '/api/sessions', NODE)), undefined);
  // Local-only pages stay local, for reads too, whatever the loopback call looks like to the server.
  assert.equal(refusalFor(guards, owner, apiTarget('GET', '/api/auth/overview')), undefined);
  assert.match(refusalFor(guards, { ...owner, local: false }, apiTarget('GET', '/api/auth/overview'))!, /이 컴퓨터/);
  assert.match(refusalFor(guards, { ...owner, local: false }, apiTarget('POST', '/api/tower/update'))!, /이 컴퓨터/);
  assert.equal(refusalFor({ ...guards, localOnlyPages: false }, { ...owner, local: false }, apiTarget('POST', '/api/tower/update')), undefined);
});

test('limits the owner turns on are applied: report-only events, read-only computers and a cap per request', () => {
  const guards: MasterGuards = { ...DEFAULT_MASTER_GUARDS, eventTurnsReadOnly: true, readOnlyNodes: [NODE], maxIrreversiblePerTurn: 2 };
  assert.match(refusalFor(guards, { ...owner, cause: 'event' }, apiTarget('POST', '/api/sessions'))!, /조회만/);
  assert.equal(refusalFor(guards, { ...owner, cause: 'event' }, apiTarget('GET', '/api/snapshot')), undefined);
  assert.match(refusalFor(guards, owner, apiTarget('POST', '/api/sessions', NODE))!, /읽기 전용/);
  assert.equal(refusalFor(guards, owner, apiTarget('GET', '/api/snapshot', NODE)), undefined);
  assert.equal(refusalFor(guards, { ...owner, irreversible: 1 }, apiTarget('POST', '/api/runs/r/cancel')), undefined);
  assert.match(refusalFor(guards, { ...owner, irreversible: 2 }, apiTarget('POST', '/api/runs/r/cancel'))!, /2개까지/);
  assert.equal(refusalFor(guards, { ...owner, irreversible: 2 }, apiTarget('POST', '/api/sessions')), undefined, 'undoable changes are not counted');
});

test('keys the owner pastes reach the model only as references, and go back into requests just before sending', () => {
  const vault = new SecretVault();
  const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  const hidden = vault.hide(`use ${key} for jev_abcdefghijklmnopqrstuv too`);
  assert.doesNotMatch(hidden, /abcdefghijklmnop/);
  const ref = /\{\{secret:[a-f0-9]{16}\}\}/.exec(hidden)![0];
  assert.deepEqual(vault.reveal({ apiKey: ref, features: {} }, '/api/decisions/settings'), { apiKey: key, features: {} });
  assert.deepEqual(vault.reveal({ secret: { name: 'Auth', origin: 'https://api.example.com', value: `Bearer ${ref}` } }, `/api/nodes/${NODE}/v1/secrets.create`),
    { secret: { name: 'Auth', origin: 'https://api.example.com', value: `Bearer ${key}` } });
  assert.throws(() => vault.reveal({ apiKey: '{{secret:0000000000000000}}' }, '/api/decisions/settings'), { statusCode: 400 });
  // Only each request's own secret fields take one back: never a title, a prompt, or a secret's name or address,
  // which Tower keeps and shows openly.
  assert.throws(() => vault.reveal({ title: ref }, '/api/sessions/s/title'), /비밀 값을 넣을 칸이 없습니다/);
  assert.throws(() => vault.reveal({ secret: { name: ref, origin: 'https://a.example', value: 'x' } }, '/api/v1/secrets.create'), /secret\.value/);
  assert.throws(() => vault.reveal({ secret: { name: 'n', origin: `https://${ref}.example`, value: 'x' } }, '/api/v1/secrets.create'), /secret\.value/);
  // A join code is secret by nature, here and on a joined computer.
  const invite = vault.hideInResponse(`/api/nodes/${NODE}/link/invite`, { id: 'i', code: 'JOIN-CODE-123', command: 'tower join JOIN-CODE-123', expiresAt: 1 }) as Record<string, string>;
  assert.match(invite.code, /^\{\{secret:/);
  assert.match(invite.command, /^\{\{secret:/);
  assert.equal(invite.id, 'i');
});

test('kept values stay hidden for as long as the host runs, without ever changing a reference or leaving part of a longer value', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-28T00:00:00Z') });
  const vault = new SecretVault();
  const short = vault.reference('hunter2-correct');
  const long = vault.reference('hunter2-correct-horse');
  const odd = vault.reference('{{secret:');
  assert.equal(vault.redact('a hunter2-correct-horse b hunter2-correct c'), `a ${long} b ${short} c`);
  // A reference already in the text is left whole, even when a kept value is part of it.
  assert.equal(vault.redact(`use ${odd} here`), `use ${odd} here`);
  // Past the time a reference may be used, the value is still hidden wherever it shows up.
  t.mock.timers.setTime(Date.parse('2026-09-28T01:00:00Z'));
  assert.equal(vault.hide('printed hunter2-correct-horse again'), `printed ${long} again`);
  assert.throws(() => vault.reveal({ password: long }, '/api/public-agents/password'), /만료/);
});

test('a value the owner gave stays hidden however many keys pass by, is hidden whole before formats are looked for, and hiding stays fast', () => {
  const vault = new SecretVault();
  const password = vault.reference('card-password-never-public');
  const tricky = vault.reference(`prefix-sk-${'a'.repeat(24)}-password!tail`);
  const started = Date.now();
  // Many different keys in a large answer (a lookup table, say): each is hidden, none pushes the owner's values out.
  for (let index = 0; index < 3000; index++) assert.doesNotMatch(vault.hide(`row ${index}: sk-proj-${String(index).padStart(6, '0')}${'k'.repeat(480)}`), /sk-proj-/);
  assert.ok(Date.now() - started < 3000, `hiding 3000 rows took ${Date.now() - started} ms`);
  assert.equal(vault.hide('login with card-password-never-public'), `login with ${password}`);
  assert.equal(vault.hide(`x prefix-sk-${'a'.repeat(24)}-password!tail y`), `x ${tricky} y`);
});
