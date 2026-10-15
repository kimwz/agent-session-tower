import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { externalStorageFixture } from './external-storage-fixture.js';
import { canonical } from '../../../server/remote/storage-rows.js';
import { FENCE_ATTEMPTS } from '../../../server/remote/storage-row-repository.js';

/**
 * Fenced reads run outside the repository's write queue (Slack and GitHub share one WorkflowRepository). A write that
 * commits between head() and the fenced read moves the revision; the read restarts instead of failing the caller.
 * The hook below runs a real update() in that gap, so every case is deterministic.
 */
type Read = (domain: string, command: string, payload: unknown) => Promise<unknown>;
async function setup(t: TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-row-fence-'));
  const fixture = await externalStorageFixture(undefined, stateDir, true, 'normal', false);
  t.after(async () => { await fixture.storage.close(); await rm(stateDir, { recursive: true, force: true }); });
  const storage = fixture.storage as unknown as { read: Read }, original: Read = storage.read.bind(storage);
  const calls: string[] = [];
  let before: (command: string) => Promise<void> = async () => {};
  storage.read = async (domain, command, payload) => { calls.push(command); await before(command); return original(domain, command, payload); };
  let written = 0;
  const write = () => { const id = `fence-${written}`, rule = { id, name: 'fixture', enabled: true, condition: 'PR', instructions: 'review', replyInstructions: 'propose', provider: 'codex' };
    return fixture.workflows.update([{ channel: 'github', kind: 'rule', id, ordinal: written++, json: canonical(rule), previous: null }]); };
  return { ...fixture, calls, write, hook: (fn: typeof before) => { before = fn; calls.length = 0; }, revision: async () => (await fixture.workflows.head()).revision };
}

test('a write committing inside a fenced read restarts the read, which then succeeds', async t => {
  const f = await setup(t);
  const once = (command: string) => { let fired = false; f.hook(async seen => { if (seen === command && !fired) { fired = true; await f.write(); } }); };
  for (const [command, read] of [
    ['capacity', () => f.workflows.capacity('slack')],
    ['unfinished', () => f.workflows.unfinished('slack')],
    ['foreignUnfinished', () => f.workflows.assertAccountTeam('slack', 'T')],
    ['keys', () => f.workflows.loadRows()],
  ] as const) {
    const before = await f.revision();
    once(command);
    await read();
    assert.equal(await f.revision(), before! + 1, command);
    assert.equal(f.calls.filter(c => c === command).length > 1, true, `${command} was retried`);
  }
  // The final head check of loadRows: a write after the last chunk, before the closing head().
  let chunks = false, fired = false;
  f.hook(async command => { if (command === 'chunk') chunks = true; else if (command === 'head' && chunks && !fired) { fired = true; await f.write(); } });
  const rows = await f.workflows.loadRows();
  assert.equal(fired, true);
  assert.deepEqual(rows.filter(row => row.channel === 'github' && row.kind === 'rule').map(row => row.id), Array.from({ length: 5 }, (_, i) => `fence-${i}`));
});

test('only a moved fence is retried, and at most three attempts in total', async t => {
  const f = await setup(t);
  // A write before every attempt: the last fence failure propagates after FENCE_ATTEMPTS tries.
  f.hook(async command => { if (command === 'capacity') await f.write(); });
  await assert.rejects(f.workflows.capacity('slack'), { name: 'StorageCommandError', message: 'External authority/revision/generation changed.' });
  assert.equal(f.calls.filter(c => c === 'capacity').length, FENCE_ATTEMPTS);
  assert.equal(FENCE_ATTEMPTS, 3);
  // Any other refusal, even a domain failure, is not retried.
  f.hook(async command => { if (command === 'unfinished') throw Object.assign(new Error('Missing external row.'), { name: 'StorageCommandError', code: 'domain-failed' }); });
  await assert.rejects(f.workflows.unfinished('slack'), { message: 'Missing external row.' });
  assert.equal(f.calls.filter(c => c === 'unfinished').length, 1);
});
