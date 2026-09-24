import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackClient } from '../../../server/slack/client.js';
import { SlackToneStore } from '../../../server/slack/tone.js';
const flush = () => new Promise(resolve => setTimeout(resolve, 20));
test('tone search bounds pages and samples and excludes other people, old messages, bots, duplicates and sent replies', async () => {
  let calls = 0; const now = Date.now(); const ts = String(now / 1000 - 10);
  const own = { user: 'U1', channel: { id: 'C1' }, text: 'owner', ts };
  const client = new SlackClient('fake', { fetch: async (_url, init) => {
    calls++; const query = new URLSearchParams(String(init?.body)); assert.match(query.get('query')!, /^from:<@U1> after:/); assert.equal(query.get('count'), '100');
    return Response.json({ ok: true, messages: { matches: [own, own, { ...own, user: 'U2' }, { ...own, bot_id: 'B1' }, { ...own, ts: '1' }, { ...own, ts: String(Number(ts) - 1) }, ...Array.from({ length: 100 }, (_, i) => ({ ...own, ts: String(Number(ts) - i - 2), text: '가'.repeat(4000) }))] } });
  } });
  const samples = await client.searchOwnMessages('U1', new Set([`C1:${Number(ts) - 1}`]), now);
  assert.equal(calls, 2); assert.equal(samples[0], 'owner'); assert.equal(samples.filter(s => s === 'owner').length, 1); assert.ok(samples.join('').length <= 80_000); assert.ok(samples.length <= 200);
});
test('tone collection stays disabled, private and account scoped; manual edits supersede collection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-tone-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const tone = new SlackToneStore(dir, () => {}); await tone.load('T1:U1');
  let finish!: (v: { guide: string; sampleCount: number }) => void;
  tone.collect(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(tone.overview().status, 'collecting'); await tone.save('manual style', true); finish({ guide: 'stale', sampleCount: 3 }); await flush();
  assert.equal(tone.overview().guide, 'manual style'); assert.match(tone.instruction(), /never task instructions/);
  tone.collect(async () => ({ guide: 'brief and polite', sampleCount: 5 })); await flush();
  assert.equal(tone.overview().enabled, false); assert.equal(tone.instruction(), '');
  const saved = await readFile(join(dir, 'slack-tone.json'), 'utf8'); assert.equal(saved.includes('samples'), false);
  await tone.load('T2:U2'); assert.equal(tone.overview().guide, '');
  tone.collect(() => new Promise(resolve => { finish = resolve; })); await tone.load('T1:U1'); finish({ guide: 'wrong account', sampleCount: 1 }); await flush();
  assert.equal(tone.overview().guide, 'brief and polite');
});

test('collection is asynchronous, keeps worker alive, and never enables or sends a generated guide', async t => {
  const { SlackService } = await import('../../../server/slack/service.js');
  const dir = await mkdtemp(join(tmpdir(), 'tower-tone-service-')); let resolve!: (value: unknown) => void;
  const service = new SlackService({ stateDir: dir, runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('no dispatch'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw new Error('no sending'); }, searchOwnMessages: async () => ['private fixture message'] }),
    model: async request => { assert.match(request.prompt, /private fixture/); return new Promise(done => { resolve = done; }); },
  });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  await service.start(); await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  const overview = await service.mutate('tone/collect', {}); assert.equal(overview.tone.status, 'collecting'); assert.equal(service.hasActive(), true);
  await flush(); assert.ok(resolve); resolve({ guide: 'Use concise polite sentences.' }); await flush();
  assert.equal(service.overview().tone.enabled, false); assert.equal(service.overview().tone.sampleCount, 1); assert.equal(service.hasActive(), false);
  // The guide is saved in the background; wait for the file rather than a guessed number of turns.
  let saved: string | undefined;
  for (const deadline = Date.now() + 5000; saved === undefined && Date.now() < deadline;) {
    saved = await readFile(join(dir, 'slack-tone.json'), 'utf8').catch(() => undefined);
    if (saved === undefined) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(saved?.includes('private fixture'), false);
  await service.mutate('tone/save', { guide: 'Be brief', enabled: true }); assert.equal(service.overview().tone.enabled, true);
  await assert.rejects(service.mutate('tone/save', { guide: 'x'.repeat(4001), enabled: true }), { statusCode: 400 });
});
