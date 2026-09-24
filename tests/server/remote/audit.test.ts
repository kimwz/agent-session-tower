import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAudit } from '../../../server/remote/audit.js';

test('changes from controlling computers are kept privately, newest first, up to a thousand', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-remote-audit-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-24T00:00:00.000Z');
  const audit = new RemoteAudit(stateDir, () => clock++);
  await audit.start();
  audit.record({ controllerId: 'controllera1b2c3d4e5f6', action: 'joined' });
  for (let index = 0; index < 1005; index++) audit.record({ controllerId: 'controllera1b2c3d4e5f6', action: 'file', target: `/work/app/file-${index}.ts` });
  await audit.flush();
  const again = new RemoteAudit(stateDir);
  await again.start();
  assert.equal(again.list(2000).length, 1000);
  assert.equal(again.list(1)[0].target, '/work/app/file-1004.ts');
  assert.equal(again.lastJoin(), undefined, 'the oldest go first, the join among them');
  assert.equal((await stat(join(stateDir, 'link', 'remote-changes.json'))).mode & 0o777, 0o600);
  audit.record({ controllerId: 'controllerffffffffffff', action: 'joined' });
  assert.equal(audit.lastJoin()?.controllerId, 'controllerffffffffffff');
});
