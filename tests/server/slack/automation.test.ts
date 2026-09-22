import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SlackAutomationManager, type SlackAutomationOptions } from '../../../server/slack/automation.js';
import type { SlackMention, SlackRule } from '../../../shared/slack.js';
import type { AutoPromptJob, AutoPromptRequest, Run } from '../../../shared/types.js';

const rule: SlackRule = { id: 'review', name: 'PR review', enabled: true, condition: 'Verse8 PR review requested', instructions: 'Review the PR', replyInstructions: 'Confirm only a finished review', provider: 'codex' };
const mention: SlackMention = { id: 'event-1', teamId: 'T1', channel: 'C1', user: 'U2', ts: '1.1', threadTs: '1.0', text: '<@U1> review this Verse8 PR' };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-slack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let job: AutoPromptJob | undefined;
  let run: Run = { id: 'run', sessionId: 'session', prompt: '', status: 'running', createdAt: '', output: 'Review finished with no findings.' };
  let sends = 0, submissions = 0, fetches = 0;
  const submitted: AutoPromptRequest[] = [];
  const options: SlackAutomationOptions = {
    stateDir: directory,
    fetchThread: async () => { fetches++; return [{ user: 'U2', ts: '1.0', text: 'Review PR 5 for Verse8' }]; },
    match: async () => ({ ruleId: 'review', reason: 'PR review request' }),
    submitAutoPrompt: async input => { submissions++; submitted.push(input); job = { id: input.requestId, provider: input.provider, prompt: input.prompt, routerModel: 'test', status: 'completed', createdAt: '', updatedAt: '', runId: run.id, sessionId: run.sessionId }; return job; },
    getAutoPrompt: () => job,
    getRun: () => run,
    composeReply: async input => { assert.equal(input.output, run.output); return { text: '확인 했습니다.' }; },
    sendReply: async () => { sends++; return { ts: '2.0' }; },
  };
  const manager = new SlackAutomationManager(options); await manager.start(); await manager.setRules([rule]);
  return { manager, options, directory, submitted, counts: () => ({ sends, submissions, fetches }), finish: (status: Run['status'] = 'completed') => { run = { ...run, status }; } };
}
test('Slack Codex work always requests Auto approval review while Claude retains its permission flow', async t => {
  for (const provider of ['codex', 'claude'] as const) {
    const f = await fixture(t);
    await f.manager.setRules([{ ...rule, provider }]);
    await f.manager.ingest(mention); await f.manager.tick();
    assert.equal(f.submitted.length, 1);
    assert.equal(f.submitted[0].codexApprovalsReviewer, provider === 'codex' ? 'auto_review' : undefined);
  }
});
test('admission does no network/model work; dedup and actual execution completion gate reply', async t => {
  const f = await fixture(t);
  await Promise.all([f.manager.ingest(mention), f.manager.ingest(mention)]);
  assert.deepEqual(f.counts(), { sends: 0, submissions: 0, fetches: 0 });
  await f.manager.tick();
  assert.equal(f.manager.list()[0].status, 'running'); assert.equal(f.counts().sends, 0);
  f.finish(); await f.manager.tick(); await f.manager.ingest(mention); await f.manager.tick();
  assert.deepEqual(f.counts(), { sends: 1, submissions: 1, fetches: 1 });
  assert.equal(f.manager.list()[0].status, 'completed');
});
test('rule snapshots remain immutable after settings change and restart', async t => {
  const f = await fixture(t); await f.manager.ingest(mention);
  await f.manager.setRules([{ ...rule, instructions: 'Changed instruction' }]);
  const restarted = new SlackAutomationManager(f.options); await restarted.start(); await restarted.tick();
  assert.equal(restarted.list()[0].rule?.instructions, 'Review the PR');
  assert.ok(restarted.list()[0].prompt?.includes('Do not send Slack messages yourself'));
  f.finish(); await restarted.tick(); assert.equal(f.counts().submissions, 1);
});
test('unknown rule IDs and unmatched events never dispatch', async t => {
  const f = await fixture(t); f.options.match = async () => ({ ruleId: 'invented', reason: 'bad' });
  await f.manager.ingest(mention); await f.manager.tick();
  assert.equal(f.manager.list()[0].status, 'error'); assert.equal(f.counts().submissions, 0);
  f.options.match = async () => ({ ruleId: null, reason: 'not applicable' });
  await f.manager.ingest({ ...mention, id: 'event-2' }); await f.manager.tick();
  assert.equal(f.manager.list()[1].status, 'ignored'); assert.equal(f.counts().submissions, 0);
});
test('failed and cancelled execution never posts success replies', async t => {
  for (const status of ['error', 'cancelled'] as const) {
    const f = await fixture(t); await f.manager.ingest(mention); f.finish(status); await f.manager.tick();
    assert.equal(f.manager.list()[0].status, 'error'); assert.equal(f.counts().sends, 0);
  }
});
test('uncertain sends are not retried, including restart during sending', async t => {
  const f = await fixture(t); let attempts = 0;
  f.options.sendReply = async () => { attempts++; throw new Error('connection lost after acceptance'); };
  await f.manager.ingest(mention); f.finish(); await f.manager.tick(); await f.manager.tick();
  assert.equal(attempts, 1); assert.equal(f.manager.list()[0].status, 'reply-uncertain');
  const path = join(f.directory, 'slack-automation.json');
  const saved = JSON.parse(await readFile(path, 'utf8')); saved.workflows[0].status = 'sending';
  await writeFile(path, JSON.stringify(saved));
  const restarted = new SlackAutomationManager(f.options); await restarted.start(); await restarted.tick();
  assert.equal(attempts, 1); assert.equal(restarted.list()[0].status, 'reply-uncertain');
});
test('read failure and unconfirmed completion fail closed without posting', async t => {
  const f = await fixture(t); f.options.fetchThread = async () => { throw new Error('rate limited'); };
  await f.manager.ingest(mention); await f.manager.tick(); await f.manager.tick();
  assert.equal(f.manager.list()[0].status, 'error'); assert.equal(f.counts().submissions, 0);
  f.options.fetchThread = async () => [{ user: 'U2', ts: '1.0', text: 'PR' }];
  f.options.composeReply = async () => ({ text: '' }); f.finish();
  await f.manager.ingest({ ...mention, id: 'event-2' }); await f.manager.tick();
  assert.equal(f.manager.list()[1].status, 'error'); assert.equal(f.counts().sends, 0);
});
test('large terminal history compacts below restart limit while retaining dedup IDs', async t => {
  const f = await fixture(t); await f.manager.ingest(mention); f.finish(); await f.manager.tick();
  const path = join(f.directory, 'slack-automation.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.workflows[0].mention.text = ' '.repeat(600) + mention.text;
  saved.workflows[0].thread = Array.from({ length: 900 }, (_, i) => ({ user: 'U2', ts: String(i), text: 'a'.repeat(12_000) }));
  await writeFile(path, JSON.stringify(saved));
  const restarted = new SlackAutomationManager(f.options); await restarted.start();
  assert.ok(Buffer.byteLength(await readFile(path, 'utf8')) < 10_000_000);
  assert.equal(restarted.list()[0].thread, undefined);
  await restarted.ingest(mention); await restarted.tick();
  assert.equal(restarted.list().length, 1); assert.equal(f.counts().submissions, 1);
  const again = new SlackAutomationManager(f.options); await again.start();
  assert.equal(again.list()[0].status, 'completed');
});
test('storage limit preserves unfinished context and refuses oversized rule configuration', async t => {
  const f = await fixture(t); await f.manager.ingest(mention); await f.manager.tick();
  const path = join(f.directory, 'slack-automation.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.workflows[0].thread = Array.from({ length: 900 }, (_, i) => ({ user: 'U2', ts: String(i), text: 'a'.repeat(12_000) }));
  const original = JSON.stringify(saved); await writeFile(path, original);
  const restarted = new SlackAutomationManager(f.options);
  await assert.rejects(restarted.start(), /저장 용량/);
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(f.manager.setRules(Array.from({ length: 20 }, (_, i) => ({ ...rule, id: String(i), instructions: 'a'.repeat(8000) }))), /100 KB/);
  assert.deepEqual(f.manager.rules(), [rule]);
});
test('overbudget event admission rolls back and remains unacknowledged', async t => {
  const f = await fixture(t); await f.manager.ingest(mention); await f.manager.tick();
  const path = join(f.directory, 'slack-automation.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.workflows[0].thread = Array.from({ length: 250 }, (_, i) => ({ user: 'U2', ts: String(i), text: 'a'.repeat(39_800) }));
  saved.workflows[0].thread.push({ user: 'U2', ts: 'last', text: '' });
  const padding = 9_990_000 - Buffer.byteLength(JSON.stringify(saved));
  assert.ok(padding > 0 && padding < 40_000);
  saved.workflows[0].thread.at(-1).text = 'a'.repeat(padding);
  await writeFile(path, JSON.stringify(saved));
  const restarted = new SlackAutomationManager(f.options); await restarted.start();
  await assert.rejects(restarted.ingest({ ...mention, id: 'too-large', text: 'b'.repeat(40_000) }), /저장 용량/);
  assert.equal(restarted.list().length, 1);
  const again = new SlackAutomationManager(f.options); await again.start();
  assert.equal(again.list().length, 1); assert.equal(again.list()[0].thread?.length, 251);
});
