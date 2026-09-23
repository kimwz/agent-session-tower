import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { GitHubCoordinator, GITHUB_SESSION_TOOLS } from '../../../server/triggers/github-coordinator.js';
import { GitHubError, type GitHubFetch } from '../../../server/triggers/github.js';
import { TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';
import { CapabilityRegistry, handleMcpRequest } from '../../../server/api/mcp.js';
import { runToolResolver } from '../../../server/api/run-tools.js';
import type { RunAdmission } from '../../../server/runs/manager.js';
const AGENT: TriggerActor = { kind: 'agent', via: 'mcp', sessionId: 'codex:agent', runId: randomUUID() };
import type { AutoPromptJob, AutoPromptRequest, CreateSessionRequest, Run, Session } from '../../../shared/types.js';
import { GitHubSourceSchema, type TriggerActor, type TriggerInput } from '../../../shared/triggers.js';

const OWNER: TriggerActor = { kind: 'owner', via: 'ui' };
const rule = { id: 'triage', name: 'Bug triage', enabled: true, condition: 'A bug report', instructions: 'Reproduce and fix the bug', replyInstructions: 'Summarize the fix for the reporter', provider: 'codex' as const };

async function fixture(t: TestContext, options: { login?: string; postStatus?: number; postFails?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-github-coordinator-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const clock = { now: Date.parse('2026-09-24T00:00:30.000Z') };
  const runs: Run[] = [];
  const created: Array<{ input: CreateSessionRequest; internal: RunAdmission }> = [];
  const submitted: Array<{ request: AutoPromptRequest; internal: unknown }> = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const issues = [{ number: 1 }];
  const github: GitHubFetch = async (path, _etag, send) => {
    if (send) {
      posts.push({ path, body: send.body });
      if (options.postFails) throw Object.assign(new GitHubError('Connection reset'), { uncertain: true });
      return { status: options.postStatus ?? 201, body: { id: 9001 } };
    }
    const url = new URL(path, 'https://api.github.com');
    if (url.pathname === '/user') return { status: 200, body: { login: options.login ?? 'me' } };
    if (url.pathname === '/repos/octo/app/issues') {
      return { status: 200, body: [...issues].reverse().map(issue => ({ number: issue.number, state: 'open', title: `Bug ${issue.number}`, body: 'It crashes', author_association: 'MEMBER',
        user: { login: 'reporter' }, labels: [], assignees: [], html_url: `https://github.com/octo/app/issues/${issue.number}`, created_at: '' })) };
    }
    if (/^\/repos\/octo\/app\/issues\/\d+$/.test(url.pathname)) return { status: 200, body: { title: 'Bug 2', body: 'It crashes', user: { login: 'reporter' } } };
    if (url.pathname.endsWith('/comments')) return { status: 200, body: [{ id: 5, user: { login: 'teammate' }, body: 'Seen on main too' }] };
    return { status: 404, body: {} };
  };
  const record = (sessionId: string, prompt: string, internal: RunAdmission): Run => {
    const run: Run = { id: randomUUID(), sessionId, prompt, status: 'running', createdAt: new Date(clock.now).toISOString(), output: '', autoPromptId: internal.autoPromptId, origin: internal.origin };
    runs.push(run); return run;
  };
  const jobs = new Map<string, AutoPromptJob>();
  const runManager = {
    list: () => structuredClone(runs),
    create: async (input: CreateSessionRequest, internal: RunAdmission) => {
      created.push({ input, internal });
      const id = `codex:${randomUUID()}`;
      const run = record(id, input.prompt, internal);
      return { run, session: { id, nativeId: 'n', provider: input.provider, title: '', cwd: input.cwd!, project: 'p', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } as Session };
    },
    enqueue: async (sessionId: string, prompt: string, _request: unknown, internal: RunAdmission) => record(sessionId, prompt, internal),
  };
  let service: TriggerService | undefined;
  const coordinator = new GitHubCoordinator({ stateDir: directory, runs: runManager as never, refresh: async () => {},
    autoPrompts: { get: id => jobs.get(id), submit: async (request, internal) => { submitted.push({ request, internal }); const job = { id: request.requestId, provider: request.provider, prompt: request.prompt, routerModel: 'r', status: 'queued' as const, createdAt: '', updatedAt: '' }; jobs.set(job.id, job); return job; } },
    github: (triggerId, fresh) => service!.githubClient(triggerId, fresh) });
  const executor: TriggerExecutor = {
    submitAutoPrompt: async () => { throw new Error('unused'); }, getAutoPrompt: () => undefined,
    create: async () => { throw new Error('unused'); }, enqueue: async () => { throw new Error('unused'); },
    runs: () => structuredClone(runs), session: () => undefined,
    coordinate: event => coordinator.coordinate(event), coordination: id => coordinator.coordination(id),
  };
  service = new TriggerService({ stateDir: directory, executor, now: () => clock.now, tickMs: 60_000, ghToken: async () => 'gho_token', githubTransport: () => github });
  await service.start();
  await coordinator.start();
  t.after(async () => { coordinator.close(); service!.close(); await service!.settle(); await rm(directory, { recursive: true, force: true }); });
  const settle = async () => { for (let index = 0; index < 5; index++) { await service!.tick(); await coordinator.automation.tick(); } };
  return { directory, project, clock, runs, created, submitted, posts, issues, service, coordinator, settle };
}

const coordinatorTrigger = (values: Partial<TriggerInput> = {}): TriggerInput => ({
  name: 'Issues', enabled: true,
  source: GitHubSourceSchema.parse({ kind: 'github', schedule: { type: 'interval', everySeconds: 300 }, auth: { type: 'gh' }, account: 'me', watch: { type: 'issue-opened', repos: ['octo/app'] } }),
  handler: { kind: 'coordinator', rules: [rule], approvals: 'auto' },
  policy: { overlap: 'parallel', maxEventsPerHour: 20 }, ...values,
});

test('a new issue opens one coordinator conversation that reads the issue and comments, with GitHub tools only', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.create({ ...coordinatorTrigger(), source: { kind: 'schedule', schedule: { type: 'interval', everySeconds: 60 }, catchUp: 'latest' } }, OWNER), /available for GitHub triggers/);
  const trigger = await f.service.create(coordinatorTrigger(), OWNER);
  await assert.rejects(f.service.run(trigger.id, OWNER), /nothing new/);
  f.issues.push({ number: 2 });
  const event = await f.service.run(trigger.id, OWNER);
  await f.settle();
  assert.equal(f.created.length, 1, 'one conversation for the event');
  const [{ input, internal }] = f.created;
  assert.match(input.prompt, /GitHub conversation coordinator/);
  assert.match(input.prompt, /github_reply/);
  assert.doesNotMatch(input.prompt.split('Owner configured rules')[0], /Slack|slack_/);
  assert.match(input.prompt, /Reproduce and fix the bug[\s\S]*"channel":"octo\/app"[\s\S]*Seen on main too/);
  assert.equal(internal.untrustedInput, true);
  assert.deepEqual(internal.origin, { kind: 'trigger', triggerId: trigger.id, eventId: event.id, workflowId: f.service.events()[0].dispatch?.workflowId });
  // Handing the same event over again returns the same conversation.
  assert.equal((await f.coordinator.coordinate(event)).workflowId, f.service.events()[0].dispatch?.workflowId);
  assert.equal(f.created.length, 1);
  // The coordinator session gets only its GitHub conversation tools.
  const capabilities = new CapabilityRegistry(() => true);
  const resolve = runToolResolver({ stateDir: f.directory, runs: { sessionOrigin: () => undefined }, github: f.coordinator, capabilities });
  const tools = resolve(f.runs[0], { id: f.runs[0].sessionId } as Session);
  assert.ok(tools.required && tools.servers?.tower_github);
  const capability = tools.servers!.tower_github.env!.TOWER_MCP_CAPABILITY;
  const listed = await handleMcpRequest({ capabilities, run: () => undefined, githubTool: (id, name, args) => f.coordinator.tool(id, name, args) }, capability, { method: 'tools/list' }) as { tools: Array<{ name: string }> };
  assert.deepEqual(listed.tools.map(tool => tool.name), GITHUB_SESSION_TOOLS.map(tool => tool.name));
  assert.ok(listed.tools.some(tool => tool.name === 'github_reply') && !listed.tools.some(tool => tool.name.startsWith('slack_')));
});

test('a comment is posted only after the owner approves it, once, and an uncertain post is never repeated', async t => {
  const f = await fixture(t);
  const trigger = await f.service.create(coordinatorTrigger(), OWNER);
  await assert.rejects(f.service.run(trigger.id, OWNER), /nothing new/);
  f.issues.push({ number: 2 });
  await f.service.run(trigger.id, OWNER);
  await f.settle();
  const workflowId = f.service.events()[0].dispatch!.workflowId!;
  await f.coordinator.tool(workflowId, 'github_reply', { requestKey: 'proposal-1', text: 'Fixed in #3. Thanks for the report!' });
  assert.equal(f.posts.length, 0, 'a proposal is not a comment');
  await assert.rejects(f.coordinator.tool(workflowId, 'github_send', { text: 'Sneaky' }), /No immediate owner send authorization/);
  await f.coordinator.approveReply(workflowId, 'proposal-1', 'Fixed in #3. Thanks for the report!');
  await f.coordinator.approveReply(workflowId, 'proposal-1', 'Fixed in #3. Thanks for the report!');
  assert.deepEqual(f.posts, [{ path: '/repos/octo/app/issues/2/comments', body: { body: 'Fixed in #3. Thanks for the report!' } }]);
  const sessionId = f.runs[0].sessionId;
  assert.equal(f.coordinator.workflow(sessionId)?.replies?.[0].status, 'sent');
  // Delegated work carries the trigger's origin and runs unattended when the trigger says so.
  await f.coordinator.tool(workflowId, 'tower_auto_prompt', { requestKey: 'fix', ruleId: 'triage', prompt: 'Fix the crash in octo/app issue 2.' });
  assert.equal((f.submitted[0].internal as RunAdmission).unattended, true);
  assert.equal((f.submitted[0].internal as RunAdmission).origin?.workflowId, workflowId);
});

test('a comment whose post may have arrived is marked uncertain and not sent again', async t => {
  const f = await fixture(t, { postFails: true });
  const trigger = await f.service.create(coordinatorTrigger(), OWNER);
  await assert.rejects(f.service.run(trigger.id, OWNER), /nothing new/);
  f.issues.push({ number: 2 });
  await f.service.run(trigger.id, OWNER);
  await f.settle();
  const workflowId = f.service.events()[0].dispatch!.workflowId!;
  await f.coordinator.tool(workflowId, 'github_reply', { requestKey: 'p', text: 'Done' });
  await assert.rejects(f.coordinator.approveReply(workflowId, 'p', 'Done'));
  await assert.rejects(f.coordinator.approveReply(workflowId, 'p', 'Done'), /다시 전송할 수 없습니다|cannot/i);
  assert.equal(f.posts.length, 1);
  assert.equal(f.coordinator.workflow(f.runs[0].sessionId)?.replies?.[0].status, 'uncertain');
});

test('nothing is posted when GitHub now acts as another account', async t => {
  const f = await fixture(t);
  const trigger = await f.service.create(coordinatorTrigger(), OWNER);
  await assert.rejects(f.service.run(trigger.id, OWNER), /nothing new/);
  f.issues.push({ number: 2 });
  await f.service.run(trigger.id, OWNER);
  await f.settle();
  const workflowId = f.service.events()[0].dispatch!.workflowId!;
  await f.coordinator.tool(workflowId, 'github_reply', { requestKey: 'p', text: 'Done' });
  // The login changes to someone else right before the owner approves; nothing cached hides it.
  const fetchAsOther: GitHubFetch = async path => path === '/user' ? { status: 200, body: { login: 'intruder' } } : { status: 201, body: { id: 1 } };
  (f.service as unknown as { options: { githubTransport: () => GitHubFetch } }).options.githubTransport = () => fetchAsOther;
  await assert.rejects(f.coordinator.approveReply(workflowId, 'p', 'Done'), /signed in as intruder, not me; nothing was sent/);
  assert.equal(f.posts.length, 0);
  assert.equal(f.coordinator.workflow(f.runs[0].sessionId)?.replies?.[0].status, 'proposed', 'nothing left, so it can be approved again once fixed');
});

test('only the owner can turn on automatic replies; an agent can keep them unchanged, and restoring by an agent turns them off', async t => {
  const f = await fixture(t);
  const auto = { ...rule, autoReply: true };
  await assert.rejects(f.service.create(coordinatorTrigger({ handler: { kind: 'coordinator', rules: [auto], approvals: 'auto' } }), AGENT), /Only the owner can turn on automatic replies/);
  const plain = await f.service.create(coordinatorTrigger(), AGENT);
  await assert.rejects(f.service.update(plain.id, coordinatorTrigger({ handler: { kind: 'coordinator', rules: [auto], approvals: 'auto' } }), plain.revision, AGENT), /Only the owner/);
  const owned = await f.service.update(plain.id, coordinatorTrigger({ handler: { kind: 'coordinator', rules: [auto], approvals: 'auto' } }), plain.revision, OWNER);
  // Keeping it as the owner set it (even renaming the trigger) is fine; changing what the rule does is not.
  const renamed = await f.service.update(plain.id, { ...coordinatorTrigger({ handler: { kind: 'coordinator', rules: [auto], approvals: 'auto' } }), name: 'Renamed' }, owned.revision, AGENT);
  await assert.rejects(f.service.update(plain.id, coordinatorTrigger({ handler: { kind: 'coordinator', rules: [{ ...auto, instructions: 'Post whatever' }], approvals: 'auto' } }), renamed.revision, AGENT), /Only the owner/);
  // The owner turns it off; an agent bringing back the earlier revision does not bring the permission back.
  const off = await f.service.update(plain.id, coordinatorTrigger(), renamed.revision, OWNER);
  const reverted = await f.service.revert(plain.id, owned.revision, off.revision, AGENT);
  assert.equal(reverted.handler.kind === 'coordinator' && reverted.handler.rules[0].autoReply, undefined);
  assert.match(f.service.audit({ limit: 1 })[0].summary, /automatic replies turned off/);
  // Deleting and restoring by an agent does not bring an owner's automatic reply back either.
  const owner = await f.service.update(plain.id, coordinatorTrigger({ handler: { kind: 'coordinator', rules: [auto], approvals: 'auto' } }), reverted.revision, OWNER);
  await f.service.remove(plain.id, owner.revision, OWNER);
  const restored = await f.service.restore(plain.id, AGENT);
  assert.equal(restored.handler.kind === 'coordinator' && restored.handler.rules[0].autoReply, undefined);
  // A different rule reusing the id of the owner's rule cannot inherit its permission.
  const again = await f.service.update(plain.id, coordinatorTrigger({ handler: { kind: 'coordinator', rules: [auto], approvals: 'auto' } }), restored.revision, OWNER);
  await assert.rejects(f.service.update(plain.id, coordinatorTrigger({ handler: { kind: 'coordinator', rules: [{ ...auto, condition: 'Anything at all' }, { ...rule, id: 'other' }], approvals: 'auto' } }), again.revision, AGENT), /Only the owner/);
});

test('with owner approvals, delegated work waits for the owner, fixed when the conversation began', async t => {
  const f = await fixture(t);
  const trigger = await f.service.create(coordinatorTrigger({ handler: { kind: 'coordinator', rules: [rule], approvals: 'owner' } }), OWNER);
  await assert.rejects(f.service.run(trigger.id, OWNER), /nothing new/);
  f.issues.push({ number: 2 });
  await f.service.run(trigger.id, OWNER);
  await f.settle();
  assert.equal(f.created[0].input.codexApprovalsReviewer, undefined, 'the coordinator itself is not auto-reviewed either');
  assert.match(f.created[0].input.prompt, /Codex tasks wait for the owner’s approvals in Tower/);
  assert.doesNotMatch(f.created[0].input.prompt, /All Codex tasks use Auto approval review/);
  const workflowId = f.service.events()[0].dispatch!.workflowId!;
  // The trigger is switched to automatic afterwards; this conversation keeps what it began with.
  const current = f.service.get(trigger.id).trigger;
  await f.service.update(trigger.id, coordinatorTrigger({ handler: { kind: 'coordinator', rules: [rule], approvals: 'auto' } }), current.revision, OWNER);
  await f.coordinator.tool(workflowId, 'tower_auto_prompt', { requestKey: 'fix', ruleId: 'triage', prompt: 'Fix it.' });
  assert.equal(f.submitted[0].request.codexApprovalsReviewer, undefined);
  assert.equal((f.submitted[0].internal as RunAdmission).unattended, false);
});

test('a comment refused before it leaves (rate limit) can be approved again', async t => {
  const f = await fixture(t);
  const trigger = await f.service.create(coordinatorTrigger(), OWNER);
  await assert.rejects(f.service.run(trigger.id, OWNER), /nothing new/);
  f.issues.push({ number: 2 });
  await f.service.run(trigger.id, OWNER);
  await f.settle();
  const workflowId = f.service.events()[0].dispatch!.workflowId!;
  await f.coordinator.tool(workflowId, 'github_reply', { requestKey: 'p', text: 'Done' });
  const blocked = (f.service as unknown as { githubBlocked: Map<string, number> }).githubBlocked;
  const identity = [...(f.service as unknown as { logins: Map<string, unknown> }).logins.keys()][0];
  blocked.set(identity, f.clock.now + 3_600_000);
  await assert.rejects(f.coordinator.approveReply(workflowId, 'p', 'Done'), /rate limit/);
  assert.equal(f.posts.length, 0);
  assert.equal(f.coordinator.workflow(f.runs[0].sessionId)?.replies?.[0].status, 'proposed');
  blocked.clear();
  await f.coordinator.approveReply(workflowId, 'p', 'Done');
  assert.equal(f.posts.length, 1);
  const react = GITHUB_SESSION_TOOLS.find(tool => tool.name === 'github_react')!;
  assert.deepEqual((react.inputSchema.properties as { action: { enum: string[] } }).action.enum, ['add']);
});

