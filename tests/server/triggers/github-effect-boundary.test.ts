import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAccess } from '../../../server/triggers/github-access.js';
import { RequestBudget } from '../../../server/triggers/outbound.js';
import type { SecretStore } from '../../../server/triggers/secrets.js';

for (const change of ['hold', 'grant', 'identity'] as const) test(`DNS preparation ${change} refuses GitHub effect`, async () => {
  let held = false, granted = true, value = 'fixture-token';
  const budget = new RequestBudget();
  const access = new GitHubAccess({
    secrets: { get: () => ({ id: 's', origin: 'https://api.github.com', value }) } as unknown as SecretStore,
    budget, grants: () => ({ s: granted ? ['trigger'] : [] }), now: Date.now, transport: () => undefined,
    resolve: (async () => {
      if (change === 'hold') held = true;
      if (change === 'grant') granted = false;
      if (change === 'identity') value = 'changed-fixture-token';
      return [{ address: '140.82.112.6', family: 4 }];
    }) as never,
  });
  const { fetch } = await access.fetchFor({ type: 'token', secretId: 's' }, 'trigger', async () => { if (held) throw new Error('fixture hold'); });
  await assert.rejects(fetch('/repos/fixture/repo/issues', undefined, { method: 'POST', body: {} }), { uncertain: false });
  assert.equal(budget.sentSince(0), 0, 'beforeSend refuses before request creation/budget spend');
});

test('each later page checks current policy before its transport effect', async () => {
  let held = false, effects = 0;
  const access = new GitHubAccess({
    secrets: { get: () => ({ id: 's', origin: 'https://api.github.com', value: 'fixture-token' }) } as unknown as SecretStore,
    budget: new RequestBudget(), grants: () => ({ s: ['trigger'] }), now: Date.now,
    transport: () => () => async () => { effects++; held = true; return { status: 200, body: Array(100).fill({}) }; },
  });
  const { fetch } = await access.fetchFor({ type: 'token', secretId: 's' }, 'trigger', async () => { if (held) throw new Error('fixture policy hold'); });
  await fetch('/comments?page=1'); effects = 0;
  await assert.rejects(fetch('/comments?page=2'), /policy hold/);
  assert.equal(effects, 0);
});
