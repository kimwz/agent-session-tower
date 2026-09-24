import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAudit } from '../../../server/remote/audit.js';

const A = 'controllera1b2c3d4e5f6', B = 'controllerffffffffffff';

test('changes from controlling computers are kept privately, newest first, up to a thousand, and the latest join apart', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-remote-audit-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-24T00:00:00.000Z');
  const names = new Map([[A, 'Office Mac']]);
  const audit = new RemoteAudit(stateDir, { now: () => clock++, name: id => names.get(id) });
  await audit.start();
  audit.record({ controllerId: A, action: 'joined' });
  for (let index = 0; index < 1005; index++) audit.record({ controllerId: A, action: 'file', target: `/work/app/file-${index}.ts` });
  await audit.flush();
  names.delete(A);
  const again = new RemoteAudit(stateDir);
  await again.start();
  assert.equal(again.list().length, 1000, 'all that is kept can be read');
  assert.equal(again.list()[0].target, '/work/app/file-1004.ts');
  assert.equal(again.list()[0].controller, 'Office Mac', 'named as it was when it made the change, after it is released');
  assert.equal(again.lastJoin()?.controllerId, A, 'newer changes never push the join out');
  assert.equal((await stat(join(stateDir, 'link', 'remote-changes.json'))).mode & 0o777, 0o600);
  audit.record({ controllerId: B, action: 'joined' });
  assert.equal(audit.lastJoin()?.controllerId, B);
});

test('a request sent again is recorded once, and its ID is not shown', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-remote-audit-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const audit = new RemoteAudit(stateDir);
  await audit.start();
  const request = '0199a2b3-c4d5-7123-8abc-0123456789ab';
  audit.record({ controllerId: A, action: 'message', session: 'codex:s', target: '/work/app' }, request);
  audit.record({ controllerId: A, action: 'message', session: 'codex:s', target: '/work/app' }, request);
  audit.record({ controllerId: B, action: 'message', session: 'codex:s', target: '/work/app' }, request);
  audit.record({ controllerId: A, action: 'title', session: 'codex:s', target: '/work/app' });
  audit.record({ controllerId: A, action: 'title', session: 'codex:s', target: '/work/app' });
  assert.deepEqual(audit.list().map(change => `${change.controllerId === A ? 'A' : 'B'} ${change.action}`), ['A title', 'A title', 'B message', 'A message']);
  assert.ok(!JSON.stringify(audit.list()).includes(request));
});

test('a record that cannot be read is set aside, and one that cannot be saved never stops Tower', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-remote-audit-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(join(stateDir, 'link'), { mode: 0o700 });
  await writeFile(join(stateDir, 'link', 'remote-changes.json'), '{ not json', { mode: 0o600 });
  const errors: string[] = [];
  const log = console.error;
  console.error = (message: string) => { errors.push(message); };
  t.after(() => { console.error = log; });
  const audit = new RemoteAudit(stateDir);
  await audit.start();
  assert.deepEqual(audit.list(), []);
  assert.equal(await readFile(join(stateDir, 'link', 'remote-changes.json.unreadable'), 'utf8'), '{ not json');
  audit.record({ controllerId: A, action: 'file', target: '/work/app/a.ts' });
  await audit.flush();
  const reread = new RemoteAudit(stateDir);
  await reread.start();
  assert.equal(reread.list().length, 1, 'a new record starts in its place');

  const blocked = await mkdtemp(join(tmpdir(), 'tower-remote-audit-'));
  t.after(() => rm(blocked, { recursive: true, force: true }));
  await writeFile(join(blocked, 'link'), 'a file where the folder goes');
  const unsaved = new RemoteAudit(blocked);
  await unsaved.start();
  unsaved.record({ controllerId: A, action: 'file', target: '/work/app/a.ts' });
  await unsaved.flush();
  assert.equal(unsaved.list().length, 1, 'kept while Tower runs');
  assert.ok(errors.some(message => /will not be saved/.test(message)));
});

test('a request is remembered as long as it can be sent again, even after its change leaves the list', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-remote-audit-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-24T00:00:00.000Z');
  const audit = new RemoteAudit(stateDir, { now: () => clock });
  await audit.start();
  const request = '0199a2b3-c4d5-7123-8abc-0123456789ab';
  audit.record({ controllerId: A, action: 'session', session: 'codex:s', target: '/work/app' }, request);
  for (let index = 0; index < 1000; index++) audit.record({ controllerId: A, action: 'file', target: `/work/app/${index}.ts` });
  await audit.flush();
  const restarted = new RemoteAudit(stateDir, { now: () => clock });
  await restarted.start();
  restarted.record({ controllerId: A, action: 'session', session: 'codex:s', target: '/work/app' }, request);
  assert.ok(!restarted.list().some(change => change.action === 'session'), 'pushed out of the list, still known');
  clock += 8 * 24 * 60 * 60 * 1000;
  restarted.record({ controllerId: A, action: 'session', session: 'codex:s', target: '/work/app' }, request);
  assert.equal(restarted.list()[0].action, 'session', 'a request is not sent again after a week');
  // A controlling computer's clock ahead of this one keeps its request known longer, as the request ledger does.
  const ahead = `${(clock + 12 * 60 * 60 * 1000).toString(16).padStart(12, '0').replace(/^(.{8})(.{4})$/, '$1-$2')}-7123-8abc-0123456789ac`;
  restarted.record({ controllerId: A, action: 'title', session: 'codex:s', target: '/work/app' }, ahead);
  clock += 7 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000;
  restarted.record({ controllerId: A, action: 'title', session: 'codex:s', target: '/work/app' }, ahead);
  assert.equal(restarted.list().filter(change => change.action === 'title').length, 1);
  await restarted.flush();
});

test('requests still inside their window are never forgotten to make room', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-remote-audit-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const audit = new RemoteAudit(stateDir);
  await audit.start();
  const id = (index: number) => `0199a2b3-c4d5-7123-8abc-${index.toString(16).padStart(12, '0')}`;
  for (let index = 0; index < 20_001; index++) audit.record({ controllerId: A, action: 'file', target: '/work/app/a.ts' }, id(index));
  audit.record({ controllerId: A, action: 'title', target: '/work/app' }, id(0));
  assert.notEqual(audit.list()[0].action, 'title', 'the first request is still known');
  await audit.flush();
});
