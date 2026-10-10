import test from 'node:test';
import assert from 'node:assert/strict';
import { JevEngine } from '../../../server/decisions/jev.js';
import { judgeSlackFollowUp } from '../../../server/slack/follow-up.js';

test('hold during engine preparation prevents the actual decision POST', async () => {
  let effects = 0, held = false;
  const prepare = async () => {
    await Promise.resolve(); held = true;
    return new JevEngine('fixture-key', (async () => { effects++; throw new Error('must not send'); }) as typeof fetch);
  };
  const engine = await prepare();
  const message = { user: 'U2', ts: '2', text: 'please check' };
  await assert.rejects(judgeSlackFollowUp(engine, { owner: 'U1', request: { ...message, ts: '1' }, thread: [], message }, undefined,
    async () => { if (held) throw new Error('fixture storage/history hold'); }), /storage\/history hold/);
  assert.equal(effects, 0);
});
