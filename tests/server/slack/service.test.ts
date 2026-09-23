import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackService } from '../../../server/slack/service.js';
import type { SlackSocketOptions } from '../../../server/slack/socket.js';

test('Slack connection stays private, admits only personal mentions, and pauses without losing accepted work', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-service-'));
  let socket: SlackSocketOptions | undefined;
  let starts = 0, stops = 0;
  const service: SlackService = new SlackService({ stateDir, runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not execute'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw new Error('Must not send'); } }),
    socket: options => { socket = options; return { start: () => { starts++; }, stop: () => { stops++; } }; },
    model: async () => { throw new Error('Must not start a provider'); },
  });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start();
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
  await assert.rejects(service.mutate('rules', { rules: [{}] }), { statusCode: 400 });
  await assert.rejects(service.mutate('settings', { enabled: true, extra: true }), { statusCode: 400 });
});

test('self-mention testing is opt-in, persists, and keeps bot, edit, and escaped reply filters', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-self-'));
  let socket: SlackSocketOptions | undefined;
  let socketStarts = 0;
  const create = () => new SlackService({ stateDir, runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not execute'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw new Error('Must not send'); } }),
    socket: options => { socket = options; return { start() { socketStarts++; }, stop() {} }; },
    model: async () => { throw new Error('Must not start a provider'); },
  });
  let service = create();
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start();
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  assert.equal(service.overview().allowSelfMentions, false);
  await service.mutate('settings', { enabled: true });
  const event = { type: 'message', channel: 'GPRIVATE', channel_type: 'group', user: 'U1', ts: '100.001', text: '<@U1> test review' };
  const send = (id: string, patch = {}) => socket!.onEvent({ team_id: 'T1', event_id: id, event: { ...event, ...patch } });
  await send('default-off');
  assert.equal(service.overview().events.length, 0);
  for (const body of [{}, { allowSelfMentions: 'true' }, { enabled: null }, { allowSelfMentions: true, unexpected: true }]) {
    await assert.rejects(service.mutate('settings', body), { statusCode: 400 });
  }
  await service.mutate('settings', { allowSelfMentions: true });
  assert.equal(service.overview().enabled, true, 'partial settings preserve monitoring');
  assert.equal(socketStarts, 1, 'self-mention changes preserve the connected socket');
  await send('self-private');
  assert.equal(service.overview().events[0]?.mention.channel, 'GPRIVATE');
  await service.automation.tick();
  service.close();
  service = create();
  await service.start();
  assert.equal(service.overview().allowSelfMentions, true);
  assert.equal(service.overview().enabled, true);
  await send('after-restart');
  for (const [id, patch] of [
    ['bot', { bot_id: 'B1' }], ['edit', { subtype: 'message_changed' }],
    ['hidden', { hidden: true }], ['escaped-reply', { text: '&lt;@U1&gt; review complete' }],
  ] as const) await send(id, patch);
  assert.equal(service.overview().events.length, 2);
  await service.mutate('settings', { allowSelfMentions: false });
  await send('disabled-again');
  assert.equal(service.overview().events.length, 2);
  await service.mutate('settings', { enabled: false, allowSelfMentions: true });
  assert.equal(service.overview().enabled, false);
  assert.equal(service.overview().allowSelfMentions, true);
});

test('dedicated coordinator exposes scoped MCP during creation and follows later native turns', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-coordinator-'));
  const runs: import('../../../shared/types.js').Run[] = [];
  const service: SlackService = new SlackService({ stateDir, runs: {
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
      return { run, session: { id: run.sessionId, nativeId: 'test', provider: 'codex', title: 'Slack', cwd: input.cwd, project: 'Slack', status: 'working', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } };
    },
  }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('unexpected delegation'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [{ user: 'U2', text: 'hello', ts: '1' }], reply: async () => { throw new Error('unexpected reply'); } }),
    model: async () => { throw new Error('unexpected classifier'); },
  });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  await service.mutate('rules', { rules: [{ id: 'r', name: 'Review', enabled: true, condition: 'PR', instructions: 'Review', replyInstructions: 'Propose', provider: 'codex', model: 'gpt-6-astra' }] });
  await service.automation.ingest({ id: 'event', teamId: 'T1', channel: 'G1', user: 'U2', ts: '1', threadTs: '1', text: '<@U1> hello' });
  await service.automation.tick(); assert.deepEqual(service.coordinatorSessionIds(), ['codex:test']);
  runs[0].status = 'completed'; await service.automation.tick(); assert.equal(service.overview().events[0].status, 'completed');
  runs.push({ ...runs[0], id: 'r2', createdAt: '2026-01-02', status: 'running' });
  assert.equal(service.overview().events[0].status, 'running'); assert.equal(service.hasActive(), true);
});

test('coordinator result notifications retain the snapshotted model after rule edits', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-model-'));
  const runs: import('../../../shared/types.js').Run[] = [{ id: 'delegated', sessionId: 'work', prompt: '', status: 'completed', createdAt: '', output: 'Done' }];
  const service = new SlackService({ stateDir, runs: {
    list: () => runs,
    create: async input => {
      const run: import('../../../shared/types.js').Run = { id: 'coordinator', sessionId: 'chat', prompt: '', status: 'completed', createdAt: '', output: '' };
      runs.push(run);
      return { run, session: { id: 'chat', nativeId: 'chat', provider: input.provider, cwd: input.cwd, project: 'Slack', title: 'Slack', status: 'completed', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } };
    },
    enqueue: async (_id, _prompt, options) => { assert.equal(options?.model, 'opus'); resumed++; return { ...runs[1], id: 'resumed', status: 'queued' }; },
  }, autoPrompts: { get: () => undefined, submit: async input => ({ id: input.requestId, provider: input.provider, prompt: input.prompt, routerModel: 'opus', status: 'completed', createdAt: '', updatedAt: '', runId: 'delegated' }) }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [{ user: 'U2', text: 'Review', ts: '1' }], reply: async () => { throw new Error('Must not send'); } }),
  });
  let resumed = 0;
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start(); await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  const rule = { id: 'r', name: 'Review', enabled: true, condition: 'PR', instructions: 'Review', replyInstructions: 'Propose', provider: 'claude', model: 'opus' };
  await service.mutate('rules', { rules: [rule] });
  await service.automation.ingest({ id: 'event', teamId: 'T1', channel: 'G1', user: 'U2', ts: '1', threadTs: '1', text: 'Review' }); await service.automation.tick();
  await service.mutate('rules', { rules: [{ ...rule, model: 'sonnet' }] });
  await service.tool(service.overview().events[0].id, 'tower_auto_prompt', { requestKey: 'work', ruleId: 'r', prompt: 'Review' });
  await service.automation.tick(); assert.equal(resumed, 1);
});

test('Slack language persists independently of connection and validates authenticated settings input', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-language-'));
  const options = { stateDir, runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not execute'); } }, refresh: async () => {} };
  const dependencies = { client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw new Error('Must not send'); } }) };
  const service = new SlackService(options, dependencies);
  const restarted = new SlackService(options, dependencies);
  t.after(async () => { service.close(); restarted.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start();
  assert.equal(service.overview().language, 'ko');
  for (const language of ['fr', '', true, null, {}]) await assert.rejects(service.mutate('settings', { language }), /설정/);
  await service.mutate('settings', { language: 'en' });
  await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  assert.equal(service.overview().language, 'en');
  await service.mutate('disconnect', {});
  await restarted.start();
  assert.equal(restarted.overview().language, 'en');
  await restarted.mutate('settings', { language: 'ko' });
  assert.equal(JSON.parse(await readFile(join(stateDir, 'slack-connection.json'), 'utf8')).language, 'ko');
});

test('owner reply intent uses the configured ephemeral classifier with only owner text and task metadata', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-consent-'));
  const run: import('../../../shared/types.js').Run = { id: 'coordinator', sessionId: 'chat', prompt: '', status: 'completed', createdAt: '', output: '' };
  let calls = 0;
  const service = new SlackService({ stateDir, runs: {
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
  await service.start(); await service.mutate('connect', { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' });
  await service.mutate('rules', { rules: [{ id: 'r', name: 'Review', enabled: true, condition: 'PR', instructions: 'Review', replyInstructions: 'Propose', provider: 'claude', model: 'opus' }] });
  await service.automation.ingest({ id: 'event', teamId: 'T1', channel: 'G1', user: 'U2', ts: '1', threadTs: '1', text: '<@U1> hello' });
  await service.automation.tick(); assert.equal(calls, 0);
  await service.ownerChat('chat', 'LGTM 달고 슬랙에도 알려주세요'); assert.equal(calls, 1);
  assert.equal(service.overview().events[0].ownerConditionalReply?.mode, 'composed');
});
