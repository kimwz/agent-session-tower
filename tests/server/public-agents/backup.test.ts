import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { restorePublicAgents } from '../../../server/public-agents/backup.js';

test('restored public agents sign out the visitors of an agent whose password, address or sharing changed; invalid ones are not taken', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-public-agents-backup-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  // An agent as Tower 1.106.0 saved it (tests/server/backup/fixtures).
  const released = JSON.parse(await readFile(join(import.meta.dirname, '../backup/fixtures/backup-1.106.0-once.payload.json'), 'utf8')).worker.files['public-agents.json'];
  const agent = released.agents[0];
  const visitors = [{ hash: 'h', authorized: true, conversationId: 'c', tag: 'T', createdAt: '', seenAt: '' }];
  await mkdir(join(stateDir, 'public-agents'));
  const data = join(stateDir, 'public-agents', `${agent.id}.json`);
  const reset = () => writeFile(data, JSON.stringify({ version: 1, conversations: [], requests: [], visitors }));
  const visitorsAfter = async () => JSON.parse(await readFile(data, 'utf8')).visitors;

  await reset();
  assert.equal(await restorePublicAgents(stateDir, released, released), released, 'the backup\'s agents are taken as they are');
  assert.deepEqual(await visitorsAfter(), visitors, 'an unchanged agent keeps its visitors');
  await restorePublicAgents(stateDir, { ...released, agents: [{ ...agent, password: { salt: 'other', hash: 'other' } }] }, released);
  assert.deepEqual(await visitorsAfter(), [{ ...visitors[0], authorized: false }]);
  await reset();
  await restorePublicAgents(stateDir, { ...released, agents: [{ ...agent, conversation: agent.conversation === 'visitor' ? 'shared' : 'visitor' }] }, released);
  assert.deepEqual(await visitorsAfter(), [{ hash: 'h', authorized: true, tag: 'T', createdAt: '', seenAt: '' }]);
  await reset();
  await restorePublicAgents(stateDir, { ...released, agents: [{ ...agent, slug: 'AAAAAAAAAAAAAAAAAAAAAA' }] }, released);
  assert.deepEqual(await visitorsAfter(), []);
  assert.equal(await restorePublicAgents(stateDir, { version: 2, agents: [] }, released), undefined);
});
