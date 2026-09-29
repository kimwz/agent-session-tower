/** An owner turn as the agent receives it: the message, then Tower's instructions. */
const chatText = (turn: { prompt: string; instructions?: string }) => `${turn.prompt}\n\n${turn.instructions ?? ''}`;
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SlackAutomationManager, type CoordinatorChannel, type SlackAutomationOptions } from '../../../server/slack/automation.js';
import type { SlackMention, SlackRule } from '../../../shared/slack.js';
import type { AutoPromptJob, AutoPromptRequest, Run } from '../../../shared/types.js';

const rule: SlackRule = { id: 'review', name: 'PR review', enabled: true, condition: 'Verse8 PR review requested', instructions: 'Review the PR', replyInstructions: 'Confirm only a finished review', provider: 'codex' };
const mention: SlackMention = { id: 'event-1', teamId: 'T1', channel: 'C1', user: 'U2', ts: '1.1', threadTs: '1.0', text: '<@U1> review this Verse8 PR' };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-slack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let job: AutoPromptJob | undefined;
  let run: Run = { id: 'run', sessionId: 'session', prompt: '', status: 'running', createdAt: '', output: 'Review finished with no findings.' };
  let sends = 0, autoSends = 0, submissions = 0, fetches = 0;
  const submitted: AutoPromptRequest[] = [];
  const options: SlackAutomationOptions = {
    stateDir: directory,
    fetchThread: async () => { fetches++; return [{ user: 'U2', ts: '1.0', text: 'Review PR 5 for Verse8' }]; },
    match: async () => ({ ruleId: 'review', reason: 'PR review request' }),
    submitAutoPrompt: async input => { submissions++; submitted.push(input); job = { id: input.requestId, provider: input.provider, prompt: input.prompt, routerModel: 'test', status: 'completed', createdAt: '', updatedAt: '', runId: run.id, sessionId: run.sessionId }; return job; },
    getAutoPrompt: () => job,
    getRun: () => run,
    composeReply: async input => { assert.equal(input.output, run.output); return { text: '확인 했습니다.' }; },
    sendReply: async (_mention, _text, _mentionable, automatic) => { sends++; autoSends += Number(automatic); return { ts: '2.0' }; },
  };
  const manager = new SlackAutomationManager(options); await manager.start(); await manager.setRules([rule]);
  return { manager, options, directory, submitted, counts: () => ({ sends, submissions, fetches }), autoSends: () => autoSends, finish: (status: Run['status'] = 'completed') => { run = { ...run, status }; } };
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
  f.options.startConversation = async (workflow, prompt, instructions) => { creates++; assert.equal(workflow.mode, 'conversation');
    // The conversation shows the request; Tower's policy and the owner's rules reach the agent as instructions.
    assert.match(instructions!, /tower_auto_prompt/); assert.match(instructions!, /Let the project agent inspect its local context/);
    assert.doesNotMatch(prompt, /tower_auto_prompt|coordinator/); assert.match(prompt, new RegExp(mention.text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return { sessionId: 'session', runId: 'run' }; };
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
  assert.equal(f.autoSends(), 0);
  await assert.rejects(f.manager.tool(id, 'slack_reply', { requestKey: 'reply-1', text: 'Other' }), /different text/);
});
test('conversation tools scope task reads and deduplicate delegation with Auto review', async t => {
  const f = await fixture(t); f.options.startConversation = async () => ({ sessionId: 'session', runId: 'run' });
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  const args = { requestKey: 'review', prompt: 'Review PR #42 in /repos/verse8. Read-only: do not modify files. Report actionable findings with evidence.' };
  await Promise.all([f.manager.tool(id, 'tower_auto_prompt', args), f.manager.tool(id, 'tower_auto_prompt', args)]);
  assert.equal(f.counts().submissions, 1); assert.equal(f.submitted[0].codexApprovalsReviewer, 'auto_review');
  assert.equal(f.submitted[0].prompt, args.prompt, 'preserve the task and owner constraints without injecting coordinator policy');
  const restarted = new SlackAutomationManager(f.options); await restarted.start();
  await restarted.tool(id, 'tower_auto_prompt', args);
  assert.equal(f.counts().submissions, 1);
  const followup = chatText(await restarted.ownerChat('session', '다음 PR도 같은 범위로 검토해주세요'));
  assert.match(followup, /Let the project agent inspect its local context/);
  assert.match(followup, /Preserve owner requirements such as read-only/);
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
  f.options.resumeConversation = async (_workflow, prompt, correlationId, instructions) => {
    resumes++; assert.match(prompt, /Review finished/);
    assert.match(instructions!, /Let the project agent inspect its local context/); assert.doesNotMatch(prompt, /Let the project agent/);
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
  assert.match(f.manager.list()[0].prompt!, /^Slack request from <@U2> in C1:\n<@U1> review this Verse8 PR/);
  assert.doesNotMatch(JSON.stringify(f.manager.list()), /first whose condition clearly matches/, 'pages read the workflow; the policy is not in it');
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

test('configured models survive snapshot restart and delegate through matched rule IDs', async t => {
  const f = await fixture(t);
  await f.manager.setRules([{ ...rule, model: 'gpt-6-astra' }]);
  await f.manager.ingest(mention);
  await f.manager.setRules([{ ...rule, model: 'gpt-5.6-sol' }]);
  const restarted = new SlackAutomationManager(f.options); await restarted.start(); await restarted.tick();
  assert.equal(f.submitted[0].model, 'gpt-6-astra');
  f.options.getAutoPrompt = () => undefined;
  f.options.startConversation = async () => ({ sessionId: 'coordinator', runId: 'coordinator-run' });
  await restarted.ingest({ ...mention, id: 'second' }); await restarted.tick();
  const workflow = restarted.list().find(item => item.mode === 'conversation')!;
  await restarted.tool(workflow.id, 'tower_auto_prompt', { requestKey: 'a', ruleId: rule.id, prompt: 'Review' });
  assert.equal(f.submitted.at(-1)?.model, 'gpt-5.6-sol');
  assert.equal(workflow.rules[0].model, 'gpt-5.6-sol');
  await restarted.tool(workflow.id, 'tower_auto_prompt', { requestKey: 'default-rule', prompt: 'Review' });
  assert.equal(f.submitted.at(-1)?.model, 'gpt-5.6-sol');
  await assert.rejects(restarted.tool(workflow.id, 'tower_auto_prompt', { requestKey: 'a', ruleId: rule.id, prompt: 'Review', model: 'opus' }), /match the selected rule/);
  await assert.rejects(restarted.tool(workflow.id, 'tower_auto_prompt', { requestKey: 'bad', ruleId: 'unknown', prompt: 'Review' }), /Unknown ruleId/);
  await assert.rejects(restarted.setRules([{ ...rule, model: '--bad model' }]), /지침/);
  assert.equal(f.counts().sends, 0);
});

test('multiple configured models require an explicit matched rule and cannot reuse task keys across models', async t => {
  const f = await fixture(t);
  f.options.startConversation = async () => ({ sessionId: 'coordinator', runId: 'coordinator-run' });
  await f.manager.setRules([{ ...rule, model: 'gpt-6-astra' }, { ...rule, id: 'other', model: 'gpt-5.6-sol' }]);
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  await assert.rejects(f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'a', prompt: 'Review' }), /ruleId is required/);
  await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'a', ruleId: 'review', prompt: 'Review' });
  await assert.rejects(f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'a', ruleId: 'other', prompt: 'Review' }), /different arguments/);
  assert.equal(f.submitted[0].model, 'gpt-6-astra');
  assert.equal(f.counts().sends, 0);
});

test('created delegate provenance and completion survive restart and routing history pruning; resumed sessions are never owned', async t => {
  for (const action of ['create', 'resume'] as const) {
    const f = await fixture(t);
    f.options.startConversation = async () => ({ sessionId: 'coordinator', runId: 'coordinator-run' });
    await f.manager.ingest(mention); await f.manager.tick();
    const id = f.manager.list()[0].id;
    await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'research', prompt: 'Research' });
    const task = f.manager.list()[0].delegatedTasks![0];
    const job = f.options.getAutoPrompt(task.requestId)!;
    job.decision = { action, cwd: '/repo', reason: 'fixture' };
    let run: Run = { id: job.runId!, sessionId: job.sessionId!, prompt: '', createdAt: '', output: '', status: 'running', autoPromptId: task.requestId };
    f.options.getRun = () => run;
    await f.manager.tick();
    assert.equal(f.manager.list()[0].delegatedTasks![0].createdSessionId, action === 'create' ? run.sessionId : undefined);
    assert.equal(f.manager.list()[0].delegatedTasks![0].delegatedFinished, undefined);
    f.options.getAutoPrompt = () => undefined;
    run = { ...run, status: 'completed' };
    const restarted = new SlackAutomationManager(f.options); await restarted.start(); await restarted.tick();
    assert.equal(restarted.list()[0].delegatedTasks![0].delegatedFinished, action === 'create' ? true : undefined);
    const again = new SlackAutomationManager(f.options); await again.start();
    assert.deepEqual(again.list()[0].delegatedTasks, restarted.list()[0].delegatedTasks);
  }
});

test('owner chat selects exact saved wording and explicit approval sends once across restart', async t => {
  const f = await fixture(t);
  f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'run' });
  await f.manager.ingest(mention); await f.manager.tick();
  const id = f.manager.list()[0].id;
  for (const [index, text] of ['First', 'Second', 'Third'].entries()) await f.manager.tool(id, 'slack_reply', { requestKey: `r${index}`, text });
  chatText(await f.manager.ownerChat('owner-chat', '3번'));
  assert.equal(f.counts().sends, 0);
  const restarted = new SlackAutomationManager(f.options); await restarted.start();
  assert.match(chatText(await restarted.ownerChat('owner-chat', '승인합니다')), /status: sent/);
  chatText(await restarted.ownerChat('owner-chat', '승인합니다'));
  assert.equal(f.counts().sends, 1);
  assert.equal(restarted.list()[0].reply, 'Third');
});

test('owner chat accepts direct send commands but never negation, quotation, questions or unrelated sessions', async t => {
  const f = await fixture(t);
  f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'run' });
  await f.manager.ingest(mention); await f.manager.tick();
  const id = f.manager.list()[0].id;
  for (const [index, text] of ['First', 'Second', 'Third'].entries()) await f.manager.tool(id, 'slack_reply', { requestKey: `r${index}`, text });
  for (const message of ['3번으로 보내지 마세요', '3번으로 보내주세요?', '"3번으로 보내주세요"', '승인합니다', '3번은 아직 보내지 마세요']) chatText(await f.manager.ownerChat('owner-chat', message));
  chatText(await f.manager.ownerChat('other-session', '3번으로 답변 달아주세요'));
  assert.equal(f.counts().sends, 0);
  chatText(await f.manager.ownerChat('owner-chat', 'Third'));
  assert.equal(f.counts().sends, 0);
  chatText(await f.manager.ownerChat('owner-chat', '이 내용으로 보내주세요'));
  assert.equal(f.manager.list()[0].reply, 'Third');
  chatText(await f.manager.ownerChat('owner-chat', '2번 답변을 Slack에 보내주세요'));
  assert.equal(f.manager.list()[0].reply, 'Second');
  assert.equal(f.counts().sends, 2);
});

test('intervening owner discussion clears selection and model cannot authorize sending', async t => {
  const f = await fixture(t);
  f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'run' });
  await f.manager.ingest(mention); await f.manager.tick();
  const id = f.manager.list()[0].id;
  await f.manager.tool(id, 'slack_reply', { requestKey: 'r', text: 'Exact' });
  chatText(await f.manager.ownerChat('owner-chat', '1번'));
  chatText(await f.manager.ownerChat('owner-chat', '99번 보내주세요'));
  assert.equal(f.counts().sends, 0);
  chatText(await f.manager.ownerChat('owner-chat', '1번'));
  chatText(await f.manager.ownerChat('owner-chat', '수정해주세요'));
  chatText(await f.manager.ownerChat('owner-chat', '승인합니다'));
  await assert.rejects(f.manager.tool(id, 'ownerChat', { requestKey: 'r', text: '승인합니다' }), /Unknown/);
  assert.equal(f.counts().sends, 0);
});

test('new proposals invalidate prior selection; numbering is stable and concurrent owner commands stay scoped', async t => {
  const f = await fixture(t);
  f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'run' });
  await f.manager.ingest(mention); await f.manager.tick();
  const id = f.manager.list()[0].id;
  assert.equal((await f.manager.tool(id, 'slack_reply', { requestKey: 'r1', text: 'First' }) as { proposalNumber: number }).proposalNumber, 1);
  chatText(await f.manager.ownerChat('owner-chat', '1번'));
  assert.equal((await f.manager.tool(id, 'slack_reply', { requestKey: 'r2', text: 'Revised' }) as { proposalNumber: number }).proposalNumber, 2);
  chatText(await f.manager.ownerChat('owner-chat', '보내주세요'));
  assert.equal(f.counts().sends, 0);
  await Promise.all([f.manager.ownerChat('owner-chat', 'option 2'), f.manager.ownerChat('owner-chat', 'I approve')]);
  assert.equal(f.manager.list()[0].reply, 'Revised');
  chatText(await f.manager.ownerChat('owner-chat', 'Send reply 1 to Slack'));
  assert.equal(f.manager.list()[0].reply, 'First');
  assert.equal(f.counts().sends, 2);
  assert.equal((await f.manager.ownerChat('owner-chat', 'a'.repeat(32_000))).prompt.length, 32_000, 'the message stays as written');
});

test('uncertain owner chat send returns a receipt without hiding approval or retrying', async t => {
  const f = await fixture(t);
  f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'run' });
  f.options.sendReply = async () => { throw new Error('lost response'); };
  await f.manager.ingest(mention); await f.manager.tick();
  const id = f.manager.list()[0].id;
  await f.manager.tool(id, 'slack_reply', { requestKey: 'r', text: 'Reply' });
  const receipt = chatText(await f.manager.ownerChat('owner-chat', '1번 보내주세요'));
  assert.match(receipt, /^1번 보내주세요/);
  assert.match(receipt, /uncertain/);
  assert.equal(f.manager.list()[0].replies![0].status, 'uncertain');
});

test('pasted proposal wording that looks like an approval only selects it', async t => {
  const f = await fixture(t);
  f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'run' });
  await f.manager.ingest(mention); await f.manager.tick();
  await f.manager.tool(f.manager.list()[0].id, 'slack_reply', { requestKey: 'r', text: '승인합니다' });
  chatText(await f.manager.ownerChat('owner-chat', '승인합니다'));
  assert.equal(f.counts().sends, 0);
  chatText(await f.manager.ownerChat('owner-chat', '1번 보내주세요'));
  assert.equal(f.counts().sends, 1);
  await f.manager.tool(f.manager.list()[0].id, 'slack_reply', { requestKey: 'r2', text: 'Send reply 1 to Slack' });
  chatText(await f.manager.ownerChat('owner-chat', 'Send reply 1 to Slack'));
  assert.equal(f.counts().sends, 1);
  assert.equal(f.manager.list()[0].ownerReplySelection?.requestKey, 'r2');
  await f.manager.tool(f.manager.list()[0].id, 'slack_reply', { requestKey: 'r3', text: '1번 보내주세요' });
  chatText(await f.manager.ownerChat('owner-chat', '1번 보내주세요'));
  assert.equal(f.counts().sends, 1);
  chatText(await f.manager.ownerChat('owner-chat', '승인'));
  assert.equal(f.manager.list()[0].reply, '1번 보내주세요');
  assert.equal(f.counts().sends, 2);
});

async function conditionalFixture(t: TestContext) {
  const f = await fixture(t);
  f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'coordinator' });
  await f.manager.ingest(mention); await f.manager.tick();
  const id = f.manager.list()[0].id;
  await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'deploy', prompt: 'Deploy the fix' });
  const task = f.manager.list()[0].delegatedTasks![0];
  const job = f.options.getAutoPrompt(task.requestId)!;
  const run: Run = { id: job.runId!, sessionId: job.sessionId!, autoPromptId: task.requestId, status: 'running', prompt: '', output: 'Deployment verified at release abc123.', createdAt: '' };
  f.options.getRun = () => run;
  return { ...f, id, task, run, job };
}
const conditionalCommand = '작업이 완료되면 그냥 배포됐습니다 라고 코멘트 다세요.';
test('conditional owner authorization survives restart and sends exact text only after evidenced success', async t => {
  const f = await conditionalFixture(t);
  assert.match(chatText(await f.manager.ownerChat('owner-chat', conditionalCommand)), /authorization saved/);
  assert.equal(f.manager.list()[0].ownerConditionalReply?.text, '배포됐습니다');
  const args = { requestId: f.task.requestId, runId: f.run.id, outcome: 'succeeded', evidence: 'Release abc123 deployed and health verified.' };
  await f.manager.tool(f.id, 'tower_task_complete', args);
  assert.equal(f.counts().sends, 0);
  f.run.status = 'completed';
  const restarted = new SlackAutomationManager(f.options); await restarted.start();
  await restarted.tick(); assert.equal(f.counts().sends, 0);
  await Promise.all([restarted.tool(f.id, 'tower_task_complete', args), restarted.tool(f.id, 'tower_task_complete', args)]);
  assert.equal(f.counts().sends, 1); assert.equal(restarted.list()[0].reply, '배포됐습니다');
  assert.equal(restarted.list()[0].ownerConditionalReply?.status, 'sent');
});
test('conditional reply requires owner permission and never sends failed uncertain cancelled or mismatched tasks', async t => {
  for (const outcome of ['failed', 'uncertain', 'error', 'cancelled', 'mismatch', 'no-owner']) {
    const f = await conditionalFixture(t);
    if (outcome !== 'no-owner') chatText(await f.manager.ownerChat('owner-chat', conditionalCommand));
    f.run.status = outcome === 'error' || outcome === 'cancelled' ? outcome : 'completed';
    if (outcome === 'mismatch') f.run.autoPromptId = 'other';
    const work = f.manager.tool(f.id, 'tower_task_complete', { requestId: f.task.requestId, runId: f.run.id, outcome: outcome === 'failed' || outcome === 'uncertain' ? outcome : 'succeeded', evidence: 'Checked task result.' });
    if (outcome === 'no-owner') await assert.rejects(work, /No owner authorization/); else await work;
    assert.equal(f.counts().sends, 0);
  }
});
test('owner cancellation is serialized before completion and uncertain delivery never retries after restart', async t => {
  const f = await conditionalFixture(t); chatText(await f.manager.ownerChat('owner-chat', conditionalCommand)); f.run.status = 'completed';
  const args = { requestId: f.task.requestId, runId: f.run.id, outcome: 'succeeded', evidence: 'Deployment verified.' };
  await Promise.all([f.manager.ownerChat('owner-chat', '댓글 취소해주세요'), f.manager.tool(f.id, 'tower_task_complete', args)]);
  assert.equal(f.counts().sends, 0);
  const g = await conditionalFixture(t); chatText(await g.manager.ownerChat('owner-chat', conditionalCommand)); g.run.status = 'completed';
  let attempts = 0; g.options.sendReply = async () => { attempts++; throw Error('uncertain'); };
  await g.manager.tool(g.id, 'tower_task_complete', { ...args, requestId: g.task.requestId });
  const restarted = new SlackAutomationManager(g.options); await restarted.start();
  await restarted.tool(g.id, 'tower_task_complete', { ...args, requestId: g.task.requestId });
  assert.equal(attempts, 1); assert.equal(restarted.list()[0].ownerConditionalReply?.status, 'uncertain');
});
test('conditional commands fail closed on ambiguity and exact proposal paste retains selection semantics', async t => {
  const f = await conditionalFixture(t);
  await f.manager.tool(f.id, 'slack_reply', { requestKey: 'literal', text: conditionalCommand });
  chatText(await f.manager.ownerChat('owner-chat', conditionalCommand));
  assert.equal(f.manager.list()[0].ownerConditionalReply, undefined);
  assert.equal(f.manager.list()[0].ownerReplySelection?.requestKey, 'literal');
  const g = await conditionalFixture(t);
  await g.manager.tool(g.id, 'tower_auto_prompt', { requestKey: 'second', prompt: 'Other task' });
  assert.match(chatText(await g.manager.ownerChat('owner-chat', conditionalCommand)), /not authorized/);
  assert.equal(g.manager.list()[0].ownerConditionalReply, undefined);
  for (const message of ['"' + conditionalCommand + '"', conditionalCommand + '?', '작업이 완료되면 보내지 마세요']) {
    chatText(await g.manager.ownerChat('owner-chat', message)); assert.equal(g.manager.list()[0].ownerConditionalReply, undefined);
  }
});
test('conditional replacement preserves only latest exact wording and rejects stale run evidence', async t => {
  const f = await conditionalFixture(t);
  chatText(await f.manager.ownerChat('owner-chat', conditionalCommand));
  chatText(await f.manager.ownerChat('owner-chat', '작업이 완료되면 그냥 수정했습니다 라고 코멘트 다세요.'));
  chatText(await f.manager.ownerChat('owner-chat', '진행 상황은 어떤가요?'));
  assert.equal(f.manager.list()[0].ownerConditionalReply?.text, '수정했습니다');
  f.run.status = 'completed';
  const args = { requestId: f.task.requestId, runId: 'stale', outcome: 'succeeded', evidence: 'Verified.' };
  await f.manager.tool(f.id, 'tower_task_complete', args); assert.equal(f.counts().sends, 0);
  await f.manager.tool(f.id, 'tower_task_complete', { ...args, runId: f.run.id, outcome: 'uncertain' });
  await f.manager.tool(f.id, 'tower_task_complete', { ...args, runId: f.run.id });
  assert.equal(f.counts().sends, 0); assert.equal(f.manager.list()[0].ownerConditionalReply?.status, 'blocked');
});

test('coordinator language follows current preference on creation, owner followups and task continuations', async t => {
  const f = await fixture(t);
  let language: 'ko' | 'en' = 'ko';
  let initial = '', resumed = '';
  f.options.language = () => language;
  f.options.startConversation = async (_workflow, prompt, instructions) => { initial = `${instructions}\n${prompt}`; return { sessionId: 'coordinator', runId: 'initial' }; };
  f.options.getSessionRuns = () => [];
  f.options.resumeConversation = async (_workflow, prompt, _correlation, instructions) => { resumed = `${instructions}\n${prompt}`; return { runId: 'result' }; };
  await f.manager.ingest(mention); await f.manager.tick();
  assert.match(initial, /^\[Tower 대화 언어: 한국어\]/);
  const id = f.manager.list()[0].id;
  await f.manager.tool(id, 'slack_reply', { requestKey: 'exact', text: 'Keep this exact English wording.' });
  language = 'en';
  assert.match(chatText(await f.manager.ownerChat('coordinator', 'explain')), /\[Tower conversation language: English\]/);
  assert.deepEqual(await f.manager.ownerChat('unrelated', 'explain'), { prompt: 'explain' }, 'another conversation gets nothing added');
  await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'task', prompt: 'Review PR' });
  f.finish(); await f.manager.tick();
  assert.match(resumed, /^\[Tower conversation language: English\]/);
  language = 'ko';
  assert.match(chatText(await f.manager.ownerChat('coordinator', '설명해주세요')), /\[Tower 대화 언어: 한국어\]/);
  assert.equal(f.manager.list()[0].replies?.[0].text, 'Keep this exact English wording.');
  assert.equal(f.counts().sends, 0);
  assert.equal(f.submitted[0].prompt, 'Review PR', 'coordinator language/policy must not pollute delegated task prompt');
});

test('composed owner consent during work survives restart and sends once without exact wording or a click', async t => {
  const f = await conditionalFixture(t);
  await assert.rejects(f.manager.tool(f.id, 'slack_send', { text: 'Unauthorized' }), /No immediate owner/);
  assert.match(chatText(await f.manager.ownerChat('owner-chat', '작업 끝나면 그냥 슬랙에 알려주세요')), /authorization saved/);
  assert.equal(f.manager.list()[0].ownerConditionalReply?.mode, 'composed');
  const args = { requestId: f.task.requestId, runId: f.run.id, outcome: 'succeeded', evidence: 'Verified deployment.', text: '배포를 마쳤습니다. 확인 부탁드립니다.' };
  await f.manager.tool(f.id, 'tower_task_complete', args); assert.equal(f.counts().sends, 0);
  await assert.rejects(f.manager.tool(f.id, 'slack_send', { text: args.text }), /No immediate owner/);
  f.run.status = 'completed';
  const restarted = new SlackAutomationManager(f.options); await restarted.start();
  await Promise.all([restarted.tool(f.id, 'tower_task_complete', args), restarted.tool(f.id, 'tower_task_complete', args)]);
  assert.equal(f.counts().sends, 1); assert.equal(restarted.list()[0].reply, args.text);
});

test('polite immediate and edited-wording chat permissions allow an agent composed send without proposals', async t => {
  for (const message of ['슬랙에 보내주시겠어요?', '슬랙에 보내줄래요?', '슬랙에 보내도 됩니다', '이 문구로 슬랙에 보내주세요', '수정한 내용으로 답변 보내주세요']) {
    const f = await fixture(t); f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'coordinator' });
    await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
    assert.match(chatText(await f.manager.ownerChat('owner-chat', message)), /authorization saved/);
    await f.manager.tool(id, 'slack_send', { text: '수정 내용을 반영했습니다.' });
    await f.manager.tool(id, 'slack_send', { text: '수정 내용을 반영했습니다.' });
    assert.equal(f.counts().sends, 1);
  }
});

test('semantic owner classifier sees owner input only, handles compound permission and fails without blocking chat', async t => {
  const f = await conditionalFixture(t); let calls = 0;
  f.options.classifyOwnerReply = async message => { calls++; assert.equal(message, 'LGTM 달고 슬랙에도 알려주세요'); return { intent: 'after_work' }; };
  chatText(await f.manager.ownerChat('owner-chat', 'LGTM 달고 슬랙에도 알려주세요'));
  assert.equal(calls, 1); assert.equal(f.manager.list()[0].ownerConditionalReply?.mode, 'composed');
  f.options.classifyOwnerReply = async () => { throw Error('timeout'); };
  assert.match(chatText(await f.manager.ownerChat('owner-chat', '이런 말투가 좋아요')), /message was received/);
  assert.equal(f.manager.list()[0].ownerConditionalReply?.status, 'pending');
  chatText(await f.manager.ownerChat('owner-chat', '아직 보내지 마세요'));
  assert.equal(f.manager.list()[0].ownerConditionalReply?.status, 'cancelled');
});

test('composed completion reports truthful failures but cannot assert success or send while running', async t => {
  for (const status of ['error', 'cancelled'] as const) {
    const f = await conditionalFixture(t); chatText(await f.manager.ownerChat('owner-chat', '끝나면 그냥 알려주시면 됩니다'));
    f.run.status = status; f.run.error = 'Deployment failed.';
    const args = { requestId: f.task.requestId, runId: f.run.id, evidence: 'Deployment failed before health check.', text: '배포하지 못했습니다. 원인을 확인하고 있습니다.' };
    await assert.rejects(f.manager.tool(f.id, 'tower_task_complete', { ...args, outcome: 'succeeded' }), /Cannot report success/);
    await f.manager.tool(f.id, 'tower_task_complete', { ...args, outcome: 'failed' });
    assert.equal(f.counts().sends, 1);
  }
});

test('permission granted before delegation binds all newly delegated tasks and waits for each', async t => {
  const f = await fixture(t); f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'coordinator' });
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  const jobs = new Map<string, AutoPromptJob>(), runs = new Map<string, Run>();
  f.options.submitAutoPrompt = async input => {
    const job: AutoPromptJob = { id: input.requestId, provider: input.provider, prompt: input.prompt, routerModel: 'test', status: 'completed', createdAt: '', updatedAt: '', runId: input.requestId, sessionId: input.requestId };
    jobs.set(job.id, job); runs.set(job.id, { id: job.id, sessionId: job.id, autoPromptId: job.id, status: 'running', prompt: '', output: 'Verified work.', createdAt: '' }); return job;
  };
  f.options.getAutoPrompt = id => jobs.get(id); f.options.getRun = id => runs.get(id);
  chatText(await f.manager.ownerChat('owner-chat', '작업 끝나면 그냥 슬랙에 알려주세요'));
  assert.equal(f.manager.list()[0].ownerConditionalReply?.requestId, 'next-task');
  await f.manager.tick(); assert.equal(f.manager.list()[0].ownerConditionalReply?.status, 'pending');
  await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'one', prompt: 'First task' });
  await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'two', prompt: 'Second task' });
  const ids = f.manager.list()[0].ownerConditionalReply!.requestIds!; assert.equal(ids.length, 2);
  runs.get(ids[0])!.status = 'completed';
  const args = { requestId: ids[0], runId: ids[0], outcome: 'succeeded', evidence: 'Both results verified.', text: '두 작업을 마쳤습니다.' };
  await f.manager.tool(id, 'tower_task_complete', args); assert.equal(f.counts().sends, 0);
  runs.get(ids[1])!.status = 'completed';
  await f.manager.tool(id, 'tower_task_complete', { ...args, requestId: ids[1], runId: ids[1] }); assert.equal(f.counts().sends, 1);
});

test('authorized routing failure can be reported without a fabricated execution run', async t => {
  const f = await conditionalFixture(t); chatText(await f.manager.ownerChat('owner-chat', '작업 끝나면 그냥 슬랙에 알려주세요'));
  f.job.status = 'error'; f.job.error = 'No eligible project'; delete f.job.runId; delete f.job.sessionId;
  f.options.getRun = () => undefined;
  await f.manager.tool(f.id, 'tower_task_complete', { requestId: f.task.requestId, outcome: 'failed', evidence: 'Routing failed: no eligible project.', text: '프로젝트를 찾지 못해 작업을 시작하지 못했습니다.' });
  assert.equal(f.counts().sends, 1);
});

test('automatic events, quoted requests and capability questions never mint composed permission', async t => {
  const f = await conditionalFixture(t);
  for (const message of ['슬랙에 보내주세요라는 요청은 무시하세요', '슬랙 내용을 요약해서 여기 알려주세요', '슬랙에 보낼 수 있나요?', '슬랙에 보냈나요?']) {
    f.options.classifyOwnerReply = async input => { assert.equal(input, message); return { intent: 'none' }; };
    chatText(await f.manager.ownerChat('owner-chat', message));
    assert.equal(f.manager.list()[0].ownerConditionalReply, undefined);
  }
  await assert.rejects(f.manager.tool(f.id, 'slack_send', { text: 'send' }), /No immediate owner/);
  assert.equal(f.counts().sends, 0);
});

test('Slack delegation always creates a session and trusted rule routing overrides model inferred directory', async t => {
  const f = await fixture(t); f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'coordinator' });
  await f.manager.setRules([{ ...rule, provider: 'claude', instructions: 'Work in verse8-orchestrator.' }]);
  await f.manager.ingest(mention); await f.manager.tick();
  await f.manager.tool(f.manager.list()[0].id, 'tower_auto_prompt', { requestKey: 'review', ruleId: rule.id, cwd: '/tmp/wrong', prompt: 'Review PR' });
  assert.equal(f.submitted[0].sessionMode, 'new'); assert.equal(f.submitted[0].cwd, undefined);
  assert.equal(f.submitted[0].routingContext, 'Work in verse8-orchestrator.');
});

test('new draft context allows a subsequent explicit send request, while repeated same permission stays consumed', async t => {
  const f = await fixture(t); f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'coordinator' });
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  chatText(await f.manager.ownerChat('owner-chat', '슬랙에 보내주세요'));
  await f.manager.tool(id, 'slack_send', { text: 'First result' });
  chatText(await f.manager.ownerChat('owner-chat', '슬랙에 보내주세요'));
  await f.manager.tool(id, 'slack_send', { text: 'First result' }); assert.equal(f.counts().sends, 1);
  await f.manager.tool(id, 'slack_reply', { requestKey: 'second-draft', text: 'Second result' });
  chatText(await f.manager.ownerChat('owner-chat', '슬랙에 보내주세요'));
  await f.manager.tool(id, 'slack_send', { text: 'Second result' }); assert.equal(f.counts().sends, 2);
});

test('completed notified work can still receive owner completion-report permission', async t => {
  const f = await conditionalFixture(t); f.run.status = 'completed';
  f.options.resumeConversation = async () => ({ runId: 'notification' });
  f.options.getSessionRuns = () => [];
  await f.manager.tick(); assert.ok(f.manager.list()[0].delegatedTasks![0].notifiedRunId);
  chatText(await f.manager.ownerChat('owner-chat', '작업 끝나면 그냥 슬랙에 알려주세요'));
  assert.equal(f.manager.list()[0].ownerConditionalReply?.requestId, f.task.requestId);
  await f.manager.tool(f.id, 'tower_task_complete', { requestId: f.task.requestId, runId: f.run.id, outcome: 'succeeded', evidence: 'Verified.', text: '작업 완료했습니다.' });
  assert.equal(f.counts().sends, 1);
});

test('owner completion permission can report a durable submission failure without a job or run', async t => {
  const f = await fixture(t); f.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'coordinator' });
  f.options.submitAutoPrompt = async () => { throw Error('Provider unavailable'); }; f.options.getRun = () => undefined;
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  chatText(await f.manager.ownerChat('owner-chat', '작업 끝나면 그냥 슬랙에 알려주세요'));
  await assert.rejects(f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'task', prompt: 'Review PR' }), /Provider unavailable/);
  const requestId = f.manager.list()[0].delegatedTasks![0].requestId;
  const args = { requestId, evidence: 'Task submission failed: provider unavailable.', text: '실행 환경 문제로 작업을 시작하지 못했습니다.' };
  await assert.rejects(f.manager.tool(id, 'tower_task_complete', { ...args, outcome: 'succeeded' }), /Cannot report success/);
  await f.manager.tool(id, 'tower_task_complete', { ...args, outcome: 'failed' }); assert.equal(f.counts().sends, 1);
});

test('autoReply rule delegation grants one truthful report, reactions and participant mentions without owner approval', async t => {
  const f = await fixture(t);
  await f.manager.setRules([{ ...rule, autoReply: true }]);
  const reactions: string[] = []; const mentionables: string[][] = []; const automatic: boolean[] = [];
  f.options.react = async (target, name, action) => { assert.equal(target.ts, mention.ts); reactions.push(`${action}:${name}`); };
  f.options.sendReply = async (_mention, _text, mentionable, auto) => { mentionables.push(mentionable); automatic.push(auto); return { ts: '2.0' }; };
  f.options.startConversation = async (_workflow, _prompt, instructions) => { assert.match(instructions!, /autoReply true/); return { sessionId: 'owner-chat', runId: 'coordinator' }; };
  await f.manager.ingest(mention); await f.manager.tick(); const id = f.manager.list()[0].id;
  await assert.rejects(f.manager.tool(id, 'slack_react', { name: 'hourglass_flowing_sand', action: 'add' }), /No reply authorization/);
  await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'deploy', ruleId: 'review', prompt: 'Deploy the fix' });
  const consent = f.manager.list()[0].ownerConditionalReply!;
  assert.equal(consent.ruleId, 'review'); assert.equal(consent.mode, 'composed'); assert.match(consent.instruction!, /Confirm only a finished review/);
  await f.manager.tool(id, 'slack_react', { name: ':hourglass_flowing_sand:', action: 'add' });
  await assert.rejects(f.manager.tool(id, 'slack_react', { name: 'bad name', action: 'add' }), /emoji name/);
  const task = f.manager.list()[0].delegatedTasks![0]; const job = f.options.getAutoPrompt(task.requestId)!;
  const run: Run = { id: job.runId!, sessionId: job.sessionId!, autoPromptId: task.requestId, status: 'running', prompt: '', output: 'Review finished.', createdAt: '' };
  f.options.getRun = () => run;
  const args = { requestId: task.requestId, runId: run.id, outcome: 'succeeded', evidence: 'Review completed.', text: '<@U2> 확인 했습니다.' };
  assert.equal((await f.manager.tool(id, 'tower_task_complete', args) as { status: string }).status, 'blocked');
  run.status = 'completed';
  const restarted = new SlackAutomationManager(f.options); await restarted.start();
  await Promise.all([restarted.tool(id, 'tower_task_complete', args), restarted.tool(id, 'tower_task_complete', args)]);
  assert.equal(mentionables.length, 1);
  assert.deepEqual(mentionables[0], ['U2']);
  assert.deepEqual(automatic, [true]);
  await restarted.tool(id, 'slack_react', { name: 'hourglass_flowing_sand', action: 'remove' });
  await restarted.tool(id, 'slack_react', { name: 'white_check_mark', action: 'add' });
  assert.deepEqual(reactions, ['add:hourglass_flowing_sand', 'remove:hourglass_flowing_sand', 'add:white_check_mark']);
  assert.equal(restarted.list()[0].reactions?.length, 3);
  assert.equal(restarted.isOwnReply(mention.channel, mention.threadTs, '2.0'), true);
  assert.equal(restarted.isOwnReply(mention.channel, mention.threadTs, '3.0'), false);
});

test('rules without autoReply never grant sending, and owner cancellation revokes a rule grant', async t => {
  const f = await conditionalFixture(t);
  assert.equal(f.manager.list()[0].ownerConditionalReply, undefined);
  await assert.rejects(f.manager.tool(f.id, 'tower_task_complete', { requestId: f.task.requestId, runId: f.run.id, outcome: 'succeeded', evidence: 'Done.', text: 'Done' }), /No owner authorization/);
  const g = await fixture(t); await g.manager.setRules([{ ...rule, autoReply: true }]);
  g.options.react = async () => {}; g.options.startConversation = async () => ({ sessionId: 'owner-chat', runId: 'coordinator' });
  await g.manager.ingest(mention); await g.manager.tick(); const id = g.manager.list()[0].id;
  await g.manager.tool(id, 'tower_auto_prompt', { requestKey: 'deploy', prompt: 'Deploy the fix' });
  chatText(await g.manager.ownerChat('owner-chat', '아직 보내지 마세요'));
  assert.equal(g.manager.list()[0].ownerConditionalReply?.status, 'cancelled');
  await assert.rejects(g.manager.tool(id, 'slack_react', { name: 'eyes', action: 'add' }), /No reply authorization/);
  await assert.rejects(g.manager.setRules([{ ...rule, autoReply: 'yes' as unknown as boolean }]), /올바르지/);
});
test('while the worker hands off, new mentions are saved but only the successor starts them', async t => {
  const f = await fixture(t);
  f.manager.hold();
  await f.manager.ingest(mention);
  await f.manager.tick();
  assert.equal(f.manager.list()[0].status, 'received');
  assert.equal(f.manager.inFlight(), false, 'an unstarted held mention does not keep the old worker busy');
  assert.equal(f.manager.hasPending(), true, 'it is still accepted work');
  assert.deepEqual(f.counts(), { sends: 0, submissions: 0, fetches: 0 });
  await f.manager.flush();
  const successor = new SlackAutomationManager(f.options); await successor.start(); await successor.tick();
  assert.equal(successor.list()[0].status, 'running');
  assert.equal(f.counts().submissions, 1);
});
test('holding intake never abandons a mention whose thread is already being read', async t => {
  const f = await fixture(t);
  let release!: () => void;
  let started = false;
  const reading = new Promise<void>(resolve => { release = resolve; });
  const fetch = f.options.fetchThread;
  f.options.fetchThread = async mention => { started = true; await reading; return fetch(mention); };
  await f.manager.ingest(mention);
  const tick = f.manager.tick();
  while (!started) await new Promise(resolve => setImmediate(resolve));
  f.manager.hold();
  assert.equal(f.manager.inFlight(), true, 'the started read keeps the worker from handing off');
  release();
  await tick;
  assert.equal(f.manager.list()[0].status, 'running');
  assert.equal(f.counts().submissions, 1);
});
test('a handoff flush reports a state file that cannot be saved instead of hiding it', async t => {
  const f = await fixture(t);
  await f.manager.ingest(mention);
  await rm(join(f.directory, 'slack-automation.json'), { force: true });
  await mkdir(join(f.directory, 'slack-automation.json'));
  await assert.rejects(f.manager.flush());
  await rm(join(f.directory, 'slack-automation.json'), { recursive: true, force: true });
  await f.manager.flush();
  assert.equal(JSON.parse(await readFile(join(f.directory, 'slack-automation.json'), 'utf8')).workflows.length, 1);
});

test('the same coordinator serves another channel under its own name, tools and state file', async t => {
  const f = await fixture(t);
  const channel: CoordinatorChannel = { label: 'GitHub', tools: 'github', file: 'github-automation.json', validReaction: name => ['+1', 'eyes', 'rocket', '👍'].includes(name),
    aliases: ['깃허브', 'GitHub'], mentionGuide: 'To mention someone, write @login.' };
  let prompt = '';
  const reacted: string[] = [];
  const options: SlackAutomationOptions = { ...f.options, channel, startConversation: async (_workflow, text, instructions) => { prompt = `${instructions}\n${text}`; return { sessionId: 'gh-session', runId: 'run' }; },
    react: async (_mention, name) => { reacted.push(name); } };
  const github = new SlackAutomationManager(options);
  await github.start();
  // Rules and issue text are passed exactly as written, even where they name Slack.
  await github.setRules([{ ...rule, id: 'slack_review', instructions: 'Fix slack_send in Slack' }]);
  await github.ingest({ ...mention, id: 'issue-event', teamId: 'github', channel: 'octo/app', text: 'Slack is down' });
  await github.tick();
  assert.match(prompt, /GitHub conversation coordinator/);
  assert.match(prompt, /github_reply/);
  assert.match(prompt, /@login/);
  assert.doesNotMatch(prompt, /<@USER_ID>/);
  assert.match(prompt, /"id":"slack_review"[\s\S]*Fix slack_send in Slack[\s\S]*Slack is down/);
  assert.doesNotMatch(prompt.split('Owner configured rules')[0], /Slack|slack_/);
  assert.match(prompt, /GitHub request from/, 'the request is named for its channel');
  const id = github.list()[0].id;
  await assert.rejects(github.tool(id, 'slack_reply', { requestKey: 'r', text: 'Done' }), /Unknown GitHub conversation tool/);
  assert.equal((await github.tool(id, 'github_reply', { requestKey: 'r', text: 'Done' }) as { proposalNumber: number }).proposalNumber, 1);
  // A command naming another channel creates no permission here; this channel's own name works.
  chatText(await github.ownerChat('gh-session', 'send reply 1 to Slack'));
  assert.equal(f.counts().sends, 0);
  const receipt = chatText(await github.ownerChat('gh-session', 'send reply 1 to GitHub'));
  assert.match(receipt, /GitHub/);
  assert.doesNotMatch(receipt, /Slack/);
  assert.equal(f.counts().sends, 1, 'the owner-approved proposal is sent through the channel');
  // Reactions follow the channel's own names.
  (github as unknown as { items: Array<{ ownerConditionalReply?: unknown }> }).items[0].ownerConditionalReply = { mode: 'composed', requestId: 'immediate', requestKey: 'k', text: 'x', status: 'sent', authorizedAt: new Date().toISOString() };
  await assert.rejects(github.tool(id, 'github_react', { name: 'hourglass', action: 'add' }), /Provide an emoji name/);
  await github.tool(id, 'github_react', { name: 'eyes', action: 'add' });
  await github.tool(id, 'github_react', { name: '👍', action: 'add' });
  assert.deepEqual(reacted, ['eyes', '👍']);
  // Each channel keeps its own state and restarts from it, reactions included.
  const again = new SlackAutomationManager(options);
  await again.start();
  assert.equal(again.list()[0].mention.channel, 'octo/app');
  assert.equal(again.rules()[0].id, 'slack_review');
  await f.manager.ingest(mention);
  const slack = new SlackAutomationManager(f.options);
  await slack.start();
  assert.equal(slack.rules()[0].id, 'review');
  assert.deepEqual(slack.list().map(item => item.mention.channel), ['C1'], 'Slack restarts with only its own workflow');
  assert.deepEqual(again.list().map(item => item.mention.channel), ['octo/app']);
});


/** A coordinator conversation that already began, with every turn it runs and every later message it received. */
async function followUpFixture(t: TestContext, judged: (text: string) => number | undefined = text => /merge/.test(text) ? 0.9 : 0.1) {
  const f = await fixture(t);
  const coordinator: Run = { id: 'coordinator-run', sessionId: 'coordinator', prompt: '', status: 'completed', createdAt: '', output: '' };
  const runs: Run[] = [coordinator];
  const resumed: Array<{ prompt: string; instructions?: string }> = [];
  f.options.startConversation = async () => ({ sessionId: coordinator.sessionId, runId: coordinator.id });
  f.options.getSessionRuns = () => runs;
  f.options.findConversation = id => { const run = runs.find(run => run.autoPromptId === id); return run ? { sessionId: run.sessionId, runId: run.id } : undefined; };
  f.options.resumeConversation = async (_workflow, prompt, correlationId, instructions) => {
    resumed.push({ prompt, instructions });
    const run: Run = { ...coordinator, id: `follow-up-${resumed.length}`, status: 'queued', autoPromptId: correlationId };
    runs.push(run); return { runId: run.id };
  };
  f.options.judgeFollowUp = async ({ message }) => judged(message.text);
  await f.manager.ingest(mention); await f.manager.tick();
  const later = (ts: string, text: string, mentioned = false) => ({ channel: 'C1', threadTs: '1.0', user: 'U2', ts, text, mentioned });
  return { ...f, coordinator, runs, resumed, later };
}

test('a later thread message for the owner continues the conversation once; others stay out of it', async t => {
  const f = await followUpFixture(t);
  assert.equal(await f.manager.followUp({ ...f.later('3.0', 'can I merge?'), threadTs: '9.0' }), false, 'another thread is not followed');
  assert.equal(await f.manager.followUp(f.later('1.0', 'Review PR 5 for Verse8')), true);
  assert.equal(await f.manager.followUp(f.later('2.0', 'thanks!')), true);
  assert.equal(await f.manager.followUp(f.later('3.0', 'Comments addressed, can I merge?')), true);
  assert.equal(await f.manager.followUp(f.later('3.0', 'Comments addressed, can I merge?')), true, 'a repeated event is taken once');
  assert.equal(await f.manager.followUp(f.later('4.0', '<@U1> also check the admin PR', true)), true);
  assert.equal(f.resumed.length, 0, 'taking a message only saves it');
  await f.manager.tick();
  assert.equal(f.resumed.length, 1, 'waiting messages reach the conversation in one turn');
  assert.match(f.resumed[0].prompt, /can I merge\?/); assert.match(f.resumed[0].prompt, /also check the admin PR/); assert.doesNotMatch(f.resumed[0].prompt, /thanks!/);
  assert.match(f.resumed[0].instructions!, /pass its ruleId when delegating/); assert.match(f.resumed[0].instructions!, /"id":"review"/);
  assert.doesNotMatch(f.resumed[0].prompt, /pass its ruleId/, 'the conversation shows the messages; the policy goes to the agent');
  const followUps = f.manager.list()[0].followUps!;
  assert.deepEqual(followUps.map(item => [item.ts, item.status]), [['1.0', 'skipped'], ['2.0', 'skipped'], ['3.0', 'delivered'], ['4.0', 'delivered']]);
  assert.equal(followUps[1].addressed, 0.1); assert.equal(followUps[2].addressed, 0.9); assert.equal(followUps[3].addressed, undefined, 'a mention is not judged');
  assert.equal(followUps[2].runId, 'follow-up-1');
  f.runs[1].status = 'completed';
  const restarted = new SlackAutomationManager(f.options); await restarted.start(); await restarted.tick(); await restarted.tick();
  assert.equal(f.resumed.length, 1, 'nothing is handed over twice');
});

test('follow-ups wait for a running turn, and a delivery that cannot be confirmed is not repeated', async t => {
  const f = await followUpFixture(t);
  f.coordinator.status = 'running';
  await f.manager.followUp(f.later('3.0', 'can I merge now?'));
  await f.manager.tick();
  assert.equal(f.resumed.length, 0); assert.equal(f.manager.list()[0].followUps![0].status, 'pending');
  f.coordinator.status = 'completed';
  const resume = f.options.resumeConversation!;
  f.options.resumeConversation = async () => { throw new Error('worker connection lost'); };
  await f.manager.tick();
  assert.equal(f.manager.list()[0].followUps![0].status, 'error'); assert.match(f.manager.list()[0].followUps![0].reason!, /worker connection lost/);
  f.options.resumeConversation = resume;
  await f.manager.tick(); assert.equal(f.resumed.length, 0);
});

test('follow-ups are left alone without a judgment, and a claimed delivery is settled from the record after a restart', async t => {
  const f = await followUpFixture(t, () => undefined);
  await f.manager.followUp(f.later('3.0', 'can I merge?'));
  await f.manager.tick();
  assert.equal(f.manager.list()[0].followUps![0].status, 'skipped'); assert.match(f.manager.list()[0].followUps![0].reason!, /off/);
  assert.equal(f.resumed.length, 0);
  // A worker that stopped between claiming a delivery and recording it: the run it started is found, not started again.
  const path = join(f.directory, 'slack-automation.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.workflows[0].followUps.push({ ts: '4.0', user: 'U2', text: '<@U1> merge?', mentioned: true, status: 'delivering', receivedAt: new Date().toISOString() });
  await writeFile(path, JSON.stringify(saved));
  const correlation = (await import('../../../server/slack/automation.js')).slackRequestId({ ...mention, id: JSON.stringify(['follow-up', saved.workflows[0].id, '4.0']) });
  f.runs.push({ ...f.coordinator, id: 'delivered-before-restart', autoPromptId: correlation });
  const restarted = new SlackAutomationManager(f.options); await restarted.start(); await restarted.tick();
  assert.equal(restarted.list()[0].followUps![1].status, 'delivered'); assert.equal(restarted.list()[0].followUps![1].runId, 'delivered-before-restart');
  assert.equal(f.resumed.length, 0);
});

test('an autoReply rule gives work delegated for a follow-up its own result report once the first was sent', async t => {
  const f = await followUpFixture(t);
  await f.manager.setRules([{ ...rule, autoReply: true }]);
  await f.manager.ingest({ ...mention, id: 'event-auto', threadTs: '5.0', ts: '5.1' }); await f.manager.tick();
  const id = f.manager.list()[1].id;
  const first = await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'review', prompt: 'Review PR', ruleId: 'review' }) as { requestId: string };
  const run: Run = { id: 'run', sessionId: 'session', autoPromptId: first.requestId, status: 'completed', prompt: '', output: 'Review finished with no findings.', createdAt: '' };
  f.options.getRun = () => run;
  const sent = await f.manager.tool(id, 'tower_task_complete', { requestId: first.requestId, runId: 'run', outcome: 'succeeded', evidence: 'Review finished', text: '확인 했습니다.' }) as { status: string };
  assert.equal(sent.status, 'sent');
  const again = await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'again', prompt: 'Review again', ruleId: 'review' }) as { conditionalReply: { status: string } };
  assert.equal(again.conditionalReply.status, 'sent', 'without a follow-up no new report is recorded');
  await f.manager.followUp({ ...f.later('6.0', '<@U1> fixed, can I merge?', true), threadTs: '5.0' });
  await f.manager.tick();
  assert.deepEqual(f.resumed.map(turn => /delegated task finished/.test(turn.prompt)), [true], 'a delegated result reaches the conversation first');
  for (let turn = 0; turn < 3; turn++) { for (const run of f.runs) run.status = 'completed'; await f.manager.tick(); }
  assert.deepEqual(f.resumed.map(turn => /delegated task finished/.test(turn.prompt)), [true, true, false]);
  assert.match(f.resumed[2].prompt, /fixed, can I merge\?/);
  const follow = await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'follow-up', prompt: 'Check the fixes', ruleId: 'review' }) as { requestId: string; conditionalReply: { status: string; requestIds: string[] } };
  assert.equal(follow.conditionalReply.status, 'pending');
  assert.deepEqual(follow.conditionalReply.requestIds, [follow.requestId]);
});

test('Tower puts its working reaction on a new request at once and takes it off when the work settles', async t => {
  const f = await fixture(t);
  const coordinator: Run = { id: 'coordinator-run', sessionId: 'coordinator', prompt: '', status: 'running', createdAt: '', output: '' };
  const calls: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.options.react = async (_mention, name, action, ts) => { calls.push(`${action}:${name}:${ts}`); };
  f.options.workingReaction = () => 'loading';
  f.options.startConversation = async () => ({ sessionId: coordinator.sessionId, runId: coordinator.id });
  f.options.getSessionRuns = () => [coordinator];
  // An earlier request whose thread fetch hangs holds the conversation pass, but not the reaction.
  const fetch = f.options.fetchThread;
  f.options.fetchThread = async input => { if (input.ts === '0.1') await blocked; return fetch(input); };
  await f.manager.ingest({ ...mention, id: 'event-0', ts: '0.1', threadTs: '0.0' });
  const stuck = f.manager.tick();
  await f.manager.ingest(mention);
  for (let wait = 0; calls.length < 2 && wait < 200; wait++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, ['add:loading:0.1', 'add:loading:1.1'], 'both requests are marked while the first thread fetch hangs');
  release(); await stuck; await f.manager.tick();
  assert.deepEqual(calls.slice(2), [], 'nothing comes off while the coordinator works');
  coordinator.status = 'completed';
  await f.manager.tick();
  assert.deepEqual(calls.slice(2).sort(), ['remove:loading:0.1', 'remove:loading:1.1']);
  assert.deepEqual(f.manager.list()[1].workingMarks, [{ ts: '1.1', name: 'loading', state: 'off' }]);
  await f.manager.tick(); assert.equal(calls.length, 4, 'each mark is handled once');
});

test('no working reaction without the setting, and a failed start still takes the reaction off', async t => {
  const f = await fixture(t);
  const calls: string[] = [];
  f.options.react = async (_mention, name, action, ts) => { calls.push(`${action}:${name}:${ts}`); };
  f.options.startConversation = async () => { throw new Error('provider missing'); };
  await f.manager.ingest(mention); await f.manager.tick();
  assert.deepEqual(calls, []); assert.equal(f.manager.list()[0].workingMarks, undefined);
  f.options.workingReaction = () => 'loading';
  await f.manager.ingest({ ...mention, id: 'event-2', ts: '2.1', threadTs: '2.0' }); await f.manager.tick();
  assert.equal(f.manager.list()[1].status, 'error');
  assert.deepEqual(calls, ['add:loading:2.1', 'remove:loading:2.1']);
});

test('working reactions whose outcome is uncertain are taken off with a real call after a restart, and failures are not retried', async t => {
  const f = await fixture(t);
  const calls: string[] = [];
  f.options.react = async (_mention, name, action, ts) => { calls.push(`${action}:${name}:${ts}`); if (action === 'remove' && ts === '2.1') throw new Error('ratelimited'); };
  f.options.workingReaction = () => 'loading';
  f.options.startConversation = async () => { throw new Error('provider missing'); };
  await f.manager.ingest({ ...mention, id: 'event-2', ts: '2.1', threadTs: '2.0' }); await f.manager.tick();
  assert.deepEqual(f.manager.list()[0].workingMarks, [{ ts: '2.1', name: 'loading', state: 'off', error: 'ratelimited' }]);
  // A worker that stopped after Slack took the reaction but before it recorded that.
  const path = join(f.directory, 'slack-automation.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.workflows[0].workingMarks = [{ ts: '2.1', name: 'loading', state: 'add' }, { ts: '2.2', name: 'eyes', state: 'on' }];
  await writeFile(path, JSON.stringify(saved));
  calls.length = 0;
  const restarted = new SlackAutomationManager(f.options); await restarted.start(); await restarted.tick(); await restarted.tick();
  assert.deepEqual(calls, ['remove:loading:2.1', 'remove:eyes:2.2']);
  assert.deepEqual(restarted.list()[0].workingMarks?.map(mark => mark.state), ['off', 'off']);
  saved.workflows[0].workingMarks = [{ ts: '2.1', name: 'not an emoji', state: 'add' }];
  await writeFile(path, JSON.stringify(saved));
  await assert.rejects(new SlackAutomationManager(f.options).start(), /working marks are invalid/);
});

test('a follow-up for the owner gets the working reaction on its own message before it reaches the conversation', async t => {
  const f = await followUpFixture(t);
  const calls: string[] = [];
  f.options.react = async (_mention, name, action, ts) => { calls.push(`${action}:${name}:${ts}`); };
  f.options.workingReaction = () => 'loading';
  f.coordinator.status = 'running';
  await f.manager.followUp(f.later('4.0', '<@U1> deploy to dev please', true));
  await f.manager.tick();
  assert.deepEqual(calls, ['add:loading:4.0'], 'a mention of the owner is marked at once, while the conversation is still busy');
  assert.equal(f.resumed.length, 0);
  await f.manager.followUp(f.later('2.0', 'thanks!'));
  await f.manager.followUp(f.later('3.0', 'merged, can I merge the next one?'));
  await f.manager.tick();
  assert.deepEqual(calls, ['add:loading:4.0', 'add:loading:3.0'], 'a message judged not for the owner gets nothing');
  f.coordinator.status = 'completed';
  await f.manager.tick();
  assert.equal(f.resumed.length, 1);
  assert.match(f.resumed[0].instructions!, /pass its ts \(4\.0, 3\.0\) to slack_react/);
  assert.equal(calls.length, 2, 'the delivered turn is queued, so the marks stay');
  for (const run of f.runs) run.status = 'completed';
  await f.manager.tick();
  assert.deepEqual(calls.slice(2).sort(), ['remove:loading:3.0', 'remove:loading:4.0']);
});

test('slack_react can mark a follow-up the conversation received, and nothing else', async t => {
  const f = await followUpFixture(t);
  await f.manager.setRules([{ ...rule, autoReply: true }]);
  const targets: string[] = [];
  const request = { ...mention, id: 'event-auto', threadTs: '5.0', ts: '5.1' };
  f.options.react = async (target, name, action, ts) => { assert.equal(target.ts, request.ts); targets.push(`${action}:${name}:${ts}`); };
  await f.manager.ingest(request); await f.manager.tick();
  const id = f.manager.list()[1].id;
  await f.manager.followUp({ ...f.later('3.0', '<@U1> deploy to dev please', true), threadTs: '5.0' });
  await f.manager.followUp({ ...f.later('3.5', 'thanks!'), threadTs: '5.0' });
  await f.manager.tick();
  await f.manager.tool(id, 'tower_auto_prompt', { requestKey: 'deploy', prompt: 'Deploy dev', ruleId: 'review' });
  await f.manager.tool(id, 'slack_react', { name: 'loading', action: 'add', ts: '3.0' });
  await f.manager.tool(id, 'slack_react', { name: 'white_check_mark', action: 'add' });
  await assert.rejects(f.manager.tool(id, 'slack_react', { name: 'x', action: 'add', ts: '3.5' }), /ts must be/);
  // A message the conversation already had in its first thread.
  await f.manager.tool(id, 'slack_react', { name: 'eyes', action: 'add', ts: '1.0' });
  targets.pop();
  await assert.rejects(f.manager.tool(id, 'slack_react', { name: 'x', action: 'add', ts: '9.9' }), /ts must be/);
  assert.deepEqual(targets, ['add:loading:3.0', `add:white_check_mark:${request.ts}`]);
  assert.deepEqual(f.manager.list()[1].reactions?.map(reaction => reaction.ts), ['3.0', undefined, '1.0']);
  const restarted = new SlackAutomationManager(f.options); await restarted.start();
  assert.equal(restarted.list()[1].reactions?.length, 3);
});

test('a reaction call underway keeps the worker from handing off, and the handoff save waits for it', async t => {
  const f = await fixture(t);
  let answer!: () => void;
  const calls: string[] = [];
  f.options.react = (_mention, name, action, ts) => { calls.push(`${action}:${name}:${ts}`); return new Promise<void>(resolve => { answer = resolve; }); };
  f.options.workingReaction = () => 'loading';
  f.options.startConversation = () => new Promise(() => {});
  await f.manager.ingest(mention);
  for (let wait = 0; !calls.length && wait < 200; wait++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.manager.inFlight(), true);
  f.manager.hold();
  let flushed = false;
  const flush = f.manager.flush().then(() => { flushed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(flushed, false, 'the handoff save waits for the reaction call');
  answer(); await flush;
  const saved = JSON.parse(await readFile(join(f.directory, 'slack-automation.json'), 'utf8'));
  assert.equal(saved.workflows[0].workingMarks[0].state, 'on');
  await f.manager.tick(); assert.deepEqual(calls, ['add:loading:1.1'], 'held, nothing new starts');
});

test('a request whose admission is not saved gets no reaction, and clearing takes every mark off at once', async t => {
  const f = await fixture(t);
  const calls: string[] = [];
  f.options.react = async (_mention, name, action, ts) => { calls.push(`${action}:${name}:${ts}`); };
  f.options.workingReaction = () => 'loading';
  f.options.startConversation = () => new Promise(() => {});
  const path = join(f.directory, 'slack-automation.json');
  await rm(path); await mkdir(path);
  await assert.rejects(f.manager.ingest(mention));
  assert.deepEqual(calls, [], 'no reaction for a request that was not admitted');
  await rm(path, { recursive: true });
  await f.manager.ingest(mention);
  assert.deepEqual(calls, ['add:loading:1.1']);
  await f.manager.clearMarks();
  assert.deepEqual(calls, ['add:loading:1.1', 'remove:loading:1.1']);
  assert.deepEqual(f.manager.list()[0].workingMarks, [{ ts: '1.1', name: 'loading', state: 'off' }]);
});

test('clearing waits for a reaction pass and no sweep puts a mark back meanwhile', async t => {
  const f = await fixture(t);
  const calls: string[] = [];
  const answers: Array<() => void> = [];
  f.options.react = (_mention, name, action, ts) => { calls.push(`${action}:${name}:${ts}`); return new Promise<void>(resolve => answers.push(resolve)); };
  f.options.workingReaction = () => 'loading';
  f.options.startConversation = () => new Promise(() => {});
  const admitted = f.manager.ingest(mention);
  for (let wait = 0; !calls.length && wait < 200; wait++) await new Promise(resolve => setTimeout(resolve, 5));
  const clearing = f.manager.clearMarks();
  void f.manager.tick();
  answers.shift()!(); await admitted;
  for (let wait = 0; calls.length < 2 && wait < 200; wait++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.manager.inFlight(), true);
  void f.manager.tick();
  answers.shift()!(); await clearing;
  assert.deepEqual(calls, ['add:loading:1.1', 'remove:loading:1.1'], 'no add comes between or after the clearing');
  assert.equal(f.manager.list()[0].workingMarks?.[0].state, 'off');
});

test('a mark queued while clearing is taken off too, and nothing goes back on before the account change is done', async t => {
  const f = await fixture(t);
  const calls: string[] = [];
  const answers: Array<() => void> = [];
  f.options.react = (_mention, name, action, ts) => { calls.push(`${action}:${name}:${ts}`); return new Promise<void>(resolve => answers.push(resolve)); };
  f.options.workingReaction = () => 'loading';
  f.options.startConversation = () => new Promise(() => {});
  const admitted = f.manager.ingest(mention);
  for (let wait = 0; !calls.length && wait < 200; wait++) await new Promise(resolve => setTimeout(resolve, 5));
  answers.shift()!(); await admitted;
  let changed = false, release!: () => void;
  const change = new Promise<void>(resolve => { release = resolve; });
  const clearing = f.manager.clearMarks(async () => { await change; changed = true; });
  for (let wait = 0; calls.length < 2 && wait < 200; wait++) await new Promise(resolve => setTimeout(resolve, 5));
  // A second request arrives while the first mark is coming off.
  const second = f.manager.ingest({ ...mention, id: 'event-2', ts: '2.1', threadTs: '2.0' });
  answers.shift()!(); await second;
  for (let wait = 0; calls.length < 3 && wait < 200; wait++) await new Promise(resolve => setTimeout(resolve, 5));
  answers.shift()!();
  await new Promise(resolve => setTimeout(resolve, 20));
  void f.manager.tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  release(); await clearing;
  assert.equal(changed, true);
  assert.deepEqual(calls, ['add:loading:1.1', 'remove:loading:1.1', 'remove:loading:2.1'], 'the late mark is only taken off, never put on');
});
