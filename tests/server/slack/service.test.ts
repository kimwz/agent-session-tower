import { externalStorageFixture, readWorkflowFixture } from '../remote/external-storage-fixture.js';
import { until } from '../../helpers/until.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_AGENT_MENTIONS_PER_THREAD, SlackService } from '../../../server/slack/service.js';
import { SlackApiError } from '../../../server/slack/client.js';
import type { SlackSocketOptions } from '../../../server/slack/socket.js';
import type { DecisionEngine } from '../../../server/decisions/engine.js';
import type { Run } from '../../../shared/types.js';

test('Slack connection stays private, admits only personal mentions, and pauses without losing accepted work', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-service-'));
  const storage = await externalStorageFixture(t, stateDir);
  let socket: SlackSocketOptions | undefined;
  let starts = 0, stops = 0;
  const service: SlackService = new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not execute'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw new Error('Must not send'); }, isPerson: async () => false }),
    socket: options => { socket = options; return { start: () => { starts++; }, stop: () => { stops++; } }; },
    model: async () => { throw new Error('Must not start a provider'); },
  });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects();
  const credentials = { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' };
  await service.mutate('connect', credentials);
  assert.equal(starts, 0);
  assert.equal(service.overview().enabled, false);
  assert.equal(JSON.stringify(service.overview()).includes(credentials.userToken), false);
  assert.equal((await stat(join(stateDir, 'slack-connection.json'))).mode & 0o777, 0o600);
  await service.mutate('settings', { enabled: true });
  assert.equal(starts, 1); assert.equal(service.hasActive(), true);
  const event = { type: 'message', channel: 'C1', user: 'U2', ts: '100.001', text: '<@U1> review please' };
  for (const payload of [
    { team_id: 'T2', event_id: 'other-team', event },
    { team_id: 'T1', event_id: 'bot', event: { ...event, bot_id: 'B1' } },
    { team_id: 'T1', event_id: 'self', event: { ...event, user: 'U1' } },
    { team_id: 'T1', event_id: 'unmentioned', event: { ...event, text: 'hello' } },
    { team_id: 'T1', event_id: 'edit', event: { ...event, subtype: 'message_changed' } },
  ]) await socket!.onEvent(payload);
  assert.equal(service.overview().events.length, 0);
  await socket!.onEvent({ team_id: 'T1', event_id: 'Ev1', event });
  await socket!.onEvent({ team_id: 'T1', event_id: 'Ev1', event });
  assert.equal(service.overview().events.length, 1);
  await service.mutate('settings', { enabled: false });
  assert.equal(stops, 1);
  assert.equal(service.hasActive(), true, 'accepted events retain worker lifetime while monitoring is paused');
  await assert.rejects(service.mutate('disconnect', {}), /진행 중/);
  await service.automation.tick();
  assert.equal(service.overview().events[0].status, 'ignored');
  assert.equal(service.hasActive(), false);
  await service.mutate('disconnect', {});
  assert.equal((await readFile(join(stateDir, 'slack-connection.json'), 'utf8')).includes('xoxp'), false);
  assert.equal(service.overview().connected, false);
  await assert.rejects(service.mutate('rules', { rules: [{}] }), { kind: 'invalid' });
  await assert.rejects(service.mutate('settings', { enabled: true, extra: true }), { kind: 'invalid' });
});

test('self-mention testing is opt-in, persists, and keeps bot, edit, and escaped reply filters', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-self-'));
  const storage = await externalStorageFixture(t, stateDir);
  let socket: SlackSocketOptions | undefined;
  let socketStarts = 0;
  const create = () => new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not execute'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw new Error('Must not send'); } }),
    socket: options => { socket = options; return { start() { socketStarts++; }, stop() {} }; },
    model: async () => { throw new Error('Must not start a provider'); },
  });
  let service = create();
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects();
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  assert.equal(service.overview().allowSelfMentions, false);
  await service.mutate('settings', { enabled: true });
  const event = { type: 'message', channel: 'GPRIVATE', channel_type: 'group', user: 'U1', ts: '100.001', text: '<@U1> test review' };
  const send = (id: string, patch = {}) => socket!.onEvent({ team_id: 'T1', event_id: id, event: { ...event, ...patch } });
  await send('default-off');
  assert.equal(service.overview().events.length, 0);
  for (const body of [{}, { allowSelfMentions: 'true' }, { enabled: null }, { allowSelfMentions: true, unexpected: true }]) {
    await assert.rejects(service.mutate('settings', body), { kind: 'invalid' });
  }
  await service.mutate('settings', { allowSelfMentions: true });
  assert.equal(service.overview().enabled, true, 'partial settings preserve monitoring');
  assert.equal(socketStarts, 1, 'self-mention changes preserve the connected socket');
  await send('self-private');
  assert.equal(service.overview().events[0]?.mention.channel, 'GPRIVATE');
  await service.automation.tick();
  service.close();
  service = create();
  await service.start(); await service.startRuntimeEffects();
  assert.equal(service.overview().allowSelfMentions, true);
  assert.equal(service.overview().enabled, true);
  await send('after-restart');
  for (const [id, patch] of [
    ['bot', { bot_id: 'B1' }], ['edit', { subtype: 'message_changed' }],
    ['hidden', { hidden: true }], ['escaped-reply', { text: '&lt;@U1&gt; review complete' }],
  ] as const) await send(id, patch);
  service.automation.isOwnReply = (channel, threadTs, ts) => channel === 'GPRIVATE' && threadTs === '100.001' && ts === '100.002';
  await send('own-live-mention-reply', { ts: '100.002', thread_ts: '100.001', text: '<@U1> 배포 완료 됐습니다.' });
  assert.equal(service.overview().events.length, 2, 'Tower-posted replies that mention the owner never start a new workflow');
  await service.mutate('settings', { allowSelfMentions: false });
  await send('disabled-again');
  assert.equal(service.overview().events.length, 2);
  await service.mutate('settings', { enabled: false, allowSelfMentions: true });
  assert.equal(service.overview().enabled, false);
  assert.equal(service.overview().allowSelfMentions, true);
});

test('dedicated coordinator exposes scoped MCP during creation and follows later native turns', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-coordinator-'));
  const storage = await externalStorageFixture(t, stateDir);
  const runs: import('../../../shared/types.js').Run[] = [];
  const service: SlackService = new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: {
    list: () => runs,
    create: async (input, internal) => {
      assert.equal(input.cwd, join(stateDir, 'slack-sessions', service.overview().events[0].id));
      assert.equal(input.codexApprovalsReviewer, 'auto_review');
      assert.equal(input.model, 'gpt-6-astra');
      const run: import('../../../shared/types.js').Run = { id: 'r1', sessionId: 'codex:test', prompt: input.prompt, status: 'running', output: '', createdAt: '2026-01-01', autoPromptId: internal?.autoPromptId };
      runs.push(run);
      assert.equal(service.overview().events[0].sessionId, undefined);
      assert.ok(service.sessionMcp(run.sessionId)?.tower_slack.args.includes('--slack-mcp'));
      assert.equal(service.sessionMcp('unrelated'), undefined);
      assert.deepEqual([service.sessionThread(run.sessionId), service.sessionThread('unrelated')], [{ teamId: 'T1', channel: 'G1', threadTs: '1' }, undefined], 'its thread, for the todos it adds');
      return { run, session: { id: run.sessionId, nativeId: 'test', provider: 'codex', title: 'Slack', cwd: input.cwd, project: 'Slack', status: 'working', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } };
    },
  }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('unexpected delegation'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [{ user: 'U2', text: 'hello', ts: '1' }], reply: async () => { throw new Error('unexpected reply'); } }),
    model: async () => { throw new Error('unexpected classifier'); },
  });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects(); await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  await service.mutate('rules', { rules: [{ id: 'r', name: 'Review', enabled: true, condition: 'PR', instructions: 'Review', replyInstructions: 'Propose', provider: 'codex', model: 'gpt-6-astra' }] });
  await service.automation.ingest({ id: 'event', teamId: 'T1', channel: 'G1', user: 'U2', ts: '1', threadTs: '1', text: '<@U1> hello' });
  await service.automation.tick(); assert.deepEqual(service.coordinatorSessionIds(), ['codex:test']);
  runs[0].status = 'completed'; await service.automation.tick(); assert.equal(service.overview().events[0].status, 'completed');
  let admitted!: () => void; let release!: () => void;
  const prepared = new Promise<void>(resolve => { admitted = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const turn = service.withOwnerTurnAdmission(async () => {
    await service.ownerChat('codex:test', 'continue'); admitted(); await hold;
    runs.push({ ...runs[0], id: 'r2', createdAt: '2026-01-02', status: 'running' });
  });
  await prepared;
  const replacing = service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  release(); await turn;
  await assert.rejects(replacing, /진행 중/);
  await assert.rejects(service.mutate('disconnect', {}), /진행 중/);
  await assert.rejects(service.restoreConnection({ enabled: false }), /진행 중/);
  assert.equal(await service.automation.hasUnfinished(), true);
  assert.equal(service.overview().events[0].status, 'running'); assert.equal(service.hasActive(), true);
});

test('coordinator result notifications retain the snapshotted model after rule edits', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-model-'));
  const storage = await externalStorageFixture(t, stateDir);
  const runs: import('../../../shared/types.js').Run[] = [{ id: 'delegated', sessionId: 'work', prompt: '', status: 'completed', createdAt: '', output: 'Done' }];
  const service = new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: {
    list: () => runs,
    create: async input => {
      const run: import('../../../shared/types.js').Run = { id: 'coordinator', sessionId: 'chat', prompt: '', status: 'completed', createdAt: '', output: '' };
      runs.push(run);
      return { run, session: { id: 'chat', nativeId: 'chat', provider: input.provider, cwd: input.cwd, project: 'Slack', title: 'Slack', status: 'completed', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } };
    },
    enqueue: async (_id, _prompt, options) => { assert.equal(options?.model, 'opus'); resumed++; return { ...runs[1], id: 'resumed', status: 'queued' }; },
  }, autoPrompts: { get: () => undefined, submit: async input => { assert.ok(input.provider); return { id: input.requestId, provider: input.provider, prompt: input.prompt, routerModel: 'opus', status: 'completed', createdAt: '', updatedAt: '', runId: 'delegated' }; } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [{ user: 'U2', text: 'Review', ts: '1' }], reply: async () => { throw new Error('Must not send'); } }),
  });
  let resumed = 0;
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects(); await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  const rule = { id: 'r', name: 'Review', enabled: true, condition: 'PR', instructions: 'Review', replyInstructions: 'Propose', provider: 'claude', model: 'opus' };
  await service.mutate('rules', { rules: [rule] });
  await service.automation.ingest({ id: 'event', teamId: 'T1', channel: 'G1', user: 'U2', ts: '1', threadTs: '1', text: 'Review' }); await service.automation.tick();
  await service.mutate('rules', { rules: [{ ...rule, model: 'sonnet' }] });
  await service.tool(service.overview().events[0].id, 'tower_auto_prompt', { requestKey: 'work', ruleId: 'r', prompt: 'Review' });
  await service.automation.tick(); assert.equal(resumed, 1);
});

test('Slack language persists independently of connection and validates authenticated settings input', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-language-'));
  const storage = await externalStorageFixture(t, stateDir);
  const options = { repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not execute'); } }, refresh: async () => {} };
  const dependencies = { client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw new Error('Must not send'); } }) };
  const service = new SlackService(options, dependencies);
  const restarted = new SlackService(options, dependencies);
  t.after(async () => { service.close(); restarted.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects();
  assert.equal(service.overview().language, 'ko');
  for (const language of ['fr', '', true, null, {}]) await assert.rejects(service.mutate('settings', { language }), /설정/);
  await service.mutate('settings', { language: 'en' });
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  assert.equal(service.overview().language, 'en');
  await service.mutate('disconnect', {});
  await restarted.start(); await restarted.startRuntimeEffects();
  assert.equal(restarted.overview().language, 'en');
  await restarted.mutate('settings', { language: 'ko' });
  assert.equal(JSON.parse(await readFile(join(stateDir, 'slack-connection.json'), 'utf8')).language, 'ko');
});

test('owner reply intent uses the configured ephemeral classifier with only owner text and task metadata', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-consent-'));
  const storage = await externalStorageFixture(t, stateDir);
  const run: import('../../../shared/types.js').Run = { id: 'coordinator', sessionId: 'chat', prompt: '', status: 'completed', createdAt: '', output: '' };
  let calls = 0;
  const service = new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: {
    list: () => [run],
    create: async input => ({ run, session: { id: 'chat', nativeId: 'chat', provider: input.provider, cwd: input.cwd, project: 'Slack', title: 'Slack', status: 'completed', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } }),
  }, autoPrompts: { get: () => undefined, submit: async () => { throw Error('unexpected delegation'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [{ user: 'U2', text: 'untrusted channel data', ts: '1' }], reply: async () => { throw Error('unexpected send'); } }),
    model: async (input, dependencies) => {
      calls++; assert.equal(input.provider, 'claude'); assert.equal(input.model, 'opus');
      assert.deepEqual(JSON.parse(input.prompt), { ownerMessage: 'LGTM 달고 슬랙에도 알려주세요', tasks: [] });
      assert.match(input.systemPrompt, /tool-free intent classifier/); assert.match(input.systemPrompt, /quoted/);
      assert.equal(input.prompt.includes('untrusted channel data'), false); assert.equal(dependencies?.stateDir, stateDir);
      return { intent: 'after_work' };
    },
  });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects(); await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  await service.mutate('rules', { rules: [{ id: 'r', name: 'Review', enabled: true, condition: 'PR', instructions: 'Review', replyInstructions: 'Propose', provider: 'claude', model: 'opus' }] });
  await service.automation.ingest({ id: 'event', teamId: 'T1', channel: 'G1', user: 'U2', ts: '1', threadTs: '1', text: '<@U1> hello' });
  await service.automation.tick(); assert.equal(calls, 0);
  await service.ownerChat('chat', 'LGTM 달고 슬랙에도 알려주세요'); assert.equal(calls, 1);
  assert.equal(service.overview().events[0].ownerConditionalReply?.mode, 'composed');
});

test('Slack conversations, their delegated work and result resumes all run as Slack external input', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-origin-'));
  const storage = await externalStorageFixture(t, stateDir);
  type Run = import('../../../shared/types.js').Run;
  type Admission = import('../../../server/runs/manager.js').RunAdmission;
  const runs: Run[] = [{ id: 'delegated', sessionId: 'work', prompt: '', status: 'completed', createdAt: '', output: 'Done' }];
  const admissions: Array<[string, Admission | undefined]> = [];
  const service = new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: {
    list: () => runs,
    create: async (input, internal) => {
      admissions.push(['create', internal]);
      const run: Run = { id: 'coordinator', sessionId: 'chat', prompt: '', status: 'completed', createdAt: '', output: '', autoPromptId: internal?.autoPromptId };
      runs.push(run);
      return { run, session: { id: 'chat', nativeId: 'chat', provider: input.provider, cwd: input.cwd, project: 'Slack', title: 'Slack', status: 'completed', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } };
    },
    enqueue: async (_id, prompt, _options, internal) => { admissions.push(['resume', internal]); resumed.push(prompt); return { ...runs[1], id: 'resumed', status: 'queued' }; },
  }, autoPrompts: { get: id => id === delegatedRequest ? { id, provider: 'codex', prompt: '', routerModel: 'gpt', status: 'completed', createdAt: '', updatedAt: '', runId: 'delegated', sessionId: 'work' } : undefined,
    submit: async (input, internal) => { assert.ok(input.provider); delegatedRequest = input.requestId; admissions.push(['delegate', internal as Admission]); assert.equal(input.sessionMode, 'new');
      return { id: input.requestId, provider: input.provider, prompt: input.prompt, routerModel: 'gpt', status: 'completed', createdAt: '', updatedAt: '', runId: 'delegated', sessionId: 'work' }; } },
  refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [{ user: 'U2', text: 'Review', ts: '1' }], reply: async () => { throw new Error('Must not send'); } }),
  });
  let delegatedRequest = '';
  const resumed: string[] = [];
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects(); await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  await service.mutate('rules', { rules: [{ id: 'r', name: 'Review', enabled: true, condition: 'PR', instructions: 'Review', replyInstructions: 'Propose', provider: 'codex' }] });
  await service.automation.ingest({ id: 'event', teamId: 'T1', channel: 'G1', user: 'U2', ts: '1', threadTs: '1', text: 'Review' });
  await service.automation.tick();
  const workflowId = service.overview().events[0].id;
  await service.tool(workflowId, 'tower_auto_prompt', { requestKey: 'work', ruleId: 'r', prompt: 'Review' });
  runs.find(run => run.id === 'delegated')!.autoPromptId = delegatedRequest;
  await service.automation.tick();
  assert.deepEqual(admissions.map(([step]) => step), ['create', 'delegate', 'resume']);
  assert.doesNotMatch(resumed[0], /Slack thread|files/, 'a result turn brings no Slack messages, so it says nothing about their files');
  for (const [, internal] of admissions) {
    assert.deepEqual(internal?.origin, { kind: 'slack', workflowId });
    assert.equal(internal?.untrustedInput, true);
  }
  const linked = service.linkedSessions();
  assert.ok(linked.sessionIds.has('chat') && linked.sessionIds.has('work'), 'both the coordinator and the delegated session hold Slack content');
  assert.ok(linked.requestIds.has(workflowId) && linked.requestIds.has(delegatedRequest));
});

test('a later message in a handled thread reaches its conversation when the judgment finds it is for the owner', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-follow-'));
  const storage = await externalStorageFixture(t, stateDir);
  let socket: SlackSocketOptions | undefined;
  const runs: Run[] = [];
  const turns: string[] = [];
  const asked: unknown[] = [];
  const engine: DecisionEngine = { provider: 'jev', label: 'Jev', decide: async request => {
    asked.push(request.state);
    const owner = /merge/.test(JSON.stringify((request.state as { new_message: string }).new_message)) ? 0.92 : 0.05;
    return { audience: { choice: owner >= 0.5 ? 'owner' : 'others', probabilities: { owner, others: 1 - owner }, confidence: 0.9 } } as never;
  } };
  const service: SlackService = new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not delegate'); } }, refresh: async () => {},
    followUpEngine: async () => engine,
    runs: { list: () => runs,
      create: (async (request: { prompt: string }) => { const run = { id: 'coordinator-run', sessionId: 'coordinator', prompt: request.prompt, status: 'completed', createdAt: '', output: '' } as Run; runs.push(run); turns.push(request.prompt); return { session: { id: run.sessionId }, run }; }) as never,
      enqueue: (async (sessionId: string, prompt: string, _options: unknown, internal: { autoPromptId: string }) => { const run = { id: `turn-${runs.length}`, sessionId, prompt, status: 'queued', createdAt: '', output: '', autoPromptId: internal.autoPromptId } as Run; runs.push(run); turns.push(prompt); return run; }) as never },
  }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [{ user: 'U2', ts: '100.001', text: '<@U1> review please' }], reply: async () => { throw new Error('Must not send'); } }),
    socket: options => { socket = options; return { start() {}, stop() {} }; },
    model: async () => { throw new Error('Must not start a provider'); },
  });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects();
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  await service.mutate('rules', { rules: [{ id: 'review', name: 'Review', enabled: true, condition: 'review', instructions: 'Review it', replyInstructions: 'Say done', provider: 'claude' }] });
  await service.mutate('settings', { enabled: true });
  await socket!.onEvent({ team_id: 'T1', event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U2', ts: '100.001', text: '<@U1> review please' } });
  await service.automation.tick();
  assert.equal(turns.length, 1);
  const reply = (ts: string, text: string, extra: Record<string, unknown> = {}) => socket!.onEvent({ team_id: 'T1', event_id: `Ev${ts}`, event: { type: 'message', channel: 'C1', user: 'U3', ts, thread_ts: '100.001', text, ...extra } });
  await reply('100.002', 'thanks');
  await reply('100.003', 'fixed the comments, can I merge?');
  await reply('100.004', 'my own note', { user: 'U1' });
  await socket!.onEvent({ team_id: 'T1', event_id: 'Ev-elsewhere', event: { type: 'message', channel: 'C1', user: 'U3', ts: '200.001', text: 'unrelated, can I merge?' } });
  assert.deepEqual(service.overview().events[0].followUps?.map(item => item.ts), ['100.002', '100.003'], 'the owner\'s own messages and other threads are not followed');
  assert.equal(service.overview().events.length, 1, 'a later message never starts another conversation');
  await service.automation.tick();
  assert.equal(turns.length, 2);
  assert.match(turns[1], /can I merge\?/); assert.doesNotMatch(turns[1], /thanks/);
  assert.equal((asked[0] as { owner: string }).owner, '<@U1>');
  assert.match(JSON.stringify(asked[1]), /review please/, 'the judgment sees the first request');
  // A mention in the same thread continues the same conversation too.
  await reply('100.005', '<@U1> one more question');
  assert.equal(service.overview().events.length, 1);
  assert.equal(service.overview().events[0].followUps?.at(-1)?.mentioned, true);
});

test('the working reaction is a saved setting that marks new mentions at once on their message', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-working-'));
  const storage = await externalStorageFixture(t, stateDir);
  let socket: SlackSocketOptions | undefined;
  const reactions: string[] = [];
  // Conversations never start here: the reaction goes on before any of that.
  const create = () => new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: { list: () => [], create: () => new Promise(() => {}) }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not execute'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => new Promise(() => {}), reply: async () => { throw new Error('Must not send'); },
      react: async (channel: string, ts: string, name: string, action: 'add' | 'remove') => { reactions.push(`${action}:${name}:${channel}:${ts}`); } }),
    socket: options => { socket = options; return { start() {}, stop() {} }; },
    model: async () => { throw new Error('Must not start a provider'); },
  });
  let service = create();
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects();
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  assert.equal(service.overview().workingReaction, undefined, 'off by default');
  for (const workingReaction of ['bad name', 7, ':'.repeat(3)]) await assert.rejects(service.mutate('settings', { workingReaction }), { kind: 'invalid' });
  await service.mutate('settings', { enabled: true, workingReaction: ':loading:' });
  assert.equal(service.overview().workingReaction, 'loading');
  await socket!.onEvent({ team_id: 'T1', event_id: 'E1', event: { type: 'message', channel: 'C1', user: 'U2', ts: '100.001', text: '<@U1> deploy dev please' } });
  await until(() => reactions.length > 0);
  assert.deepEqual(reactions, ['add:loading:C1:100.001']);
  // The restart comes after the mark's outcome is saved, never while that save is still in flight.
  const savedMark = async () => (JSON.parse(await readWorkflowFixture(storage.workflows)) as { workflows: { workingMarks?: { state: string }[] }[] }).workflows[0]?.workingMarks?.[0]?.state;
  await until(async () => await savedMark() === 'on');
  service.close(); service = create(); await service.start(); await service.startRuntimeEffects();
  assert.equal(service.overview().workingReaction, 'loading', 'kept across restarts');
  await service.mutate('settings', { workingReaction: '' });
  assert.equal(service.overview().workingReaction, undefined, 'an empty value turns it off');
});

test('account authentication preparation serializes a later owner turn admission', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-account-race-'));
  const storage = await externalStorageFixture(t, stateDir);
  let prepared!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { prepared = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  let admitted = false;
  const service = new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir,
    runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('must not submit'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => { prepared(); await hold; return { teamId: 'T1', userId: 'U9' }; }, thread: async () => [], reply: async () => { throw new Error('must not send'); } }),
    model: async () => { throw new Error('must not start'); },
  });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start();
  const update = service.mutate('connect', { appToken: 'xapp-fixture-1234567890', userToken: 'xoxp-fixture-1234567890' });
  await ready;
  const turn = service.withOwnerTurnAdmission(async () => { admitted = true; assert.equal(service.overview().account?.userId, 'U9'); });
  await Promise.resolve(); assert.equal(admitted, false);
  release(); await update; await turn; assert.equal(admitted, true);
});

test('runtime polling shows its own errors without secrets beside the socket\'s, clears them on recovery and holds automation after a failed rules write', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-poll-'));
  const storage = await externalStorageFixture(t, stateDir);
  let gateFailure: unknown;
  let socket!: SlackSocketOptions;
  const service = new SlackService({ stateDir, repository: storage.workflows,
    effectGate: async () => { if (gateFailure) throw gateFailure; await storage.effectGate(); },
    runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw Error('Must not execute'); } }, refresh: async () => {},
  }, { client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [{ user: 'U2', ts: '2', text: 'fixture failure' }], reply: async () => { throw Error('Must not send'); } }),
    socket: options => { socket = options; return { start() {}, stop() {} }; },
    model: async () => { throw Error('fixture classifier failed'); } });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  await service.start(); await service.startRuntimeEffects();
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  await service.mutate('settings', { enabled: true });
  socket.onStatus!('connected');
  let finished = 0;
  const tick = service.automation.tick.bind(service.automation);
  service.automation.tick = async () => { try { await tick(); } finally { finished++; } };
  // One poll, run to its end: no poll is still in flight when the next step starts.
  const poll = async () => { const before = finished; t.mock.timers.tick(1000); await until(() => finished > before); await new Promise(resolve => setImmediate(resolve)); };
  gateFailure = Object.assign(new Error('secret=xoxp-test-1234567890 https://private/token'), { code: 'EACCES' });
  await poll();
  assert.match(service.overview().error!, /EACCES/);
  assert.equal(service.projection()?.error, service.overview().error);
  assert.doesNotMatch(service.overview().error!, /secret|xoxp|https/);
  await poll();
  assert.match(service.overview().error!, /EACCES/, 'a persistent failure remains visible');
  // The socket's state and the poll's are separate: neither clears the other, and both show together.
  socket.onStatus!('connected');
  assert.match(service.overview().error!, /EACCES/, 'socket recovery cannot clear a polling error');
  socket.onStatus!('error', 'socket unavailable');
  assert.match(service.overview().error!, /socket unavailable/);
  assert.match(service.overview().error!, /EACCES/);
  gateFailure = undefined;
  await poll();
  assert.equal(service.overview().error, 'socket unavailable', 'once the poll recovers only the socket error remains');
  socket.onStatus!('connected');
  assert.equal(service.overview().error, undefined);
  // Each storage refusal has its own wording: a hold says so, an unknown outcome does not, and neither shows the cause's text.
  const { TowerError } = await import('../../../shared/errors.js');
  const { StorageCommandError } = await import('../../../server/storage/contract.js');
  gateFailure = new TowerError('unavailable', 'Permission SQL receipt/effect reconciliation remains held.', { disposition: 'not-admitted' });
  await poll();
  assert.match(service.overview().error!, /보류.*permission-reconciliation/);
  await poll();
  assert.match(service.projection()!.error!, /보류/, 'even a persistent hold remains visible');
  gateFailure = new StorageCommandError({ phase: 'command', code: 'not-ready', message: 'secret xoxp-test-1234567890', disposition: 'not-committed', retryable: false });
  await poll();
  assert.match(service.overview().error!, /보류.*not-ready\/not-committed/);
  assert.doesNotMatch(service.overview().error!, /secret|xoxp/);
  gateFailure = new StorageCommandError({ phase: 'command', code: 'sqlite-error', message: 'private path /secret', disposition: 'unknown', retryable: false });
  await poll();
  assert.match(service.overview().error!, /확인하지 못.*sqlite-error\/unknown/);
  assert.doesNotMatch(service.overview().error!, /보류|secret|private/);
  gateFailure = undefined;
  await poll();
  assert.equal(service.overview().error, undefined, 'the error clears after recovery');
  const rules = [{ id: 'r', name: 'fixture', enabled: true, condition: 'PR', instructions: 'review', replyInstructions: 'propose', provider: 'codex' }];
  const failure = t.mock.method(storage.workflows, 'replaceRules', async () => { throw Object.assign(Error('fixture write failed'), { code: 'EIO' }); });
  await assert.rejects(service.mutate('rules', { rules }), /fixture write failed/);
  failure.mock.restore();
  await poll();
  assert.match(service.overview().error!, /automation-held/, 'a recovered gate does not imply automation resumed');
  assert.match(service.projection()!.error!, /automation-held/);
  service.releaseNewWork();
  await poll();
  assert.equal(service.overview().error, undefined);
  // A workflow that fails keeps its own error; the successful polls around it do not write over it or show it as theirs.
  await service.mutate('rules', { rules });
  await service.automation.ingest({ id: 'EvFailed', teamId: 'T1', channel: 'C1', user: 'U2', ts: '2', threadTs: '2', text: 'fixture failure' });
  await until(async () => { await poll(); return service.overview().events.some(item => item.status === 'error'); });
  await poll();
  assert.equal(service.overview().error, undefined, 'successful polling does not rewrite the actual workflow failure');
  assert.match(service.overview().events.find(item => item.status === 'error')!.error!, /fixture classifier failed/);
  await service.mutate('disconnect', {});
  assert.equal(service.overview().error, undefined, 'discard diagnostics when the account is removed');
});


test('a closed runtime discards late results', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-slow-poll-'));
  const storage = await externalStorageFixture(t, stateDir);
  const service = new SlackService({ stateDir, repository: storage.workflows, effectGate: storage.effectGate,
    runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw Error('Must not execute'); } }, refresh: async () => {},
  }, { client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw Error('Must not send'); } }) });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  await service.start(); await service.startRuntimeEffects();
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  let reject!: (error: unknown) => void;
  const pending = new Promise<void>((_, failure) => { reject = failure; });
  let calls = 0;
  service.automation.tick = () => { calls++; return pending; };
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  service.close();
  reject(new Error('late failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.overview().error, undefined, 'a retired timer cannot publish results');
  let changes = 0;
  service.on('change', () => { changes++; });
  await service.resume();
  service.automation.tick = async () => { calls++; throw null; };
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.overview().error, 'Slack 작업 상태를 확인하지 못했습니다. (internal/unknown)');
  const afterFailure = changes;
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(changes, afterFailure, 'unchanged poll failures do not emit each second');
  service.automation.tick = async () => {};
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.overview().error, undefined);
});


test('slow polls keep subsequent ticks and cannot overwrite newer diagnostics', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-poll-order-'));
  const storage = await externalStorageFixture(t, stateDir);
  const service = new SlackService({ stateDir, repository: storage.workflows, effectGate: storage.effectGate,
    runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw Error('Must not execute'); } }, refresh: async () => {},
  }, { client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw Error('Must not send'); } }) });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  await service.start(); await service.startRuntimeEffects();
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  let finish!: () => void;
  service.automation.tick = () => new Promise<void>(resolve => { finish = resolve; });
  t.mock.timers.tick(1000);
  let calls = 0;
  service.automation.tick = async () => { calls++; throw Object.assign(Error('fixture'), { code: 'EACCES' }); };
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'the next tick still sweeps marks while earlier drain is pending');
  assert.match(service.overview().error!, /EACCES/);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.match(service.overview().error!, /EACCES/, 'an earlier success cannot erase the newer failure');
  service.automation.tick = async () => {};
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.overview().error, undefined);
});

test('overlapping slow failures remain visible even while later polls are pending', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-poll-slow-failure-'));
  const storage = await externalStorageFixture(t, stateDir);
  const service = new SlackService({ stateDir, repository: storage.workflows, effectGate: storage.effectGate,
    runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw Error('Must not execute'); } }, refresh: async () => {},
  }, { client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw Error('Must not send'); } }) });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  await service.start(); await service.startRuntimeEffects();
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  const polls: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  service.automation.tick = () => new Promise<void>((resolve, reject) => { polls.push({ resolve, reject }); });
  t.mock.timers.tick(2000);
  polls[0].reject(Object.assign(Error('fixture'), { code: 'EACCES' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(service.overview().error!, /EACCES/, 'a later pending poll must not hide a completed failure');
  t.mock.timers.tick(1000);
  polls[2].reject(Object.assign(Error('fixture'), { code: 'EACCES' }));
  await new Promise(resolve => setImmediate(resolve));
  polls[1].resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.match(service.overview().error!, /EACCES/, 'an identical newer error still fences an older success');
  t.mock.timers.tick(1000);
  polls[3].resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.overview().error, undefined);
});

test('every reply Tower posts in Slack says "Sent by <name>\'s agent", whoever asked for, approved or worded it (#215)', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-service-'));
  const storage = await externalStorageFixture(t, stateDir);
  let userName: string | undefined = 'karl';
  const notes: (string | undefined)[] = [];
  const service: SlackService = new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not execute'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1', userName }), thread: async () => [], reply: async (_channel, _thread, _text, _mentionable, note) => { notes.push(note); return { ts: '2.0' }; } }),
    socket: () => ({ start: () => {}, stop: () => {} }),
    model: async () => { throw new Error('Must not start a provider'); },
  });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects();
  const credentials = { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' };
  await service.mutate('connect', credentials);
  // Every send path of the automation (slack_send, tower_task_complete, approvals) posts through this one option.
  const { sendReply } = (service.automation as unknown as { options: { sendReply(mention: object, text: string, mentionable: string[]): Promise<{ ts: string }> } }).options;
  const mention = { id: 'e', teamId: 'T1', channel: 'C1', user: 'U2', ts: '1.1', threadTs: '1.0', text: '<@U1> deploy' };
  await sendReply(mention, '배포를 마쳤습니다.', ['U2']);
  userName = undefined;
  await service.mutate('disconnect', {}); await service.mutate('connect', credentials);
  await sendReply(mention, '배포를 마쳤습니다.', ['U2']);
  assert.deepEqual(notes, ["Sent by karl's agent", 'Sent by an agent']);
});

/** What Slack delivers when a colleague's agent posts with that person's token: bot_id under the person's own user. */
const agentMessage = { type: 'message', channel: 'C1', user: 'U2', ts: '1793866477.988899', thread_ts: '1793866332.245539', parent_user_id: 'UBOT', team: 'T1',
  bot_id: 'B0CF75KT0EQ', app_id: 'A0CF5B3TD09', bot_profile: { id: 'B0CF75KT0EQ', deleted: false, name: 'kiwon-agent', app_id: 'A0CF5B3TD09', team_id: 'T1' },
  text: '<@U1> PR 리뷰 부탁드립니다.', blocks: [{ type: 'rich_text' }, { type: 'context' }] };

async function agentMentionFixture(t: import('node:test').TestContext, isPerson: (user: string) => Promise<boolean>, runs: Partial<ConstructorParameters<typeof SlackService>[0]['runs']> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-agent-'));
  const storage = await externalStorageFixture(t, stateDir);
  let socket: SlackSocketOptions | undefined;
  const service: SlackService = new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: { list: () => [], ...runs }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not delegate'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [{ user: 'U2', ts: '100.001', text: '<@U1> review please' }], reply: async () => { throw new Error('Must not send'); }, isPerson }),
    socket: options => { socket = options; return { start() {}, stop() {} }; },
    model: async () => { throw new Error('Must not start a provider'); },
  });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.startRuntimeEffects();
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  await service.mutate('settings', { enabled: true, allowSelfMentions: true });
  // Slack delivers an event again under the same event_id.
  return { service, send: (event: Record<string, unknown>) => socket!.onEvent({ team_id: 'T1', event_id: `Ev${String(event.ts)}`, event }) };
}

test('a colleague\'s agent mentioning the owner reaches Tower as that person\'s request', async t => {
  const asked: string[] = [];
  const { service, send } = await agentMentionFixture(t, async user => { asked.push(user); return user === 'U2'; });
  await send(agentMessage);
  assert.deepEqual(asked, ['U2']);
  assert.deepEqual(service.overview().events.map(item => item.mention.ts), ['1793866477.988899']);
  assert.equal(service.overview().events[0].mention.threadTs, '1793866332.245539');
  assert.equal(service.overview().events[0].mention.user, 'U2');
});

test('real bots, the owner\'s own apps and agent messages without a mention stay out', async t => {
  const asked: string[] = [];
  const { service, send } = await agentMentionFixture(t, async user => { asked.push(user); return user === 'U2'; });
  // GitHub as Slack delivers it: its broadcasts have no bot_profile, so that field cannot tell a person from a bot.
  await send({ ...agentMessage, user: 'UBOT', ts: '1.1', bot_profile: { id: 'B1', name: 'GitHub', user_id: 'UBOT' } });
  await send({ ...agentMessage, user: 'UBOT', ts: '1.2', subtype: 'thread_broadcast', bot_profile: undefined });
  assert.deepEqual(asked, ['UBOT', 'UBOT'], 'a bot is told apart by its user, not by what the message carries');
  asked.length = 0;
  await send({ ...agentMessage, user: 'U1', ts: '1.3', bot_profile: { id: 'B2', name: 'KARL_BOT' } });
  await send({ ...agentMessage, ts: '1.4', text: 'no mention here' });
  await send({ ...agentMessage, ts: '1.5', subtype: 'bot_message' });
  await send({ ...agentMessage, ts: '1.6', user: undefined });
  assert.deepEqual(asked, [], 'these never need a lookup');
  assert.equal(service.overview().events.length, 0);
});

test('an agent\'s mention in a handled thread continues that conversation; without a mention it does not', async t => {
  const runs: Run[] = [];
  const { service, send } = await agentMentionFixture(t, async () => true, { list: () => runs,
    create: (async (request: { prompt: string }) => { const run = { id: 'coordinator-run', sessionId: 'coordinator', prompt: request.prompt, status: 'completed', createdAt: '', output: '' } as Run; runs.push(run); return { session: { id: run.sessionId }, run }; }) as never,
    enqueue: (async () => { throw new Error('Must not deliver here'); }) as never });
  await service.mutate('rules', { rules: [{ id: 'review', name: 'Review', enabled: true, condition: 'review', instructions: 'Review it', replyInstructions: 'Say done', provider: 'claude' }] });
  await send({ type: 'message', channel: 'C1', user: 'U2', ts: '100.001', text: '<@U1> review please' });
  await service.automation.tick();
  await until(() => service.overview().events[0].sessionId === 'coordinator');
  const inThread = { ...agentMessage, thread_ts: '100.001' };
  await send({ ...inThread, ts: '100.002', text: 'comment applied, no mention' });
  await send({ ...inThread, ts: '100.003', text: '<@U1> 코멘트 반영했습니다' });
  assert.equal(service.overview().events.length, 1);
  assert.deepEqual(service.overview().events[0].followUps?.map(({ ts, mentioned }) => [ts, mentioned]), [['100.003', true]]);
});

test('a lookup that may succeed later leaves the event unacknowledged; a missing scope says so and acknowledges', async t => {
  let answer: () => Promise<boolean>;
  const { service, send } = await agentMentionFixture(t, () => answer());
  // Slack's internal_error and service_unavailable reach Tower as request_failed.
  for (const code of ['request_failed', 'network_error', 'ratelimited']) {
    answer = async () => { throw new SlackApiError(code); };
    await assert.rejects(send(agentMessage), new RegExp(code), 'the socket then reconnects without an ack and Slack delivers it again');
  }
  assert.equal(service.overview().events.length, 0);
  answer = async () => { throw new SlackApiError('missing_scope'); };
  await send(agentMessage);
  assert.equal(service.overview().events.length, 0);
  assert.match(service.overview().error ?? '', /users:read/);
  answer = async () => false;
  await send(agentMessage);
  assert.equal(service.overview().events.length, 0, 'a bot is still a bot');
  assert.equal(service.overview().error, undefined, 'the lookup works again, whatever it answered');
  answer = async () => { throw new SlackApiError('missing_scope'); };
  await send(agentMessage);
  assert.match(service.overview().error ?? '', /users:read/);
  answer = async () => true;
  await send(agentMessage);
  assert.equal(service.overview().events.length, 1);
  assert.equal(service.overview().error, undefined);
});

test('connecting again, as the missing scope message asks, clears that message', async t => {
  const { service, send } = await agentMentionFixture(t, async () => { throw new SlackApiError('missing_scope'); });
  await send(agentMessage);
  assert.match(service.overview().error ?? '', /users:read/);
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  assert.equal(service.overview().error, undefined);
});

test('two agents cannot keep mentioning each other in one thread without limit', async t => {
  const { service, send } = await agentMentionFixture(t, async () => true);
  const message = (at: number, thread = '500.000') => ({ ...agentMessage, ts: `500.${at}`, thread_ts: thread });
  for (let at = 0; at < MAX_AGENT_MENTIONS_PER_THREAD; at++) await send(message(at));
  assert.equal(service.overview().events.length, MAX_AGENT_MENTIONS_PER_THREAD);
  await send(message(0));
  assert.equal(service.overview().error, undefined, 'Slack delivering an accepted message again uses up nothing');
  await send(message(MAX_AGENT_MENTIONS_PER_THREAD));
  assert.equal(service.overview().events.length, MAX_AGENT_MENTIONS_PER_THREAD);
  assert.match(service.overview().error ?? '', new RegExp(String(MAX_AGENT_MENTIONS_PER_THREAD)));
  await send(message(9000, '600.000'));
  assert.equal(service.overview().events.length, MAX_AGENT_MENTIONS_PER_THREAD + 1, 'another thread has its own count');
  await send({ type: 'message', channel: 'C1', user: 'U2', ts: '500.9001', thread_ts: '500.000', text: '<@U1> a person, typing' });
  assert.equal(service.overview().events.length, MAX_AGENT_MENTIONS_PER_THREAD + 2, 'people are not limited');
});
