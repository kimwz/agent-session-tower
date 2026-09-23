import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { CapabilityRegistry, handleMcpRequest, towerTools, type McpContext } from '../../../server/api/mcp.js';
import { runToolResolver } from '../../../server/api/run-tools.js';
import { TowerApi } from '../../../server/api/tower-api.js';
import { TriggerService } from '../../../server/triggers/service.js';
import type { SessionOrigin } from '../../../server/runs/origin.js';
import type { AutoPromptJob, Run, Session } from '../../../shared/types.js';

const session = (id: string): Session => ({ id, nativeId: id.split(':')[1], provider: 'codex', title: 'Mine', cwd: '/project', project: 'project', status: 'idle', statusReason: '',
  createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true });

async function fixture(t: TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-tools-'));
  const project = join(stateDir, 'project');
  await mkdir(project);
  const runs: Run[] = [];
  const submitted: unknown[] = [];
  const triggers = new TriggerService({ stateDir, tickMs: 60_000, executor: { submitAutoPrompt: async () => { throw new Error('unused'); }, getAutoPrompt: () => undefined,
    create: async () => { throw new Error('unused'); }, enqueue: async () => { throw new Error('unused'); }, runs: () => runs, session: () => undefined } });
  await triggers.start();
  const api = new TowerApi({ stateDir, triggers, runs: { list: () => runs },
    autoPrompts: { submit: async (request, internal) => { submitted.push({ request, internal }); return { id: request.requestId, provider: request.provider, prompt: request.prompt, routerModel: 'r', status: 'queued', createdAt: '', updatedAt: '' } as AutoPromptJob; }, get: () => undefined } });
  const capabilities = new CapabilityRegistry();
  const context: McpContext = { api, capabilities, run: runId => runs.find(run => run.id === runId) };
  t.after(async () => { triggers.close(); await rm(stateDir, { recursive: true, force: true }); });
  const ownerTurn = (sessionId: string, towerTools: Run['towerTools'] = 'attached') => { const run: Run = { id: randomUUID(), sessionId, prompt: '', status: 'running', createdAt: '', output: '', origin: { kind: 'owner' }, towerTools }; runs.push(run); return run; };
  const token = (run: Run) => capabilities.issue({ kind: 'owner-run', runId: run.id, sessionId: run.sessionId });
  return { stateDir, project, runs, submitted, triggers, api, capabilities, context, ownerTurn, token };
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
  await assert.rejects(handleMcpRequest(f.context, 'f'.repeat(64), { method: 'tools/list' }), { statusCode: 403 });
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
  assert.deepEqual((f.submitted[0] as { internal: unknown }).internal, { origin: { kind: 'agent', runId: run.id } });
  await assert.rejects(f.api.call('triggers.updateSettings', { settings: { maxTriggers: 5, maxConcurrentRuns: 1, maxEventsPerHour: 5 } }, { kind: 'agent', via: 'mcp', sessionId: 'codex:mine' }), { statusCode: 403 });
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

test('only owner turns in the owner’s own conversations receive Tower tools', async t => {
  const f = await fixture(t);
  const origins = new Map<string, SessionOrigin | undefined>([
    ['codex:native', undefined], ['codex:created', { kind: 'owner', untrustedInput: false }], ['codex:issue', { kind: 'trigger', triggerId: 'gh', untrustedInput: true }],
    ['codex:scheduled', { kind: 'trigger', triggerId: 'daily', untrustedInput: false }], ['codex:coordinator', { kind: 'slack', untrustedInput: true }],
  ]);
  const turn = (id: string, origin: Run['origin']): Run => ({ id: randomUUID(), sessionId: id, prompt: '', status: 'queued', createdAt: '', output: '', origin });
  const resolver = runToolResolver({ stateDir: f.stateDir, capabilities: f.capabilities, runs: { sessionOrigin: id => origins.get(id) },
    slack: { sessionMcp: id => id === 'codex:coordinator' ? { tower_slack: { command: 'node', args: ['index.js', '--slack-mcp', f.stateDir, 'wf-1'] } } : undefined } });
  const resolve = (origin: Run['origin'], target: Session) => resolver(turn(target.id, origin), target);
  const owner = { kind: 'owner' as const };
  const native = resolve(owner, session('codex:native'));
  assert.equal(native.towerTools, 'attached');
  assert.equal(native.required, false, 'a desktop-app turn may still go ahead without them');
  assert.deepEqual(native.servers!.tower.args.slice(-2), ['--tower-mcp', f.stateDir]);
  assert.match(native.servers!.tower.env!.TOWER_MCP_CAPABILITY, /^[a-f\d]{64}$/);
  assert.equal(resolve(owner, session('codex:created')).towerTools, 'attached');
  assert.deepEqual(resolve(owner, session('codex:issue')), { required: false, towerTools: 'external-input' });
  assert.deepEqual(resolve(owner, session('codex:scheduled')), { required: false, towerTools: 'not-owner-session' });
  assert.equal(resolve({ kind: 'trigger', triggerId: 'daily' }, session('codex:native')).servers, undefined);
  assert.equal(resolve({ kind: 'agent' }, session('codex:native')).servers, undefined);
  const coordinator = resolve(owner, session('codex:coordinator'));
  assert.equal(coordinator.required, true);
  assert.deepEqual(Object.keys(coordinator.servers!), ['tower_slack']);
  assert.equal(f.capabilities.resolve(coordinator.servers!.tower_slack.env!.TOWER_MCP_CAPABILITY)?.kind, 'slack-workflow');
  assert.equal(towerTools().some(tool => tool.name === 'triggers_updateSettings'), false);
});

test('the Tower tool server lists and calls tools through the worker with its capability', async t => {
  const { startTowerMcp } = await import('../../../server/slack/mcp-bridge.js');
  const { startRunnerHost } = await import('../../../server/runs/worker.js');
  const { RunManager } = await import('../../../server/runs/manager.js');
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
  await assert.rejects(call({ requestKey: 'new', trigger: { ...schedule(f.project), name: 'One too many' } }), { statusCode: 429 });
  assert.deepEqual(await call({ requestKey: 'first', trigger: schedule(f.project) }), first);
  assert.equal(f.triggers.list().length, 1);
});
