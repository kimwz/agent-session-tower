import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(f.counts(), { sends: 0, submissions: 1, fetches: 1 });
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
  const item = f.manager.list()[0];
  assert.equal(attempts, 0);
  await assert.rejects(f.manager.approveReply(item.id, item.replies![0].requestKey, item.replies![0].text), /connection lost/);
  assert.equal(attempts, 1); assert.equal(f.manager.list()[0].replies![0].status, 'uncertain');
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

test('conversation creates one native session, skips legacy matching and leaves replies to explicit tools', async t => {
  const f = await fixture(t); let creates = 0;
  f.options.startConversation = async (workflow, prompt) => { creates++; assert.equal(workflow.mode, 'conversation'); assert.match(prompt, /tower_auto_prompt/); return { sessionId: 'session', runId: 'run' }; };
  f.options.match = async () => { throw new Error('legacy classifier must not run'); };
  await f.manager.ingest(mention); await f.manager.tick(); await f.manager.tick();
  assert.equal(creates, 1); assert.equal(f.manager.list()[0].sessionId, 'session');
  f.finish(); await f.manager.tick();
  assert.equal(f.manager.list()[0].status, 'completed'); assert.equal(f.counts().sends, 0);
  const id = f.manager.list()[0].id;
  await Promise.all([f.manager.tool(id, 'slack_reply', { requestKey: 'reply-1', text: 'Done' }), f.manager.tool(id, 'slack_reply', { requestKey: 'reply-1', text: 'Done' })]);
  assert.equal(f.counts().sends, 0);
  await assert.rejects(f.manager.approveReply(id, 'reply-1', 'Changed'), /변경/);
  await assert.rejects(f.manager.tool(id, 'approveReply', { requestKey: 'reply-1', text: 'Done' }), /Unknown/);
  await Promise.all([f.manager.approveReply(id, 'reply-1', 'Done'), f.manager.approveReply(id, 'reply-1', 'Done')]);
  assert.equal(f.counts().sends, 1);
  await assert.rejects(f.manager.tool(id, 'slack_reply', { requestKey: 'reply-1', text: 'Other' }), /different text/);
});
test('conversation tools scope task reads and deduplicate delegation with Auto review', async t => {
  const f = await fixture(t); f.options.startConversation = async () => ({ sessionId: 'session', runId: 'run' });
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  const args = { requestKey: 'review', prompt: 'Review actual repo' };
  await Promise.all([f.manager.tool(id, 'tower_auto_prompt', args), f.manager.tool(id, 'tower_auto_prompt', args)]);
  assert.equal(f.counts().submissions, 1); assert.equal(f.submitted[0].codexApprovalsReviewer, 'auto_review');
  await assert.rejects(f.manager.tool(id, 'tower_task_status', { requestId: 'unrelated' }), /does not belong/);
  const status = await f.manager.tool(id, 'tower_task_status', { requestKey: 'review' }) as { run: { output: string } };
  assert.match(status.run.output, /Review finished/);
});
test('uncertain conversational send persists across restart and never resends', async t => {
  const f = await fixture(t); f.options.startConversation = async () => ({ sessionId: 'session', runId: 'run' });
  let attempts = 0; f.options.sendReply = async () => { attempts++; throw new Error('lost response'); };
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  await f.manager.tool(id, 'slack_reply', { requestKey: 'r', text: 'Result' });
  assert.equal(attempts, 0);
  await assert.rejects(f.manager.approveReply(id, 'r', 'Result'), /lost response/);
  const restarted = new SlackAutomationManager(f.options); await restarted.start();
  const result = await restarted.tool(id, 'slack_reply', { requestKey: 'r', text: 'Result' }) as { status: string };
  assert.equal(result.status, 'uncertain'); assert.equal(attempts, 1);
  await restarted.tool(id, 'slack_reply', { requestKey: 'other', text: 'Result' });
  await assert.rejects(restarted.approveReply(id, 'other', 'Result'), /불확실/);
  await assert.rejects(restarted.approveReply(id, 'r', 'Result'), /불확실/);
});
test('claimed conversation creation recovers correlated run without spawning twice', async t => {
  const f = await fixture(t); let attempts = 0;
  f.options.startConversation = async () => { attempts++; throw new Error('lost creation response'); };
  await f.manager.ingest(mention); await f.manager.tick();
  const path = join(f.directory, 'slack-automation.json'); const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.workflows[0].status = 'dispatching'; await writeFile(path, JSON.stringify(saved));
  f.options.findConversation = () => ({ sessionId: 'session', runId: 'run' });
  const restarted = new SlackAutomationManager(f.options); await restarted.start(); await restarted.tick();
  assert.equal(restarted.list()[0].sessionId, 'session'); assert.equal(attempts, 1);
});

test('delegated completion resumes an idle coordinator once and does not occupy its running turn', async t => {
  const f = await fixture(t);
  const coordinator: Run = { id: 'coordinator-1', sessionId: 'coordinator', prompt: '', status: 'running', createdAt: '', output: '' };
  const coordinatorRuns = [coordinator]; let resumes = 0;
  f.options.startConversation = async () => ({ sessionId: coordinator.sessionId, runId: coordinator.id });
  f.options.getSessionRuns = () => coordinatorRuns;
  f.options.resumeConversation = async (_workflow, prompt, correlationId) => {
    resumes++; assert.match(prompt, /Review finished/);
    const run: Run = { ...coordinator, id: 'notification', status: 'queued', autoPromptId: correlationId };
    coordinatorRuns.push(run); return { runId: run.id };
  };
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'review', prompt: 'Review PR' });
  f.finish(); await f.manager.tick(); assert.equal(resumes, 0, 'do not enqueue while coordinator is still active');
  coordinator.status = 'completed'; await f.manager.tick(); assert.equal(resumes, 1);
  await f.manager.tick(); assert.equal(resumes, 1);
  const restarted = new SlackAutomationManager(f.options); await restarted.start(); await restarted.tick();
  assert.equal(resumes, 1); assert.equal(restarted.list()[0].delegatedTasks?.[0].notifiedRunId, 'notification');
});

test('settled conversational ticks do not emit changes or rewrite history while delegation is pending', async t => {
  const f = await fixture(t);
  const coordinator: Run = { id: 'coordinator', sessionId: 'session', prompt: '', status: 'completed', createdAt: '', output: '' };
  f.options.startConversation = async () => ({ sessionId: coordinator.sessionId, runId: coordinator.id });
  f.options.getSessionRuns = () => [coordinator];
  await f.manager.ingest(mention); await f.manager.tick();
  const id = f.manager.list()[0].id;
  await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'pending', prompt: 'Review' });
  await f.manager.tick();
  let changes = 0; f.manager.on('change', () => { changes++; });
  const path = join(f.directory, 'slack-automation.json'); const before = await readFile(path, 'utf8');
  await f.manager.tick(); await f.manager.tick();
  assert.equal(changes, 0); assert.equal(await readFile(path, 'utf8'), before);
  assert.match(f.manager.list()[0].prompt!, /first whose condition clearly matches/);
});

test('rejected delegation becomes a durable visible error and the same key can retry successfully', async t => {
  const f = await fixture(t);
  const coordinator: Run = { id: 'coordinator', sessionId: 'session', prompt: '', status: 'completed', createdAt: '', output: '' };
  f.options.startConversation = async () => ({ sessionId: coordinator.sessionId, runId: coordinator.id });
  f.options.getSessionRuns = () => [coordinator];
  await f.manager.ingest(mention); await f.manager.tick(); await f.manager.tick(); const id = f.manager.list()[0].id;
  const submit = f.options.submitAutoPrompt;
  f.options.submitAutoPrompt = async () => { throw new Error('Queue full'); };
  const args = { requestKey: 'retry', prompt: 'Review' };
  await assert.rejects(f.manager.tool(id, 'tower_auto_prompt', args), /Queue full/);
  assert.equal(f.manager.list()[0].status, 'error'); assert.equal(f.manager.hasPending(), false);
  const restarted = new SlackAutomationManager(f.options); await restarted.start();
  assert.match(restarted.list()[0].delegatedTasks![0].submissionError!, /Queue full/);
  f.options.submitAutoPrompt = submit;
  await restarted.tool(id, 'tower_auto_prompt', args);
  assert.equal(restarted.list()[0].delegatedTasks![0].submissionError, undefined);
  assert.equal(restarted.list()[0].status, 'running');
  assert.equal(f.counts().submissions, 1);
});
test('delegated run survives pruned routing history without being submitted again', async t => {
  const f = await fixture(t); let resumes = 0;
  const coordinator: Run = { id: 'coordinator', sessionId: 'session', prompt: '', status: 'completed', createdAt: '', output: '' };
  f.options.startConversation = async () => ({ sessionId: coordinator.sessionId, runId: coordinator.id });
  f.options.getSessionRuns = () => [coordinator];
  f.options.resumeConversation = async () => { resumes++; return { runId: 'notification' }; };
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  const args = { requestKey: 'pruned', prompt: 'Review' };
  await f.manager.tool(id, 'tower_auto_prompt', args);
  f.options.getAutoPrompt = () => undefined; f.finish();
  await f.manager.tick(); assert.equal(resumes, 1);
  await assert.rejects(f.manager.tool(id, 'tower_auto_prompt', args), /refusing to submit/);
  assert.equal(f.counts().submissions, 1);
});

test('persisted legacy composing work produces only an approval proposal after restart', async t => {
  const f = await fixture(t); await f.manager.ingest(mention); await f.manager.tick(); f.finish();
  const path = join(f.directory, 'slack-automation.json'); const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.workflows[0].status = 'composing'; await writeFile(path, JSON.stringify(saved));
  const restarted = new SlackAutomationManager(f.options); await restarted.start(); await restarted.tick();
  const item = restarted.list()[0]; assert.equal(f.counts().sends, 0); assert.equal(item.replies![0].status, 'proposed');
  await restarted.approveReply(item.id, item.replies![0].requestKey, item.replies![0].text);
  assert.equal(f.counts().sends, 1);
});

test('approval fails closed before network when its durable send claim cannot be written', async t => {
  const f = await fixture(t); f.options.startConversation = async () => ({ sessionId: 'session', runId: 'run' });
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  await f.manager.tool(id, 'slack_reply', { requestKey: 'r', text: 'Exact reply' });
  const path = join(f.directory, 'slack-automation.json'); await rm(path); await mkdir(path);
  await assert.rejects(f.manager.approveReply(id, 'r', 'Exact reply'));
  assert.equal(f.counts().sends, 0);
  await assert.rejects(f.manager.approveReply(id, 'r', 'Exact reply'), /불확실/);
  assert.equal(f.counts().sends, 0);
});
