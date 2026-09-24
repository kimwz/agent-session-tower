import test from 'node:test';
import assert from 'node:assert/strict';
import { failedAgain, parseRetry, retryDelay, retryDue } from '../../../server/updates/schedule.js';
import { LatestReleases } from '../../../server/updates/latest.js';

const HOUR = 60 * 60_000;

test('a failed version is tried again after 1, 2, 4, 8 and 16 hours, then daily, and a newer version starts over', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(retryDelay), [1, 2, 4, 8, 16, 24, 24].map(hours => hours * HOUR));
  const start = Date.parse('2026-09-24T00:00:00Z');
  let record = failedAgain(undefined, '1.32.0', start);
  assert.deepEqual(record, { version: '1.32.0', attempts: 1, nextAt: new Date(start + HOUR).toISOString() });
  assert.equal(retryDue(record, '1.32.0', start + HOUR - 1), false);
  assert.equal(retryDue(record, '1.32.0', start + HOUR), true);
  record = failedAgain(record, '1.32.0', start + HOUR);
  assert.equal(record.attempts, 2);
  assert.equal(record.nextAt, new Date(start + 3 * HOUR).toISOString());
  assert.equal(retryDue(record, '1.33.0', start), true, 'another version is not held back');
  assert.equal(failedAgain(record, '1.33.0', start).attempts, 1);
  assert.deepEqual(parseRetry(record), record);
  for (const broken of [undefined, {}, { ...record, version: 'v1' }, { ...record, attempts: 0 }, { ...record, nextAt: 'soon' }]) assert.equal(parseRetry(broken), undefined);
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const asset = (version: string) => ({ name: `agent-session-tower-${version}.tgz`, state: 'uploaded' });

test('the latest release comes from the API only once its package is published, and never from a draft or prerelease', async () => {
  const answers = [
    { tag_name: 'v1.32.0', draft: false, prerelease: false, assets: [asset('1.32.0')] },
    { tag_name: 'v1.33.0', draft: false, prerelease: false, assets: [] },
    { tag_name: 'v1.33.0', draft: true, assets: [asset('1.33.0')] },
    { tag_name: 'v1.33.0-rc.1', assets: [asset('1.33.0-rc.1')] },
  ];
  const seen: Array<string | undefined> = [];
  for (const answer of answers) {
    let clock = 0;
    const latest = new LatestReleases({ now: () => clock, fetch: async (url, init) => url.toString().includes('api.github.com') ? json(answer) : new Response(null, { status: 404 }), published: async () => false });
    seen.push((await latest.latest())?.version);
    clock += 1;
  }
  assert.deepEqual(seen, ['1.32.0', undefined, undefined, undefined]);
});

test('when the API is unavailable the release page redirect names the latest, if its package is there; answers are kept ten minutes', async () => {
  let clock = 0;
  let calls = 0;
  const latest = new LatestReleases({ now: () => clock, published: async version => version === '1.32.0',
    fetch: async (url, init) => {
      calls++;
      if (url.toString().includes('api.github.com')) return json({ message: 'API rate limit exceeded' }, 403);
      assert.equal(init?.method, 'HEAD');
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://github.com/kimwz/agent-session-tower/releases/tag/v1.32.0' } });
    } });
  assert.deepEqual(await latest.latest(), { version: '1.32.0', checkedAt: new Date(0).toISOString(), source: 'redirect' });
  clock += 9 * 60_000;
  await latest.latest();
  assert.equal(calls, 2, 'a cached answer asks nothing');
  clock += 2 * 60_000;
  await latest.latest();
  assert.equal(calls, 4);
  const unpublished = new LatestReleases({ published: async () => false, fetch: async url => url.toString().includes('api.github.com') ? json({}, 500)
    : new Response(null, { status: 302, headers: { location: 'https://github.com/kimwz/agent-session-tower/releases/tag/v1.40.0' } }) });
  assert.equal(await unpublished.latest(), undefined);
});
