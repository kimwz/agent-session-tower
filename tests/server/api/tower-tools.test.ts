import { temporaryFixture, removeTemporaryFixture } from '../../helpers/temporary.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { CapabilityRegistry, callerDelegation, handleMcpRequest, towerTools, type McpContext } from '../../../server/api/mcp.js';
import { runToolResolver } from '../../../server/api/run-tools.js';
import { TowerApi } from '../../../server/api/tower-api.js';
import { TriggerService } from '../../../server/triggers/service.js';
import type { SessionOrigin } from '../../../server/runs/origin.js';
import type { AutoPromptJob, Run, Session } from '../../../shared/types.js';

const session = (id: string): Session => ({ id, nativeId: id.split(':')[1], provider: 'codex', title: 'Mine', cwd: '/project', project: 'project', status: 'idle', statusReason: '',
  createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true });

async function fixture(t: TestContext, preparing?: (internal: { validate?: () => void }) => Promise<void>, withSessions = false) {
  const stateDir = await temporaryFixture('tower-tools-');
  const project = join(stateDir, 'project');
  await mkdir(project);
  const runs: Run[] = [];
  const sessions: Session[] = [];
  const submitted: unknown[] = [];
  const triggers = new TriggerService({ stateDir, tickMs: 60_000, executor: { submitAutoPrompt: async () => { throw new Error('unused'); }, getAutoPrompt: () => undefined,
    create: async () => { throw new Error('unused'); }, enqueue: async () => { throw new Error('unused'); }, runs: () => runs, session: () => undefined } });
  await triggers.start();
  const api = new TowerApi({ stateDir, triggers, runs: { list: () => runs }, ...(withSessions ? { sessions: { list: () => sessions, read: async () => undefined } } : {}),
    autoPrompts: { submit: async (request, internal) => { await preparing?.(internal); submitted.push({ request, internal }); return { id: request.requestId, provider: request.provider, prompt: request.prompt, routerModel: 'r', status: 'queued', createdAt: '', updatedAt: '' } as AutoPromptJob; }, get: () => undefined } });
  const capabilities = new CapabilityRegistry();
  const context: McpContext = { api, capabilities, run: runId => runs.find(run => run.id === runId) };
  t.after(async () => { triggers.close(); await removeTemporaryFixture(stateDir); });
  const ownerTurn = (sessionId: string, towerTools: Run['towerTools'] = 'attached') => { const run: Run = { id: randomUUID(), sessionId, prompt: '', status: 'running', createdAt: '', output: '', origin: { kind: 'owner' }, towerTools }; runs.push(run); return run; };
  const token = (run: Run) => capabilities.issue({ kind: 'owner-run', runId: run.id, sessionId: run.sessionId });
  return { stateDir, project, runs, sessions, submitted, triggers, api, capabilities, context, ownerTurn, token };
}
const schedule = (project: string) => ({ name: 'Morning digest', source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 8 * * *', timezone: 'Asia/Seoul' } },
  handler: { kind: 'task', instructions: 'Summarize new issues', provider: 'codex', target: { mode: 'folder', cwd: project } } });

test('an agent in a turn the owner started manages triggers, and every change names that turn', async t => {
  const f = await fixture(t);
  const run = f.ownerTurn('codex:mine');
  const token = f.token(run);
  const { tools } = await handleMcpRequest(f.context, token, { method: 'tools/list' }) as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> };
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes('triggers_create') && names.includes('sessions_list') && names.includes('autoPrompt_submit'));
  assert.ok(!names.includes('triggers_updateSettings'), 'limits stay with the owner');
  assert.ok(tools.find(tool => tool.name === 'triggers_create')!.inputSchema.required!.includes('requestKey'));
  const created = await handleMcpRequest(f.context, token, { method: 'tools/call', name: 'triggers_create', arguments: { requestKey: 'digest-1', trigger: schedule(f.project) } }) as { trigger: { id: string; createdBy: unknown } };
  assert.deepEqual(created.trigger.createdBy, { kind: 'agent', via: 'mcp', sessionId: 'codex:mine', runId: run.id });
  assert.equal(f.triggers.audit()[0].actor.runId, run.id);
});

test('a retried create with the same requestKey returns the first result instead of creating twice', async t => {
  const f = await fixture(t);
  const token = f.token(f.ownerTurn('codex:mine'));
  const call = (args: Record<string, unknown>) => handleMcpRequest(f.context, token, { method: 'tools/call', name: 'triggers_create', arguments: args });
  const first = await call({ requestKey: 'k', trigger: schedule(f.project) });
  assert.deepEqual(await call({ requestKey: 'k', trigger: schedule(f.project) }), first);
  assert.equal(f.triggers.list().length, 1);
  await assert.rejects(call({ requestKey: 'k', trigger: { ...schedule(f.project), name: 'Other' } }), /already used for a different request/);
  await assert.rejects(call({ trigger: schedule(f.project) }), /needs a requestKey/);
  await assert.rejects(call({ requestKey: 'bad', trigger: { ...schedule(f.project), handler: { ...schedule(f.project).handler, target: { mode: 'folder', cwd: '/nowhere' } } } }), /does not exist/);
  assert.ok(await call({ requestKey: 'bad', trigger: schedule(f.project) }), 'a refused request frees its key');
});

test('a credential works only for the turn it was given to, only while that turn runs', async t => {
  const f = await fixture(t);
  const first = f.ownerTurn('codex:mine');
  const token = f.token(first);
  await assert.rejects(handleMcpRequest(f.context, 'f'.repeat(64), { method: 'tools/list' }), { kind: 'forbidden' });
  first.status = 'completed';
  await assert.rejects(handleMcpRequest(f.context, token, { method: 'tools/list' }), /only during the turn/);
  f.ownerTurn('codex:mine');
  await assert.rejects(handleMcpRequest(f.context, token, { method: 'tools/list' }), /only during the turn/, 'the next owner turn does not revive an old credential');
  const forwarded = f.ownerTurn('codex:other', 'desktop-app');
  await assert.rejects(handleMcpRequest(f.context, f.token(forwarded), { method: 'tools/list' }), /only during the turn/, 'a turn in the desktop app never had the tools');
  const outside = f.ownerTurn('codex:issue', 'external-input');
  await assert.rejects(handleMcpRequest(f.context, f.token(outside), { method: 'tools/list' }), /only during the turn/);
});

test('every change an agent makes is keyed, so a retry after a lost reply returns the first result', async t => {
  const f = await fixture(t);
  const run = f.ownerTurn('codex:mine');
  const call = (name: string, args: Record<string, unknown>) => handleMcpRequest(f.context, f.token(run), { method: 'tools/call', name, arguments: args });
  const { trigger } = await call('triggers_create', { requestKey: 'make', trigger: schedule(f.project) }) as { trigger: { id: string; revision: number } };
  await assert.rejects(call('triggers_setEnabled', { id: trigger.id, expectedRevision: 1, enabled: false }), /needs a requestKey/);
  const first = await call('triggers_setEnabled', { requestKey: 'off', id: trigger.id, expectedRevision: 1, enabled: false });
  assert.deepEqual(await call('triggers_setEnabled', { requestKey: 'off', id: trigger.id, expectedRevision: 1, enabled: false }), first, 'a retried change is not refused as stale');
  const other = f.ownerTurn('codex:mine-2');
  await handleMcpRequest(f.context, f.token(other), { method: 'tools/call', name: 'triggers_create', arguments: { requestKey: 'make', trigger: { ...schedule(f.project), name: 'Another turn' } } });
  assert.equal(f.triggers.list().length, 2, 'keys belong to the run that used them');
  const requestId = randomUUID();
  await call('autoPrompt_submit', { requestId, provider: 'codex', prompt: 'Fix the flaky test' });
  await handleMcpRequest(f.context, f.token(other), { method: 'tools/call', name: 'autoPrompt_submit', arguments: { requestId, provider: 'codex', prompt: 'Fix the flaky test' } });
  assert.equal(f.submitted.length, 1, 'one Auto Prompt request is submitted once, whichever turn retries it');
});

test('work an agent hands to Auto Prompt runs as the agent’s, never as the owner’s', async t => {
  const f = await fixture(t);
  const run = f.ownerTurn('codex:mine');
  const token = f.token(run);
  const requestId = randomUUID();
  await handleMcpRequest(f.context, token, { method: 'tools/call', name: 'autoPrompt_submit', arguments: { requestId, provider: 'codex', prompt: 'Fix the flaky test' } });
  const { validate, ...admission } = (f.submitted[0] as { internal: { validate?: () => void } }).internal;
  assert.equal(typeof validate, 'function');
  assert.deepEqual(admission, { origin: { kind: 'agent', runId: run.id }, delegation: { parentRunId: run.id, rootRunId: run.id } });
  await assert.rejects(f.api.call('triggers.updateSettings', { settings: { maxTriggers: 5, maxConcurrentRuns: 1, maxEventsPerHour: 5 } }, { kind: 'agent', via: 'mcp', sessionId: 'codex:mine' }), { kind: 'forbidden' });
});

test('a Slack conversation credential opens only that conversation’s Slack tools', async t => {
  const f = await fixture(t);
  const calls: unknown[] = [];
  const token = f.capabilities.issue({ kind: 'slack-workflow', workflowId: 'workflow-1' });
  const context = { ...f.context, slackTool: async (workflowId: string, name: string, args: Record<string, unknown>) => { calls.push([workflowId, name, args]); return { ok: true }; } };
  assert.ok(((await handleMcpRequest(context, token, { method: 'tools/list' })) as { tools: Array<{ name: string }> }).tools.every(tool => /^(slack|tower)_/.test(tool.name)));
  await handleMcpRequest(context, token, { method: 'tools/call', name: 'slack_thread', arguments: {} });
  await assert.rejects(handleMcpRequest(context, token, { method: 'tools/call', name: 'triggers_create', arguments: {} }), /Unknown Slack session tool/);
  assert.deepEqual(calls, [['workflow-1', 'slack_thread', {}]]);
});

test('only owner turns in the owner’s own conversations receive Tower tools; every turn here can look up sessions', async t => {
  const f = await fixture(t);
  const origins = new Map<string, SessionOrigin | undefined>([
    ['codex:native', undefined], ['codex:created', { kind: 'owner', untrustedInput: false }], ['codex:issue', { kind: 'trigger', triggerId: 'gh', untrustedInput: true }],
    ['codex:scheduled', { kind: 'trigger', triggerId: 'daily', untrustedInput: false }], ['codex:coordinator', { kind: 'slack', untrustedInput: true }],
  ]);
  const turn = (id: string, origin: Run['origin']): Run => ({ id: randomUUID(), sessionId: id, prompt: '', status: 'queued', createdAt: '', output: '', origin });
  const resolver = runToolResolver({ stateDir: f.stateDir, capabilities: f.capabilities, runs: { sessionOrigin: id => origins.get(id) }, browsers: () => ({ playwright: true, claudeInChrome: false }),
    slack: { sessionMcp: id => id === 'codex:coordinator' ? { tower_slack: { command: 'node', args: ['index.js', '--slack-mcp', f.stateDir, 'wf-1'] } } : undefined } });
  const resolve = (origin: Run['origin'], target: Session) => resolver(turn(target.id, origin), target);
  const owner = { kind: 'owner' as const };
  const native = resolve(owner, session('codex:native'));
  assert.equal(native.towerTools, 'attached');
  assert.equal(native.required, false, 'a desktop-app turn may still go ahead without them');
  assert.deepEqual(native.servers!.tower.args.slice(-2), ['--tower-mcp', f.stateDir]);
  assert.match(native.servers!.tower.env!.TOWER_MCP_CAPABILITY, /^[a-f\d]{64}$/);
  assert.equal(resolve(owner, session('codex:created')).towerTools, 'attached');
  const lookups = (tools: ReturnType<typeof resolve>) => Object.keys(tools.servers ?? {}).sort();
  assert.deepEqual(lookups(native), ['browser', 'browser_light', 'tower', 'tower_local', 'tower_sessions']);
  assert.deepEqual(native.servers!.tower_sessions.args.slice(-2), ['--sessions-mcp', f.stateDir]);
  assert.equal(native.servers!.tower_sessions.env, undefined, 'its key stays in the state directory');
  const issue = resolve(owner, session('codex:issue'));
  assert.deepEqual([issue.towerTools, lookups(issue)], ['external-input', ['browser', 'browser_light', 'tower_sessions']]);
  assert.ok(issue.servers!.browser.args.includes('--outside-content'), 'outside content never reaches the saved logins or this computer\'s own addresses');
  assert.ok(!native.servers!.browser.args.includes('--outside-content'));
  const scheduled = resolve(owner, session('codex:scheduled'));
  assert.deepEqual([scheduled.towerTools, lookups(scheduled)], ['not-owner-session', ['browser', 'browser_light', 'tower_sessions']]);
  assert.deepEqual(lookups(resolve({ kind: 'trigger', triggerId: 'daily' }, session('codex:native'))), ['browser', 'browser_light', 'tower_sessions']);
  assert.deepEqual(lookups(resolve({ kind: 'agent' }, session('codex:native'))), ['browser', 'browser_light', 'tower_sessions']);
  assert.deepEqual(lookups(resolve({ kind: 'owner', controllerId: 'c'.repeat(32) }, session('codex:native'))), ['browser', 'browser_light', 'tower'], 'a controlling computer keeps to what it may see');
  const coordinator = resolve(owner, session('codex:coordinator'));
  assert.equal(coordinator.required, true);
  assert.deepEqual(lookups(coordinator), ['browser', 'browser_light', 'tower_sessions', 'tower_slack']);
  assert.equal(f.capabilities.resolve(coordinator.servers!.tower_slack.env!.TOWER_MCP_CAPABILITY)?.kind, 'slack-workflow');
  assert.equal(towerTools().some(tool => tool.name === 'triggers_updateSettings'), false);
});

test('the Tower tool server lists and calls tools through the worker with its capability', async t => {
  const { startTowerMcp } = await import('../../../server/slack/mcp-bridge.js');
  const { startRunnerHost } = await import('../../../server/runs/worker.js');
  const { RunManager } = await import('../runs/sql-fixture.js');
  const { EventEmitter } = await import('node:events');
  const { runnerPaths } = await import('../../../server/runs/runner-protocol.js');
  const f = await fixture(t);
  const runs = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000, findExecutable: async () => undefined });
  await runs.start();
  const list = runs.list.bind(runs);
  runs.list = () => [...list(), ...f.runs];
  const sessions = Object.assign(new EventEmitter(), { list: () => [] }) as unknown as import('../../../server/sessions/service.js').SessionService;
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions, runs, api: f.api, capabilities: f.capabilities });
  const previous = process.env.TOWER_MCP_CAPABILITY;
  process.env.TOWER_MCP_CAPABILITY = f.token(f.ownerTurn('codex:mine'));
  let text = '';
  try {
    const frames = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'triggers_create', arguments: { requestKey: 'a', trigger: schedule(f.project) } } }];
    await startTowerMcp(f.stateDir, Readable.from(frames.map(frame => JSON.stringify(frame) + '\n')), new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } }));
  } finally {
    if (previous === undefined) delete process.env.TOWER_MCP_CAPABILITY; else process.env.TOWER_MCP_CAPABILITY = previous;
    await host.close(); await runs.close(); await rm((await runnerPaths(f.stateDir)).directory, { recursive: true, force: true });
  }
  const [listed, called] = text.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === 'triggers_create'));
  assert.equal(called.result.isError, undefined);
  assert.equal(f.triggers.list()[0].createdBy.kind, 'agent');
});

test('a full retry ledger refuses new agent changes but still answers retries of recorded ones', async t => {
  const f = await fixture(t);
  const run = f.ownerTurn('codex:mine');
  const call = (args: Record<string, unknown>) => handleMcpRequest(f.context, f.token(run), { method: 'tools/call', name: 'triggers_create', arguments: args });
  const first = await call({ requestKey: 'first', trigger: schedule(f.project) });
  const ledger = (f.api as unknown as { requests: Map<string, unknown> }).requests;
  for (let index = 0; ledger.size < 1000; index++) ledger.set(`filler\n${index}`, { at: Date.now(), fingerprint: 'x', status: 'done', result: {} });
  await assert.rejects(call({ requestKey: 'new', trigger: { ...schedule(f.project), name: 'One too many' } }), { kind: 'rate-limited' });
  assert.deepEqual(await call({ requestKey: 'first', trigger: schedule(f.project) }), first);
  assert.equal(f.triggers.list().length, 1);
});

test('the standing session key opens only the read-only session tools, for any caller', async t => {
  const f = await fixture(t);
  const key = 'b'.repeat(64);
  f.capabilities.grant(key, { kind: 'session-reader' });
  const { tools } = await handleMcpRequest(f.context, key, { method: 'tools/list' }) as { tools: Array<{ name: string }> };
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['models_get', 'sessions_list', 'sessions_read', 'sessions_search']);
  await assert.rejects(handleMcpRequest(f.context, key, { method: 'tools/call', name: 'triggers_create', arguments: { requestKey: 'k', trigger: schedule(f.project) } }), { kind: 'not-found' });
  await assert.rejects(handleMcpRequest(f.context, key, { method: 'tools/call', name: 'autoPrompt_submit', arguments: {} }), { kind: 'not-found' });
  // No sessions service in this fixture: the call reaches the operation and reports that.
  await assert.rejects(handleMcpRequest(f.context, key, { method: 'tools/call', name: 'sessions_list', arguments: {} }), { kind: 'unavailable' });
});

test('the session tool server answers through the worker with the key kept in the state directory', async t => {
  const { startSessionsMcp, sessionToolsKey } = await import('../../../server/api/session-tools.js');
  const { startRunnerHost } = await import('../../../server/runs/worker.js');
  const { RunManager } = await import('../runs/sql-fixture.js');
  const { EventEmitter } = await import('node:events');
  const { runnerPaths } = await import('../../../server/runs/runner-protocol.js');
  const f = await fixture(t);
  const out = async (frames: unknown[]) => {
    let text = '';
    await startSessionsMcp(f.stateDir, Readable.from(frames.map(frame => JSON.stringify(frame) + '\n')), new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } }));
    return text.trim().split('\n').map(line => JSON.parse(line));
  };
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  // Before Tower has made its key, the tool says so instead of failing obscurely.
  assert.match((await out([list]))[0].error.message, /has not started/);
  const runs = new RunManager({ stateDir: f.stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000, findExecutable: async () => undefined });
  await runs.start();
  const sessions = Object.assign(new EventEmitter(), { list: () => [] }) as unknown as import('../../../server/sessions/service.js').SessionService;
  f.capabilities.grant(await sessionToolsKey(f.stateDir), { kind: 'session-reader' });
  const host = await startRunnerHost({ stateDir: f.stateDir, sessions, runs, api: f.api, capabilities: f.capabilities });
  let replies;
  try { replies = await out([list, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'triggers_list', arguments: {} } }]); }
  finally { await host.close(); await runs.close(); await rm((await runnerPaths(f.stateDir)).directory, { recursive: true, force: true }); }
  assert.deepEqual(replies[0].result.tools.map((tool: { name: string }) => tool.name).sort(), ['models_get', 'sessions_list', 'sessions_read', 'sessions_search']);
  assert.equal(replies[1].result.isError, true, 'nothing but the session tools');
  assert.equal(await sessionToolsKey(f.stateDir), await sessionToolsKey(f.stateDir), 'the key is kept');
});

test('the owner\'s turns in the master\'s folder also get the master\'s page tools; nothing else does', async t => {
  const f = await fixture(t);
  const resolver = runToolResolver({ stateDir: f.stateDir, capabilities: f.capabilities, runs: { sessionOrigin: () => undefined }, browsers: () => ({ playwright: true, claudeInChrome: false }) });
  const turn = (id: string, origin: Run['origin']): Run => ({ id: randomUUID(), sessionId: id, prompt: '', status: 'queued', createdAt: '', output: '', origin });
  const master = { ...session('claude:master'), cwd: join(f.stateDir, 'master-session') };
  const tools = resolver(turn(master.id, { kind: 'owner' }), master);
  assert.deepEqual(Object.keys(tools.servers ?? {}).sort(), ['browser', 'browser_light', 'tower', 'tower_master', 'tower_sessions']);
  assert.deepEqual(tools.servers!.tower_master.args.slice(-2), ['--master-mcp', f.stateDir]);
  assert.equal(tools.servers!.tower_master.env, undefined, 'it reaches the master host through the owner-only socket');
  assert.equal(tools.required, false);
  assert.equal(resolver(turn(master.id, { kind: 'owner', controllerId: 'c'.repeat(32) }), master).servers?.tower_master, undefined, 'not from a controlling computer');
  assert.equal(resolver(turn(master.id, { kind: 'agent' }), master).servers?.tower_master, undefined);
  assert.equal(resolver(turn('codex:native', { kind: 'owner' }), session('codex:native')).servers?.tower_master, undefined);
});


test('a trusted Claude conversation gets the owner\'s Chrome as its strong browser; one with outside content does not', async t => {
  const f = await fixture(t);
  const origins = new Map<string, SessionOrigin>([['claude:mine', { kind: 'owner', untrustedInput: false }], ['claude:slack', { kind: 'slack', untrustedInput: true }]]);
  const resolver = runToolResolver({ stateDir: f.stateDir, capabilities: f.capabilities, runs: { sessionOrigin: id => origins.get(id) }, browsers: () => ({ playwright: true, claudeInChrome: true }) });
  const turn = (id: string): Run => ({ id: randomUUID(), sessionId: id, prompt: '', status: 'queued', createdAt: '', output: '', origin: { kind: 'owner' } });
  const claude = (id: string): Session => ({ ...session(id), provider: 'claude' });
  assert.equal(resolver(turn('claude:mine'), claude('claude:mine')).claudeChrome, true);
  assert.equal(resolver(turn('claude:slack'), claude('claude:slack')).claudeChrome, false);
  assert.equal(resolver(turn('codex:mine'), session('codex:mine')).claudeChrome, false);
});

test('reporting credentials prove a live local caller but cannot grant owner tools', async t => {
  const f = await fixture(t);
  const run = f.ownerTurn('codex:caller');
  run.delegation = { parentRunId: 'intermediate', rootRunId: 'master' };
  const token = f.capabilities.issue({ kind: 'caller-run', runId: run.id, sessionId: run.sessionId });
  const resolve = (key: string) => callerDelegation(f.capabilities, f.context.run, key);
  assert.deepEqual(resolve(token), { parentRunId: run.id, rootRunId: 'master' });
  await assert.rejects(handleMcpRequest(f.context, token, { method: 'tools/list' }), { kind: 'forbidden' });
  assert.throws(() => resolve(f.token(run)), { kind: 'forbidden' });
  assert.throws(() => resolve('invalid'), { kind: 'forbidden' });
  const mismatched = f.capabilities.issue({ kind: 'caller-run', runId: run.id, sessionId: 'codex:other' });
  assert.throws(() => resolve(mismatched), { kind: 'forbidden' });
  run.status = 'completed';
  assert.throws(() => resolve(token), { kind: 'forbidden', disposition: 'not-admitted' });
  f.ownerTurn(run.sessionId);
  assert.throws(() => resolve(token), { kind: 'forbidden' });
  run.status = 'running'; run.origin = { kind: 'owner', controllerId: 'c'.repeat(32) };
  assert.throws(() => resolve(token), { kind: 'forbidden' });
});

test('only existing owner authority gets local tools; reporting env never grants tools or crosses controllers', async t => {
  const f = await fixture(t);
  const resolver = runToolResolver({ stateDir: f.stateDir, runs: { sessionOrigin: () => undefined }, capabilities: f.capabilities });
  const owner = f.ownerTurn('codex:local');
  const tools = resolver(owner, session(owner.sessionId));
  const token = tools.env!.TOWER_CALLER_CAPABILITY;
  assert.equal(tools.servers!.tower_local.env!.TOWER_CALLER_CAPABILITY, token);
  assert.deepEqual(f.capabilities.resolve(token), { kind: 'caller-run', runId: owner.id, sessionId: owner.sessionId });
  const delegated = resolver({ ...owner, origin: { kind: 'agent' } }, session(owner.sessionId));
  assert.ok(delegated.env!.TOWER_CALLER_CAPABILITY);
  assert.equal(delegated.servers!.tower_local, undefined);
  assert.equal(delegated.servers!.tower, undefined);
  const remote = resolver({ ...owner, origin: { kind: 'owner', controllerId: 'c'.repeat(32) } }, session(owner.sessionId));
  assert.equal(remote.env, undefined);
  assert.equal(remote.servers!.tower_local, undefined);
});


test('MCP rechecks parent authority after async preparation and before new job admission', async t => {
  for (const change of ['completed', 'cancelled', 'session', 'origin', 'tools', 'controller', 'credential'] as const) {
    await t.test(change, async t => {
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const f = await fixture(t, async internal => { entered(); await gate; internal.validate?.(); });
      const run = f.ownerTurn('codex:parent');
      const token = f.token(run);
      const pending = handleMcpRequest(f.context, token, { method: 'tools/call', name: 'autoPrompt_submit', arguments: { requestId: randomUUID(), provider: 'codex', prompt: 'follow up' } });
      const refused = assert.rejects(pending, { kind: 'forbidden', disposition: 'not-admitted' });
      await ready;
      switch (change) {
        case 'completed': run.status = 'completed'; break;
        case 'cancelled': run.status = 'cancelled'; break;
        case 'session': run.sessionId = 'codex:other'; break;
        case 'origin': run.origin = { kind: 'agent' }; break;
        case 'tools': run.towerTools = 'desktop-app'; break;
        case 'controller': run.origin = { kind: 'owner', controllerId: 'c'.repeat(32) }; break;
        case 'credential': f.capabilities.grant(token, { kind: 'session-reader' }); break;
      }
      release();
      await refused;
      assert.equal(f.submitted.length, 0, 'no new durable job was admitted');
    });
  }
});


test('a master run-scoped MCP Auto Prompt gets its role in code without changing agent authority', async t => {
  const f = await fixture(t, undefined, true);
  const master = { ...session('codex:master'), cwd: join(f.stateDir, 'master-session') };
  f.sessions.push(master);
  const run = f.ownerTurn(master.id);
  const input = { requestId: randomUUID(), prompt: 'delegate without model instructions', cwd: f.project };
  await handleMcpRequest(f.context, f.token(run), { method: 'tools/call', name: 'autoPrompt_submit', arguments: input });
  const saved = f.submitted[0] as { request: { modelRole?: string; provider?: string }; internal: { origin: { kind: string } } };
  assert.equal(saved.request.modelRole, 'master.worker'); assert.equal(saved.request.provider, undefined);
  assert.equal(saved.internal.origin.kind, 'agent');
  const regular = f.ownerTurn('codex:ordinary');
  await assert.rejects(handleMcpRequest(f.context, f.token(regular), { method: 'tools/call', name: 'autoPrompt_submit', arguments: { ...input, requestId: randomUUID() } }), /provider/);
});
