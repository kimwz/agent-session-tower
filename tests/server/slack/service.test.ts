import { externalStorageFixture, readWorkflowFixture } from '../remote/external-storage-fixture.js';
import { until } from '../../helpers/until.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackService } from '../../../server/slack/service.js';
import type { SlackSocketOptions } from '../../../server/slack/socket.js';
import type { DecisionEngine } from '../../../server/decisions/engine.js';
import type { Run } from '../../../shared/types.js';

test('Slack connection stays private, admits only personal mentions, and pauses without losing accepted work', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-service-'));
  const storage = await externalStorageFixture(t, stateDir);
  let socket: SlackSocketOptions | undefined;
  let starts = 0, stops = 0;
  const service: SlackService = new SlackService({ repository: storage.workflows, effectGate: storage.effectGate, stateDir, runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not execute'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw new Error('Must not send'); } }),
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
