import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Run, Session } from '../../../shared/types.js';
import type { SecretMetadata, SecretRunResult, SecretSessionView, SecretSettingsView } from '../../../shared/secrets.js';
import { CapabilityRegistry, handleMcpRequest, type McpContext, type Capability } from '../../../server/api/mcp.js';
import { runToolResolver } from '../../../server/api/run-tools.js';
import type { SessionOrigin } from '../../../server/runs/origin.js';
import { SecretRuntime, SECRET_TOOLS } from '../../../server/secrets/runtime.js';
import { SecretService } from '../../../server/secrets/service.js';
import { editPayload, legacyRecord, legacyRule, stored, storedSecret, storedTask } from '../../helpers/secrets.js';
import { secretService } from '../../helpers/secrets.js';
import { runSecretsCommand } from '../../../server/secrets/cli.js';
import { SECRET_USE_INSTRUCTIONS } from '../../../server/secrets/notices.js';

const password = 'fixture-runtime-password-1234';
const canary = 'CANARY_RUNTIME_VALUE_DO_NOT_DISCLOSE';
const sessionRecord = (cwd: string, patch: Partial<Session> = {}): Session => ({
  id: 'codex:owner-session', nativeId: 'owner-session', provider: 'codex', title: 'Fixture owner session',
  cwd, project: 'fixture', status: 'working', statusReason: '', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
  lastMessage: '', messageCount: 0, isSubagent: false, resumable: true, ...patch,
});
const runRecord = (sessionId: string, id: string, patch: Partial<Run> = {}): Run => ({
  id, sessionId, origin: { kind: 'owner' }, towerTools: 'attached', brokerOwnerAuthorized: true, prompt: 'Use the connected key by reference.', status: 'running',
  createdAt: new Date().toISOString(), output: '', ...patch,
});

/** Only actual files, owner records and the real MCP dispatcher; no native provider or personal state is opened. */
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-runtime-')));
  const stateDir = join(directory, 'state'); const projectRoot = join(directory, 'project'); const alias = join(directory, 'project-link');
  await mkdir(stateDir); await mkdir(projectRoot); await symlink(projectRoot, alias);
  let now = Date.now();
  const service = new SecretService({ stateDir, now: () => now }); await service.start();
  const sessions = new Map<string, Session>(); const runs = new Map<string, Run>(); const origins = new Map<string, SessionOrigin>();
  const session = sessionRecord(alias); sessions.set(session.id, session); origins.set(session.id, { kind: 'owner', untrustedInput: false });
  const registry = {
    list: () => [...runs.values()], getSession: (id: string) => sessions.get(id), sessionOrigin: (id: string) => origins.get(id),
  };
  const notices: (string | undefined)[] = [];
  const runtime = new SecretRuntime({ stateDir, service, runs: registry, onConnect: id => { notices.push(id); } });
  const capabilities = new CapabilityRegistry(); const ledger: unknown[] = [];
  const context: McpContext = {
    capabilities, run: id => runs.get(id), secretAuthorize: capability => runtime.authorizeCapability(capability), secretTools: SECRET_TOOLS, secretTool: (capability, name, args) => runtime.tool(capability, name, args),
    api: { call: async (...args: unknown[]) => { ledger.push(args); throw new Error('Secret input reached the generic ledger'); } } as unknown as McpContext['api'],
  };
  const resolver = runToolResolver({ stateDir, runs: registry, capabilities, secrets: runtime });
  const addRun = (id: string, owner = session, patch: Partial<Run> = {}) => { const run = runRecord(owner.id, id, { createdAt: new Date(now).toISOString(), ...patch }); runs.set(id, run); return run; };
  const tokenFor = (run: Run, owner = session): string => {
    const tools = resolver(run, owner); if (tools.towerTools) run.towerTools = tools.towerTools; const server = tools.servers?.tower_secrets;
    assert.ok(server, 'eligible owner receives the secret MCP server');
    assert.ok(server.env?.TOWER_SECRET_CAPABILITY); assert.ok(!server.args.includes(server.env.TOWER_SECRET_CAPABILITY));
    assert.equal(server.env.TOWER_MCP_CAPABILITY, undefined);
    return server.env.TOWER_SECRET_CAPABILITY;
  };
  const call = (token: string, name: string, args: Record<string, unknown> = {}) => handleMcpRequest(context, token, { method: 'tools/call', name, arguments: args });
  const list = async (token: string) => (await call(token, 'secrets_list')) as { secrets: SecretMetadata[]; usage: string };
  const initialize = async () => { await runtime.control('initialize', { password }); };
  const cleanup = async () => { runtime.close(); await rm(directory, { recursive: true, force: true }); };
  return { advance: (milliseconds: number) => { now += milliseconds; }, now: () => now, directory, stateDir, projectRoot, alias, service, runtime, notices, sessions, runs, origins, session, capabilities, context, resolver, ledger, addRun, tokenFor, call, list, initialize, cleanup };
}

test('unrelated turns receive no secret guide and vault state changes stay silent', async () => {
  const f = await fixture();
  try {
    assert.equal((f.resolver(f.addRun('unrelated-before-setup'), f.session) as { instructions?: unknown }).instructions, undefined);
    await f.initialize();
    assert.equal((f.resolver(f.addRun('unrelated-after-setup'), f.session) as { instructions?: unknown }).instructions, undefined);
    await f.runtime.control('lock', {});
    await f.runtime.control('unlock', { password });
    await f.runtime.control('create', { name: 'QUIET_SAVED_KEY', kind: 'scalar', value: canary });
    assert.deepEqual(f.notices, []);
  } finally { await f.cleanup(); }
});

test('only an owner connection announces the verified session; saving and disconnecting stay silent', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.notices.length = 0;
    const saved = await f.runtime.control('create', { name: 'QUIET_SAVED_KEY', kind: 'scalar', value: canary }) as SecretSettingsView;
    assert.deepEqual(f.notices, [], 'saving from settings is silent');
    const ids = saved.secrets.map(secret => secret.id);
    await f.runtime.control('session-connect', { sessionId: f.session.id, secretIds: ids });
    assert.deepEqual(f.notices, [f.session.id]);
    await f.runtime.control('session-disconnect', { sessionId: f.session.id, secretIds: ids });
    assert.deepEqual(f.notices, [f.session.id], 'a disconnection is never announced');
  } finally { await f.cleanup(); }
});

test('a chat value is value-free, committed and announced before its view, and unrelated changes are silent', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const run = f.addRun('notice-owner'); const tools = f.resolver(run, f.session);
    assert.equal((tools as { instructions?: unknown }).instructions, undefined);
    assert.ok(tools.servers?.tower_secrets, 'lazy discovery remains available');
    assert.ok(SECRET_TOOLS.find(tool => tool.name === 'secrets_list')!.description.includes(SECRET_USE_INSTRUCTIONS));
    assert.doesNotMatch(SECRET_TOOLS.map(tool => tool.description).join('\n'), /automatic project|rule/i);
    const view = await f.runtime.control('create', { sessionId: f.session.id, name: canary, kind: 'scalar', value: canary, connect: 'session', temporary: true }) as SecretSessionView;
    assert.deepEqual(f.notices, [f.session.id]);
    assert.deepEqual(view.available.map(item => [item.name, item.basis]), [[canary, ['session']]]); assert.equal(view.error, undefined);
    assert.doesNotMatch(JSON.stringify(view.available.map(({ name: _name, ...item }) => item)), new RegExp(canary));
    await f.runtime.control('session', { sessionId: f.session.id });
    await f.runtime.control('preview', { value: 'FAKE_KEY=FAKE_VALUE' });
    await assert.rejects(f.runtime.control('session-connect', { sessionId: f.session.id, secretIds: ['missing'] }));
    const id = view.available[0].id;
    await f.runtime.control('update', { id, value: 'FAKE_REPLACEMENT' });
    await f.runtime.control('session-disconnect', { sessionId: f.session.id, secretIds: [id] });
    await f.runtime.control('lock', {});
    await f.runtime.control('unlock', { password });
    const shared = await f.runtime.control('create', { name: 'FAKE_SHARED', kind: 'scalar', value: 'FAKE_GLOBAL', sharing: { global: true, folders: [] } }) as SecretSettingsView;
    const sharedId = shared.secrets.find(secret => secret.name === 'FAKE_SHARED')!.id;
    await f.runtime.control('update', { id: sharedId, value: 'FAKE_GLOBAL_UPDATED' });
    await f.runtime.control('sharing', { secretId: sharedId, revision: 1, global: false, folders: [] });
    assert.deepEqual(f.notices, [f.session.id]);
    assert.doesNotMatch(JSON.stringify(f.notices), /CANARY_RUNTIME_VALUE|fixture-runtime-password/);
    (f.runtime as unknown as { sessionView: () => Promise<never> }).sessionView = async () => { throw new Error('fixture view failure'); };
    await assert.rejects(f.runtime.control('create', { sessionId: f.session.id, name: 'FAKE_COMMITTED', kind: 'scalar', value: canary, connect: 'session', temporary: true }), /view failure/);
    assert.deepEqual(f.notices, [f.session.id, f.session.id], 'the connection was committed and announced before its view failed');
    await f.runtime.control('remove', { id });
    assert.equal(f.notices.length, 2);
    assert.equal(storedSecret(f.service, id), false);
  } finally { await f.cleanup(); }
});

test('expiry, remote availability and task closure stay silent while the broker enforces them', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const run = f.addRun('notice-expiry');
    await f.runtime.sweep();
    assert.equal(f.service.currentTask(f.session.id), undefined);
    const expiring = legacyRecord(f.service.device().id, { name: 'FAKE_EXPIRING', groupId: 'legacy-group', value: canary, expiresAt: f.now() + 100 });
    await editPayload(f.service, payload => { payload.groups.push({ id: 'legacy-group', name: 'Global', scope: 'global' }); payload.secrets.push(expiring); });
    await f.runtime.control('session-connect', { sessionId: f.session.id, secretIds: [expiring.metadata.id] });
    const target = (await f.runtime.peekTarget(f.session.id))!; f.notices.length = 0;
    const token = f.tokenFor(run);
    assert.equal((await f.list(token)).secrets.length, 1);
    f.advance(150); await f.runtime.sweep();
    assert.equal((await f.list(token)).secrets.length, 0);
    f.runtime.broker.unavailableSources = () => [{ sourceHostId: 'fixture-remote', code: 'SECRET_SOURCE_UNAVAILABLE' }];
    await f.runtime.sweep(); await f.runtime.control('session', { sessionId: f.session.id });
    await f.service.closeTask(target.taskId); await f.runtime.sweep();
    assert.equal(f.service.currentTask(f.session.id), undefined);
    await assert.rejects(f.list(token));
    assert.deepEqual(f.notices, []);
  } finally { await f.cleanup(); }
});

test('a key shared with a folder stays discoverable there without a task, a connection or a notice', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    await f.runtime.control('create', { name: 'FAKE_AUTO', kind: 'env', value: 'TOKEN=FAKE_TOKEN\nOTHER=FAKE_OTHER', sharing: { global: false, folders: [{ hostId: f.service.device().id, root: f.projectRoot }] } });
    assert.equal(await f.runtime.peekTarget(f.session.id), undefined, 'saving starts no task');
    const view = await f.runtime.control('session', { sessionId: f.session.id }) as SecretSessionView;
    assert.deepEqual(view.available.map(item => [item.name, item.basis, item.fields]), [['FAKE_AUTO', ['folder'], ['TOKEN', 'OTHER']]]);
    assert.equal(await f.runtime.peekTarget(f.session.id), undefined, 'viewing starts no task');
    const run = f.addRun('notice-automatic'); const secrets = (await f.list(f.tokenFor(run))).secrets;
    assert.deepEqual(secrets.map(secret => [secret.name, secret.fields]), [['FAKE_AUTO', ['TOKEN', 'OTHER']]]);
    assert.deepEqual(storedTask(f.service, (await f.runtime.peekTarget(f.session.id))!.taskId)?.connected, [], 'shared with the folder, not connected');
    assert.deepEqual(f.notices, []);
  } finally { await f.cleanup(); }
});

test('invalid chat input fails before task creation or secret mutation', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const input = { sessionId: f.session.id, name: 'FAKE_INVALID_MARKER', kind: 'scalar', value: canary, connect: 'session', temporary: true };
    await assert.rejects(f.runtime.control('create', { ...input, connect: true }), { kind: 'invalid' });
    await assert.rejects(f.runtime.control('create', { ...input, connect: undefined }), { kind: 'invalid' });
    await assert.rejects(f.runtime.control('create', { ...input, sharing: { global: true, folders: [] } }), { kind: 'invalid' }, 'a temporary value is never shared');
    await assert.rejects(f.runtime.control('create', { ...input, nodeId: 'fixture-node' }), { kind: 'invalid' }, 'a joined computer’s session needs the target its web verified');
    await assert.rejects(f.runtime.control('create', input, { hostId: 'forged', sessionId: f.session.id, root: '/forged', taskId: randomUUID() }), { kind: 'invalid' }, 'a session of this computer takes no target');
    await assert.rejects(f.runtime.control('create', { ...input, sessionId: undefined }), { kind: 'invalid' });
    assert.equal(f.service.currentTask(f.session.id), undefined);
    assert.deepEqual(stored(f.service).secrets, []);
    await f.service.create({ name: 'FAKE_UNGRANTED', kind: 'scalar', value: 'fixture-only' });
    assert.deepEqual(f.notices, []);
  } finally { await f.cleanup(); }
});

test('a joined computer’s session gets a receipt instead of a view, and no same-named session here is notified', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const device = { ...f.service.device(), id: randomUUID() };
    await f.service.trustPeer({ device, routeId: 'fixture-node', direction: 'node', enabled: true });
    const target = { hostId: device.id, root: '/fixture/remote', sessionId: f.session.id, taskId: randomUUID() };
    (f.runtime as unknown as { sessionView: () => Promise<never> }).sessionView = async () => { throw new Error('a remote change is viewed by its web'); };
    const receipt = await f.runtime.control('create', { sessionId: f.session.id, nodeId: 'fixture-node', name: 'FAKE_REMOTE_CHAT_KEY', kind: 'scalar', value: canary, connect: 'session', temporary: true }, { ...target, projectId: 'node-own-project' });
    assert.ok('connectedTarget' in receipt); assert.deepEqual(receipt.connectedTarget, target);
    assert.equal(f.service.currentTask(f.session.id), undefined);
    assert.equal(f.service.currentTask(f.session.id, target.root, target.hostId)?.taskId, target.taskId);
    const saved = await f.service.create({ name: 'FAKE_SAVED', kind: 'scalar', value: 'fixture-only' });
    for (const action of ['session-connect', 'session-disconnect']) {
      const answer = await f.runtime.control(action, { sessionId: f.session.id, nodeId: 'fixture-node', secretIds: [saved.id] }, target);
      assert.deepEqual(answer, { connectedTarget: target });
    }
    await assert.rejects(f.runtime.control('session-connect', { sessionId: f.session.id, nodeId: 'fixture-node', secretIds: [saved.id] }, { ...target, sessionId: 'another' }), { kind: 'unavailable' });
    assert.deepEqual(f.notices, []);
  } finally { await f.cleanup(); }
});

test('expiry cleanup holds the worker during writes and pauses for a handoff', async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  try {
    await f.initialize();
    f.addRun('live-cleanup-run');
    let calls = 0;
    f.service.sweep = async live => {
      calls++;
      assert.ok(live.has('live-cleanup-run'));
      await new Promise<void>(resolve => { release = resolve; });
    };
    const pending = f.runtime.sweep();
    assert.equal(f.runtime.inFlight(), true);
    await f.runtime.sweep();
    assert.equal(calls, 1);
    f.runtime.pause(); release!(); await pending;
    assert.equal(f.runtime.inFlight(), false);
    await f.runtime.sweep(); assert.equal(calls, 1);
    f.runtime.resume();
    const resumed = f.runtime.sweep(); assert.equal(calls, 2);
    release!(); await resumed; assert.equal(f.runtime.inFlight(), false);
  } finally { release?.(); await f.cleanup(); }
});

test('saving a chat value for this folder uses the canonical folder the web resolved and ignores anything the page names', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const running = f.addRun('run-bound-before-project-save'); const token = f.tokenFor(running); await f.list(token);
    const folder = { hostId: f.service.device().id, root: f.projectRoot };
    const input = { sessionId: f.session.id, kind: 'scalar', name: 'QUICK_PROJECT', value: 'FAKE_QUICK_PROJECT', connect: 'session', sharing: { global: false, folders: [folder] },
      projectRoot: '/forged', hostId: 'forged-host', taskId: 'forged-task', projectId: 'forged-project', target: { root: '/forged' } };
    const first = await f.runtime.control('create', input) as SecretSessionView;
    assert.deepEqual(f.service.settings().secrets.map(secret => secret.sharing), [{ revision: 1, global: false, folders: [folder] }]);
    assert.deepEqual(first.available.map(item => [item.name, item.basis]), [['QUICK_PROJECT', ['session', 'folder']]]);
    assert.equal((await f.list(token)).secrets[0].name, 'QUICK_PROJECT');
    const second = await f.runtime.control('create', { ...input, name: 'ANOTHER_PROJECT_KEY' }) as SecretSessionView;
    assert.equal(second.available.length, 2);
    const fresh = sessionRecord(f.alias, { id: 'codex:fresh-picker-session', nativeId: 'fresh-picker-session' }); f.sessions.set(fresh.id, fresh); f.origins.set(fresh.id, { kind: 'owner', untrustedInput: false });
    const picker = await f.runtime.control('session', { sessionId: fresh.id, projectRoot: '/forged' }) as SecretSessionView;
    assert.deepEqual(picker.available.map(item => [item.name, item.basis]).sort(), [['ANOTHER_PROJECT_KEY', ['folder']], ['QUICK_PROJECT', ['folder']]]);
    assert.equal(f.service.currentTask(fresh.id, f.projectRoot), undefined, 'the view of another session in the folder starts nothing');
    const freshRun = f.addRun('fresh-picker-run', fresh);
    assert.deepEqual((await f.list(f.tokenFor(freshRun, fresh))).secrets.map(secret => secret.name).sort(), ['ANOTHER_PROJECT_KEY', 'QUICK_PROJECT'], 'another session in the folder uses both without a connection');
    assert.deepEqual(f.ledger, []);
  } finally { await f.cleanup(); }
});

test('owner MCP binds canonical cwd and one open task across summaries, turn completion and owner follow-up', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const first = f.addRun('run-first'); const token = f.tokenFor(first);
    await f.list(token);
    const capability = f.capabilities.resolve(token) as Extract<Capability, { kind: 'secret-run' }>;
    const initial = await f.runtime.context(capability);
    assert.equal(initial.root, f.projectRoot); assert.notEqual(initial.root, f.alias);
    f.session.tasks = [{ id: 'summary-task', title: 'A model summary ended', stage: 'completed', startedAt: 'now', updatedAt: 'now' }];
    assert.equal((await f.runtime.context(capability)).taskId, initial.taskId);
    first.status = 'completed'; await assert.rejects(f.list(token), { kind: 'forbidden' });
    const followup = f.addRun('run-followup'); const followupToken = f.tokenFor(followup);
    const followupCapability = f.capabilities.resolve(followupToken) as Extract<Capability, { kind: 'secret-run' }>;
    assert.notEqual(followupToken, token);
    assert.equal((await f.runtime.context(followupCapability)).taskId, initial.taskId);
    const task = storedTask(f.service, (await f.runtime.target(f.session.id)).taskId);
    assert.equal(task?.status, 'open'); assert.equal(task?.id, initial.taskId);
  } finally { await f.cleanup(); }
});

test('closed task refuses an already bound run even after a new run creates a fresh task', async () => {
  const f = await fixture();
  try {
    await f.initialize(); const oldRun = f.addRun('run-old'); const oldToken = f.tokenFor(oldRun);
    await f.list(oldToken);
    const oldCapability = f.capabilities.resolve(oldToken) as Extract<Capability, { kind: 'secret-run' }>;
    const original = await f.runtime.context(oldCapability);
    await f.service.closeTask(original.taskId);
    await assert.rejects(f.list(oldToken), /Task identity denied/);
    f.advance(10);
    const next = f.addRun('run-new', f.session, { startedAt: new Date(f.now()).toISOString() }); const nextToken = f.tokenFor(next); await f.list(nextToken);
    const fresh = await f.runtime.context(f.capabilities.resolve(nextToken) as Extract<Capability, { kind: 'secret-run' }>);
    assert.notEqual(fresh.taskId, original.taskId);
    assert.equal((await f.runtime.context(oldCapability)).taskId, original.taskId);
    await assert.rejects(f.list(oldToken), /Task identity denied/);
    assert.deepEqual((await f.list(nextToken)).secrets, []);
  } finally { await f.cleanup(); }
});

test('resolver and runtime refuse trigger, agent, subagent, foreign session, external-input and forged capabilities', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    for (const kind of ['trigger', 'agent', 'slack', 'unknown'] as const) {
      const run = f.addRun(`run-${kind}`, f.session, { origin: { kind, ...(kind === 'trigger' ? { triggerId: 'fixture-trigger' } : {}) } });
      assert.equal(f.resolver(run, f.session).servers?.tower_secrets, undefined);
      const forced = f.capabilities.issue({ kind: 'secret-run', runId: run.id, sessionId: run.sessionId });
      await assert.rejects(f.list(forced), { kind: 'forbidden' });
    }
    const restrictions: Partial<Session>[] = [ { isSubagent: true }, { launchedByAgent: true }, { parentId: 'root' }, { launchedBy: { kind: 'trigger', triggerId: 'fixture-trigger' } } ];
    for (const [index, patch] of restrictions.entries()) {
      const session = sessionRecord(f.projectRoot, { id: `child-${index}`, ...patch }); f.sessions.set(session.id, session); f.origins.set(session.id, { kind: 'owner', untrustedInput: false });
      const run = f.addRun(`run-child-${index}`, session);
      assert.equal(f.resolver(run, session).servers?.tower_secrets, undefined);
      await assert.rejects(f.list(f.capabilities.issue({ kind: 'secret-run', runId: run.id, sessionId: session.id })), { kind: 'forbidden' });
      await assert.rejects(f.runtime.target(session.id), { kind: 'forbidden' });
    }
    const owner = f.addRun('run-owner');
    f.origins.set(f.session.id, { kind: 'owner', untrustedInput: true });
    assert.equal(f.resolver(owner, f.session).towerTools, 'external-input');
    await assert.rejects(f.list(f.capabilities.issue({ kind: 'secret-run', runId: owner.id, sessionId: owner.sessionId })), { kind: 'forbidden' });
    f.origins.set(f.session.id, { kind: 'trigger', untrustedInput: false, triggerId: 'fixture-trigger' });
    assert.equal(f.resolver(owner, f.session).towerTools, 'not-owner-session');
    await assert.rejects(f.runtime.target(f.session.id), { kind: 'forbidden' });
    f.origins.set(f.session.id, { kind: 'owner', untrustedInput: false });
    const token = f.tokenFor(owner);
    await assert.rejects(f.list('f'.repeat(64)), { kind: 'forbidden' });
    await assert.rejects(f.list(f.capabilities.issue({ kind: 'secret-run', runId: owner.id, sessionId: 'forged-session' })), { kind: 'forbidden' });
    await assert.rejects(f.call(token, 'secrets_list', { sessionId: 'forged', cwd: '/forged' }));
    await assert.rejects(f.list(f.capabilities.issue({ kind: 'session-reader' })), { kind: 'not-found' });
    for (const towerTools of ['desktop-app', 'external-input', 'not-owner-session', 'remote'] as const) {
      owner.towerTools = towerTools; await assert.rejects(f.list(token), { kind: 'forbidden' });
    }
    assert.deepEqual(f.ledger, []);
  } finally { await f.cleanup(); }
});

test('MCP lists shared keys without values, an owner connection opens an unshared one, and a disconnection persists across owner follow-up', async () => {
  const f = await fixture();
  try {
    await f.initialize(); const run = f.addRun('run-list'); const token = f.tokenFor(run);
    await f.runtime.control('create', { name: 'AUTOMATIC_KEY', kind: 'scalar', value: canary, sharing: { global: true, folders: [] } });
    await f.runtime.control('create', { name: 'MANUAL_KEY', kind: 'scalar', value: 'MANUAL_RUNTIME_CANARY' });
    const all = f.service.settings().secrets; const automatic = all.find(key => key.name === 'AUTOMATIC_KEY')!; const manual = all.find(key => key.name === 'MANUAL_KEY')!;
    const tools = await handleMcpRequest(f.context, token, { method: 'tools/list' }) as { tools: { name: string }[] };
    assert.ok(tools.tools.some(tool => tool.name === 'secrets_list')); assert.ok(tools.tools.some(tool => tool.name === 'secrets_cli'));
    assert.doesNotMatch(JSON.stringify(tools), /CANARY_RUNTIME|MANUAL_RUNTIME_CANARY/);
    const first = await f.list(token);
    assert.deepEqual(first.secrets.map(key => key.name), ['AUTOMATIC_KEY'], 'a saved key without sharing waits for a connection'); assert.equal(first.secrets[0].activation, undefined); assert.deepEqual(first.secrets[0].operations, ['discover', 'env', 'pipe', 'file', 'compare', 'fingerprint']);
    assert.doesNotMatch(JSON.stringify(first), /CANARY_RUNTIME|MANUAL_RUNTIME_CANARY|"value"|"content"/);
    await f.runtime.control('session-connect', { sessionId: f.session.id, secretIds: [manual.id] });
    assert.deepEqual((await f.list(token)).secrets.map(key => key.name).sort(), ['AUTOMATIC_KEY', 'MANUAL_KEY']);
    await f.runtime.control('session-disconnect', { sessionId: f.session.id, secretIds: [automatic.id, manual.id] });
    assert.deepEqual((await f.list(token)).secrets, []);
    run.status = 'completed'; const followupToken = f.tokenFor(f.addRun('run-revoked-followup'));
    assert.deepEqual((await f.list(followupToken)).secrets, []);
    const cliList = await f.call(followupToken, 'secrets_cli', { argv: ['list', '--json'] }) as { secrets: unknown[] };
    assert.deepEqual(cliList.secrets, []); assert.deepEqual(f.ledger, []);
    await f.runtime.control('session-connect', { sessionId: f.session.id, secretIds: [manual.id] });
    assert.deepEqual((await f.list(followupToken)).secrets.map(key => key.name), ['MANUAL_KEY'], 'connecting again lifts only that key’s stop');
  } finally { await f.cleanup(); }
});

test('owner password and secret control bypass generic ledger; restart is locked and child output is masked before MCP return', async () => {
  const f = await fixture();
  try {
    await f.initialize(); const run = f.addRun('run-use'); const token = f.tokenFor(run);
    const result = await f.runtime.control('create', { sessionId: f.session.id, name: 'CHILD_KEY', kind: 'scalar', value: canary, connect: 'session', temporary: true }) as SecretSessionView;
    const reference = result.available[0].reference;
    const command = { operationId: 'fixture-child-once', command: process.execPath, args: ['-e', 'process.stdout.write(process.env.FIXTURE_KEY);process.stderr.write(JSON.stringify(process.env.FIXTURE_KEY));'], env: { FIXTURE_KEY: reference } };
    const output = await f.call(token, 'secrets_run', command) as SecretRunResult;
    assert.equal(output.exitCode, 0); assert.equal(output.stdout, '[REDACTED]'); assert.equal(output.stderr, '"[REDACTED]"');
    assert.deepEqual(await f.call(token, 'secrets_run', command), output);
    assert.doesNotMatch(JSON.stringify({ run, tools: f.resolver(run, f.session), result, output }), new RegExp(`${canary}|${password}`));
    await f.runtime.control('password', { currentPassword: password, newPassword: 'changed-fixture-password-1234' });
    await f.runtime.flush();
    for (const name of await readdir(join(f.stateDir, 'secrets'))) {
      if (!name.endsWith('.json')) continue;
      assert.doesNotMatch(await readFile(join(f.stateDir, 'secrets', name), 'utf8'), new RegExp(`${canary}|${password}|changed-fixture-password-1234|${token}`));
    }
    const restarted = await secretService(f.stateDir);
    assert.equal(restarted.status().locked, true);
    await assert.rejects(restarted.unlock(password)); await restarted.unlock('changed-fixture-password-1234');
    assert.deepEqual(f.ledger, []);
    await f.runtime.control('lock', {});
    const locked = await f.list(token) as { secrets: SecretMetadata[]; locked?: boolean };
    assert.equal(locked.locked, true); assert.deepEqual(locked.secrets.map(item => item.reference), [reference]);
    await assert.rejects(f.call(token, 'secrets_run', { ...command, operationId: 'fixture-child-locked' }), /locked/);
  } finally { await f.cleanup(); }
});

test('standalone CLI cannot infer authority from a native thread, project cwd or generic MCP capability', async () => {
  const keys = ['TOWER_SECRET_CAPABILITY', 'TOWER_SECRET_STATE_DIR', 'TOWER_MCP_CAPABILITY', 'CODEX_THREAD_ID'] as const;
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    delete process.env.TOWER_SECRET_CAPABILITY;
    process.env.TOWER_SECRET_STATE_DIR = tmpdir(); process.env.TOWER_MCP_CAPABILITY = 'a'.repeat(64); process.env.CODEX_THREAD_ID = 'forged-owner-thread';
    await assert.rejects(runSecretsCommand(['list']), /시크릿 권한이 없습니다/);
    process.env.TOWER_SECRET_CAPABILITY = 'a'.repeat(64); delete process.env.TOWER_SECRET_STATE_DIR;
    await assert.rejects(runSecretsCommand(['list']), /transport 경로가 없습니다/);
  } finally { for (const key of keys) { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('session view polling never creates a security task, and after a task ends never restarts one', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    await f.runtime.control('create', { name: 'AUTOMATIC_KEY', kind: 'scalar', value: canary, sharing: { global: true, folders: [] } });
    assert.equal(await f.runtime.peekTarget(f.session.id), undefined);
    const unused = await readFile(join(f.stateDir, 'secrets/journal.json'));
    const beforeUse = await f.runtime.control('session', { sessionId: f.session.id }) as SecretSessionView;
    assert.deepEqual(beforeUse.available.map(item => [item.name, item.basis]), [['AUTOMATIC_KEY', ['global']]]); assert.deepEqual(beforeUse.usage, []);
    assert.equal(await f.runtime.peekTarget(f.session.id), undefined);
    assert.deepEqual(await readFile(join(f.stateDir, 'secrets/journal.json')), unused, 'a view writes nothing');
    const oldRun = f.addRun('run-before-close'); const oldToken = f.tokenFor(oldRun);
    assert.equal((await f.list(oldToken)).secrets[0]?.name, 'AUTOMATIC_KEY');
    const original = await f.runtime.peekTarget(f.session.id); assert.ok(original);
    f.advance(10); await f.service.closeTask(original.taskId);
    const closedJournal = await readFile(join(f.stateDir, 'secrets/journal.json'));
    for (let poll = 0; poll < 3; poll++) {
      const view = await f.runtime.control('session', { sessionId: f.session.id }) as SecretSessionView;
      assert.deepEqual(view.available.map(item => item.name), ['AUTOMATIC_KEY'], 'what a new task would get');
      assert.equal(await f.runtime.peekTarget(f.session.id), undefined);
      assert.equal(await f.runtime.remoteTarget(f.session.id, false), undefined);
      assert.deepEqual(await f.runtime.sessionSubject(f.session.id), { hostId: f.service.device().id, sessionId: f.session.id, root: f.projectRoot, usage: [] });
    }
    assert.deepEqual(await readFile(join(f.stateDir, 'secrets/journal.json')), closedJournal);
    await assert.rejects(f.list(oldToken), /Task identity denied/);
    f.advance(10); const freshToken = f.tokenFor(f.addRun('run-after-close', f.session, { startedAt: new Date(f.now()).toISOString() }));
    assert.equal((await f.list(freshToken)).secrets[0]?.name, 'AUTOMATIC_KEY');
    assert.notEqual((await f.runtime.peekTarget(f.session.id))?.taskId, original.taskId);
  } finally { await f.cleanup(); }
});

test('a capability issued before termination but never used cannot bind the subsequent task', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const unusedRun = f.addRun('run-issued-unused'); const unusedToken = f.tokenFor(unusedRun);
    await handleMcpRequest(f.context, unusedToken, { method: 'tools/list' });
    assert.equal(await f.runtime.peekTarget(f.session.id), undefined);
    const activeToken = f.tokenFor(f.addRun('run-active')); await f.list(activeToken);
    const original = await f.runtime.peekTarget(f.session.id); assert.ok(original);
    f.advance(10); await f.service.closeTask(original.taskId);
    await assert.rejects(f.list(unusedToken), /Run predates task closure/);
    assert.equal(await f.runtime.peekTarget(f.session.id), undefined);
    f.advance(10); const fresh = f.addRun('run-fresh', f.session, { startedAt: new Date(f.now()).toISOString() });
    const freshToken = f.tokenFor(fresh); await f.list(freshToken);
    assert.notEqual((await f.runtime.peekTarget(f.session.id))?.taskId, original.taskId);
    const journal = await readFile(join(f.stateDir, 'secrets/journal.json'));
    await assert.rejects(f.list(unusedToken), /Run predates task closure/);
    assert.deepEqual(await readFile(join(f.stateDir, 'secrets/journal.json')), journal);
    assert.equal(unusedRun.status, 'running');
  } finally { await f.cleanup(); }
});

test('session archival without a Vault is a no-op, with no deferred secret state', async () => {
  const f = await fixture();
  try {
    await f.runtime.endSession(f.session.id);
    assert.equal(f.service.status().initialized, false);
    await assert.rejects(readFile(join(f.stateDir, 'secret-close-intents.json')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('session archival cleans stored tasks without granting child or automation sessions secret access', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const child = sessionRecord(f.projectRoot, { id: 'codex:archive-child', isSubagent: true });
    const trigger = sessionRecord(f.projectRoot, { id: 'codex:archive-trigger', launchedBy: { kind: 'trigger', triggerId: 'fixture-trigger' } });
    f.sessions.set(child.id, child); f.origins.set(child.id, { kind: 'owner', untrustedInput: false });
    f.sessions.set(trigger.id, trigger); f.origins.set(trigger.id, { kind: 'trigger', triggerId: 'fixture-trigger', untrustedInput: false });
    for (const session of [child, trigger]) {
      await f.runtime.endSession(session.id);
      await assert.rejects(f.runtime.target(session.id), { kind: 'forbidden' });
    }
    const run = f.addRun('active-archived-run');
    const target = await f.runtime.target(f.session.id);
    const secret = await f.service.create({ name: 'archived task key', kind: 'scalar', value: canary, temporary: true }, target);
    f.session.closed = true;
    await rm(f.projectRoot, { recursive: true, force: true });
    await f.runtime.endSession(f.session.id);
    assert.equal(storedTask(f.service, target.taskId)?.status, 'closed');
    assert.equal(storedSecret(f.service, secret.id), false);
    assert.equal(run.status, 'running');
    await assert.rejects(readFile(join(f.stateDir, 'secret-close-intents.json')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('locked session closure survives runtime restart and removes task-only secrets before owner unlock enables tools', async () => {
  const f = await fixture(); let restartedRuntime: SecretRuntime | undefined;
  try {
    await f.initialize(); const run = f.addRun('run-archived'); const token = f.tokenFor(run);
    const registered = await f.runtime.control('create', { sessionId: f.session.id, name: 'TASK_ONLY_KEY', kind: 'scalar', value: canary, connect: 'session', temporary: true }) as SecretSessionView;
    const target = (await f.runtime.peekTarget(f.session.id))!; const secret = registered.available[0]; assert.ok(target); assert.ok(secret);
    assert.equal((await f.list(token)).secrets[0].id, secret.id);
    await f.runtime.control('lock', {}); f.session.closed = true; f.advance(10);
    await f.runtime.endSession(f.session.id);
    const closurePath = join(f.stateDir, 'secret-close-intents.json'); const closureText = await readFile(closurePath, 'utf8');
    const hashes = JSON.parse(closureText) as string[];
    assert.equal(hashes.length, 1); assert.match(hashes[0], /^[a-f0-9]{64}$/);
    for (const privateInput of [f.session.id, f.session.nativeId, canary, password, token, secret.id, target.taskId]) assert.equal(closureText.includes(privateInput), false);
    const { stat } = await import('node:fs/promises'); assert.equal((await stat(closurePath)).mode & 0o777, 0o600);
    const restarted = await secretService(f.stateDir, { now: f.now }); assert.equal(restarted.status().locked, true);
    const registry = { list: () => [...f.runs.values()], getSession: (id: string) => f.sessions.get(id), sessionOrigin: (id: string) => f.origins.get(id) };
    restartedRuntime = new SecretRuntime({ stateDir: f.stateDir, service: restarted, runs: registry });
    const capabilities = new CapabilityRegistry(); const context: McpContext = { capabilities, run: id => f.runs.get(id), secretTools: SECRET_TOOLS, secretTool: (capability, name, args) => restartedRuntime!.tool(capability, name, args) };
    await assert.rejects(handleMcpRequest(context, token, { method: 'tools/call', name: 'secrets_list', arguments: {} }), { kind: 'forbidden' });
    await restartedRuntime.control('unlock', { password });
    await assert.rejects(readFile(closurePath), { code: 'ENOENT' });
    assert.equal(storedTask(restarted, target.taskId)?.status, 'closed'); assert.equal(storedSecret(restarted, secret.id), false);
    assert.equal(restarted.currentTask(f.session.id, f.projectRoot), undefined); assert.deepEqual(storedTask(restarted, target.taskId)?.connected, []);
    await assert.rejects(restarted.list({ ...target, runId: run.id }), /Task identity denied/);
    await assert.rejects(restarted.resolve({ ...target, runId: run.id }, secret.reference, 'env'), /Unknown or ambiguous secret reference/);
    f.session.closed = false; f.advance(10);
    const next = f.addRun('run-reopened', f.session, { startedAt: new Date(f.now()).toISOString() });
    const resolver = runToolResolver({ stateDir: f.stateDir, runs: registry, capabilities, secrets: restartedRuntime });
    const nextToken = resolver(next, f.session).servers!.tower_secrets.env!.TOWER_SECRET_CAPABILITY;
    const listed = await handleMcpRequest(context, nextToken, { method: 'tools/call', name: 'secrets_list', arguments: {} }) as { secrets: SecretMetadata[] };
    assert.deepEqual(listed.secrets, []); assert.notEqual(restarted.currentTask(f.session.id, f.projectRoot)?.taskId, target.taskId);
    assert.equal(stored(restarted).secrets.some(item => item.metadata.name === 'TASK_ONLY_KEY'), false);
  } finally { restartedRuntime?.close(); await f.cleanup(); }
});

test('rotated values and rules an older build edits apply to an open task at once, and a rule time limit counts from the task', async () => {
  const f = await fixture();
  try {
    await f.initialize(); const run = f.addRun('run-pinned-grant'); const token = f.tokenFor(run);
    const record = legacyRecord(f.service.device().id, { name: 'PINNED_KEY', groupId: 'legacy-group', value: canary }); const secret = record.metadata;
    await editPayload(f.service, payload => { payload.groups.push({ id: 'legacy-group', name: 'Global', scope: 'global' }); payload.secrets.push(record); payload.rules.push(legacyRule({ groupId: 'legacy-group', secretIds: [secret.id], hostId: f.service.device().id, allProjects: true, activation: 'auto', operations: ['discover', 'env'], maxTtlMs: 100 })); });
    const initial = await f.list(token); assert.equal(initial.secrets[0].id, secret.id);
    const capability = f.capabilities.resolve(token) as Extract<Capability, { kind: 'secret-run' }>;
    const context = await f.runtime.context(capability); const deadline = storedTask(f.service, context.taskId)!.createdAt + 100;
    f.advance(25); await f.runtime.control('update', { id: secret.id, value: 'ROTATED_RUNTIME_CANARY' });
    const updated = f.service.settings().secrets[0]; assert.equal(updated.version, secret.version + 1);
    assert.equal((await f.list(token)).secrets[0].version, updated.version, 'a rotated value needs no reapproval');
    assert.equal((await f.service.resolve(context, updated.reference, 'env')).bytes.toString(), 'ROTATED_RUNTIME_CANARY');
    f.advance(25); await editPayload(f.service, payload => { payload.rules[0]!.operations = ['discover', 'env', 'fingerprint']; payload.rules[0]!.revision++; });
    assert.ok((await f.list(token)).secrets[0].operations?.includes('fingerprint'));
    assert.equal((await f.service.resolve(context, updated.reference, 'fingerprint')).bytes.toString(), 'ROTATED_RUNTIME_CANARY');
    f.advance(deadline - f.now() - 1);
    assert.equal((await f.list(token)).secrets.length, 1);
    f.advance(1);
    assert.deepEqual((await f.list(token)).secrets, [], 'editing the rule never restarts its time limit');
    await assert.rejects(f.service.resolve(context, updated.reference, 'env'), /access denied/);
    await f.runtime.control('session-connect', { sessionId: f.session.id, secretIds: [secret.id] });
    assert.equal((await f.list(token)).secrets[0]?.id, secret.id, 'only the owner’s explicit connection opens it past the limit');
  } finally { await f.cleanup(); }
});

test('a tool that fails because the Vault locked meanwhile is answered as locked only when the failure has no status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-secret-runtime-status-'));
  const state = { locked: false };
  const runtime = new SecretRuntime({ stateDir: directory, service: { status: () => ({ locked: state.locked }) } as unknown as SecretService, runs: { list: () => [], getSession: () => undefined, sessionOrigin: () => undefined } });
  try {
    let thrown: unknown;
    const inner = runtime as unknown as { unlockedTool: () => Promise<unknown>; lockedTool: () => Promise<unknown> };
    inner.unlockedTool = async () => { state.locked = true; throw thrown; };
    inner.lockedTool = async () => 'answered as locked';
    const outcome = async (value: unknown) => {
      state.locked = false; thrown = value;
      return runtime.tool({ kind: 'secret-run' } as never, 'secrets_list', {}).then(result => result, (error: unknown) => error === value ? 'thrown' : error);
    };
    const plain = (statusCode: unknown) => Object.assign(new Error('x'), { statusCode });
    assert.equal(await outcome(new Error('untyped')), 'answered as locked');
    assert.equal(await outcome(plain(403)), 'thrown', 'a mapped status is a typed failure');
    assert.equal(await outcome(plain(599)), 'thrown', 'an unmapped numeric status is a typed failure');
    assert.equal(await outcome(plain(0)), 'answered as locked', 'zero counts as no status');
    assert.equal(await outcome(plain(Number.NaN)), 'answered as locked', 'NaN counts as no status');
    assert.equal(await outcome(plain(undefined)), 'answered as locked');
    assert.equal(await outcome(plain('0')), 'thrown', 'a non-empty string counts as a status');
    assert.equal(await outcome({ statusCode: 409 }), 'thrown', 'any object with a status');
    assert.equal(await outcome('text'), 'answered as locked');
    // Not locked after the failure: always the failure.
    inner.unlockedTool = async () => { throw thrown; };
    assert.equal(await outcome(new Error('untyped')), 'thrown');
  } finally { runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the settings view lists sharing, rule summaries and pending imports without values, and sharing changes are revisioned', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const legacy = legacyRecord(f.service.device().id, { name: 'RULED', groupId: 'legacy-group', value: canary });
    await editPayload(f.service, payload => { payload.groups.push({ id: 'legacy-group', name: 'Global', scope: 'global' }); payload.secrets.push(legacy); payload.rules.push(legacyRule({ groupId: 'legacy-group', secretIds: [legacy.metadata.id], hostId: f.service.device().id, allProjects: true })); });
    await f.runtime.control('create', { name: 'SHARED', kind: 'scalar', value: canary, sharing: { global: true, folders: [] } });
    const view = await f.runtime.control('settings', {}) as SecretSettingsView;
    assert.deepEqual(view.status, { initialized: true, locked: false, pendingImports: 0, pendingImportIds: [] });
    assert.deepEqual(view.secrets.map(item => [item.name, item.sharing, item.legacy]), [
      ['RULED', undefined, { global: [{ hostId: f.service.device().id }], folders: [], limited: true }], ['SHARED', { revision: 1, global: true, folders: [] }, undefined]]);
    assert.doesNotMatch(JSON.stringify(view), new RegExp(canary));
    const edited = await f.runtime.control('sharing', { secretId: legacy.metadata.id, revision: 0, global: false, folders: [{ hostId: f.service.device().id, root: f.projectRoot }] }) as SecretSettingsView;
    assert.deepEqual(edited.secrets.find(item => item.id === legacy.metadata.id)?.sharing, { revision: 1, global: false, folders: [{ hostId: f.service.device().id, root: f.projectRoot }] });
    await assert.rejects(f.runtime.control('sharing', { secretId: legacy.metadata.id, revision: 0, global: true, folders: [] }), { kind: 'conflict' });
    await f.runtime.control('lock', {});
    assert.deepEqual(await f.runtime.control('settings', {}), { status: { initialized: true, locked: true, pendingImports: 0, pendingImportIds: [] }, peers: [], secrets: [] });
  } finally { await f.cleanup(); }
});

test('a session view says why a session has nothing, and which states stop polling', async () => {
  const f = await fixture();
  try {
    const view = async (sessionId = f.session.id) => { const answer = await f.runtime.control('session', { sessionId }) as SecretSessionView; return [answer.error, answer.permanent, answer.available.length]; };
    assert.deepEqual(await view(), ['uninitialized', true, 0]);
    await f.initialize(); await f.runtime.control('create', { name: 'SHARED', kind: 'scalar', value: canary, sharing: { global: true, folders: [] } });
    assert.deepEqual(await view(), [undefined, undefined, 1]);
    const child = sessionRecord(f.projectRoot, { id: 'codex:child', isSubagent: true }); f.sessions.set(child.id, child); f.origins.set(child.id, { kind: 'owner', untrustedInput: false });
    const agent = sessionRecord(f.projectRoot, { id: 'codex:agent' }); f.sessions.set(agent.id, agent); f.origins.set(agent.id, { kind: 'agent', untrustedInput: false });
    const gone = sessionRecord(join(f.directory, 'deleted-folder'), { id: 'codex:gone' }); f.sessions.set(gone.id, gone); f.origins.set(gone.id, { kind: 'owner', untrustedInput: false });
    assert.deepEqual(await view(child.id), ['not-eligible', true, 0]);
    assert.deepEqual(await view(agent.id), ['not-eligible', true, 0], 'an agent session without a broker approval');
    assert.deepEqual(await view(gone.id), ['not-eligible', true, 0], 'a folder that no longer exists');
    assert.deepEqual(await view('codex:unknown'), ['session-closed', true, 0]);
    f.session.closed = true; assert.deepEqual(await view(), ['session-closed', true, 0]); f.session.closed = false;
    assert.deepEqual(await f.runtime.sessionSubject(child.id), { error: 'not-eligible' });
    await f.runtime.control('lock', {});
    assert.deepEqual(await view(), ['locked', false, 0]);
    assert.deepEqual(await f.runtime.sessionSubject(f.session.id), { error: 'locked' });
  } finally { await f.cleanup(); }
});

test('a session view shows this session’s recent uses, newest first, and what the owner may connect, without values', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const unshared = (await f.runtime.control('create', { name: 'UNSHARED', kind: 'scalar', value: canary }) as SecretSettingsView).secrets[0]!;
    const connected = await f.runtime.control('create', { sessionId: f.session.id, name: 'PASTED', kind: 'scalar', value: canary, connect: 'session', temporary: true }) as SecretSessionView;
    assert.deepEqual(connected.connectable.map(item => item.name), ['UNSHARED'], 'saved secrets, shared or not; a pasted value is already connected');
    const token = f.tokenFor(f.addRun('usage-run')); const reference = connected.available[0]!.reference;
    await f.call(token, 'secrets_run', { operationId: 'usage-1', command: process.execPath, args: ['-e', ''], env: { TOKEN: reference } });
    await f.call(token, 'secrets_fingerprint', { reference });
    const view = await f.runtime.control('session', { sessionId: f.session.id }) as SecretSessionView;
    assert.deepEqual(view.usage.map(entry => [entry.name, entry.operation, entry.outcome, entry.review]), [['PASTED', 'fingerprint', 'delivered', 'exempt'], ['PASTED', 'env', 'delivered', 'exempt']]);
    assert.doesNotMatch(JSON.stringify(view), new RegExp(canary));
    assert.deepEqual((await f.runtime.sessionSubject(f.session.id) as { usage: unknown[] }).usage, view.usage, 'a controller viewing this session sees the same uses');
    const other = sessionRecord(f.projectRoot, { id: 'codex:other' }); f.sessions.set(other.id, other); f.origins.set(other.id, { kind: 'owner', untrustedInput: false });
    assert.deepEqual((await f.runtime.control('session', { sessionId: other.id }) as SecretSessionView).usage, [], 'uses stay with their session');
    assert.ok(unshared);
  } finally { await f.cleanup(); }
});

test('a value pasted for one session and disconnected there is offered to connect again, and comes back only in that session', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const pasted = (await f.runtime.control('create', { sessionId: f.session.id, name: 'PASTED', kind: 'scalar', value: canary, connect: 'session', temporary: true }) as SecretSessionView).available[0]!;
    const stopped = await f.runtime.control('session-disconnect', { sessionId: f.session.id, secretIds: [pasted.id] }) as SecretSessionView;
    assert.deepEqual([stopped.available, stopped.connectable], [[], []]);
    assert.deepEqual(stopped.disconnected?.map(item => [item.name, item.remote, item.sourceHostId]), [['PASTED', false, f.service.device().id]]);
    assert.deepEqual((await f.runtime.control('session-reallow', { sessionId: f.session.id, secretIds: [pasted.id] }) as SecretSessionView).available, [], 'allowing again never connects this vault’s own value');
    const back = await f.runtime.control('session-connect', { sessionId: f.session.id, secretIds: [pasted.id] }) as SecretSessionView;
    assert.deepEqual([back.available.map(item => [item.name, item.basis]), back.disconnected], [[['PASTED', ['session']]], []]);
    const other = sessionRecord(f.projectRoot, { id: 'codex:other-paste' }); f.sessions.set(other.id, other); f.origins.set(other.id, { kind: 'owner', untrustedInput: false });
    await assert.rejects(f.runtime.control('session-connect', { sessionId: other.id, secretIds: [pasted.id] }));
    assert.doesNotMatch(JSON.stringify([stopped, back]), new RegExp(canary));
  } finally { await f.cleanup(); }
});

test('the owner view of a joined computer’s session reads this vault for what that computer reported, and starts nothing', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const device = { ...f.service.device(), id: randomUUID() };
    await f.service.trustPeer({ device, routeId: 'fixture-node', direction: 'node', enabled: true });
    await f.runtime.control('create', { name: 'GLOBAL', kind: 'scalar', value: canary, sharing: { global: true, folders: [] } });
    await f.runtime.control('create', { name: 'NODE_FOLDER', kind: 'scalar', value: canary, sharing: { global: false, folders: [{ hostId: device.id, root: '/node/project' }] } });
    const usage = [{ at: 1, secretId: 'x', name: 'GLOBAL', operation: 'env', outcome: 'delivered', review: 'exempt' }];
    const journal = await readFile(join(f.stateDir, 'secrets/journal.json'));
    const subject = { hostId: device.id, sessionId: 'codex:remote', root: '/node/project', usage };
    const view = await f.runtime.control('session', { sessionId: 'codex:remote', nodeId: 'fixture-node' }, subject) as SecretSessionView;
    assert.deepEqual(view.available.map(item => [item.name, item.basis]), [['GLOBAL', ['global']], ['NODE_FOLDER', ['folder']]]);
    assert.deepEqual(view.usage, usage); assert.deepEqual(view.connectable.map(item => item.name), ['GLOBAL', 'NODE_FOLDER']);
    assert.deepEqual(await readFile(join(f.stateDir, 'secrets/journal.json')), journal, 'no task for the joined computer’s session');
    assert.deepEqual(await f.runtime.control('session', { sessionId: 'codex:remote', nodeId: 'fixture-node' }, { error: 'worker-update-pending' }), { status: { initialized: true, locked: false }, available: [], connectable: [], usage: [], unavailableSources: [], updatePendingSources: [], error: 'worker-update-pending', permanent: false });
    await assert.rejects(f.runtime.control('session', { sessionId: 'codex:remote', nodeId: 'fixture-node' }, { ...subject, usage: [{ value: canary }] }), { kind: 'invalid' });
    await assert.rejects(f.runtime.control('session', { sessionId: 'codex:remote', nodeId: 'fixture-node' }), { kind: 'invalid' });
    await assert.rejects(f.runtime.control('session', { sessionId: 'codex:other', nodeId: 'fixture-node' }, subject), { kind: 'unavailable' });
  } finally { await f.cleanup(); }
});

test('broker approval creates one exact task, preserves provenance and does not grant secret policy', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    const before = await f.runtime.control('broker-access', { sessionId: f.session.id });
    assert.equal('eligible' in before && before.eligible, true);
    assert.equal('taskId' in before && before.taskId, null);
    assert.equal(f.service.currentTask(f.session.id, f.projectRoot), undefined, 'metadata GET never starts a task');
    const input = { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Fixture deployment', ttlMs: 60000 };
    const access = await f.runtime.control('approve-broker', input);
    assert.ok('approval' in access && access.approval);
    const approval = access.approval;
    assert.equal(approval.root, f.projectRoot);
    assert.deepEqual(f.origins.get(f.session.id), { kind: 'agent', untrustedInput: false });
    assert.deepEqual(f.service.settings().secrets, []);
    await f.service.create({ name: 'FAKE_UNGRANTED', kind: 'scalar', value: 'fixture-only' });
    await assert.rejects(f.runtime.control('approve-broker', input), /변경/);
    const replay = await f.runtime.control('approve-broker', { ...input, taskId: approval.taskId, ttlMs: 120000 });
    assert.ok('approval' in replay && replay.approval);
    assert.deepEqual(replay.approval, approval, 'a duplicate approval never rotates a token or extends TTL');
    const run = f.addRun('approved-broker-run'); const tools = f.resolver(run, f.session);
    assert.equal(tools.towerTools, 'broker-only'); run.towerTools = tools.towerTools;
    assert.ok(tools.servers?.tower_secrets);
    assert.equal(tools.servers?.tower, undefined); assert.equal(tools.servers?.tower_master, undefined);
    assert.equal(tools.servers?.tower_slack, undefined); assert.equal(tools.servers?.tower_github, undefined);
    const token = tools.servers!.tower_secrets.env!.TOWER_SECRET_CAPABILITY;
    assert.deepEqual((await f.list(token)).secrets, []);
    assert.equal(f.ledger.length, 0);
    await assert.rejects(f.call(token, 'sessions_list'));
  } finally { await f.cleanup(); }
});

test('approved tokens fail closed across lock, expiry, revoke and reapprove', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    const input = { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Fixture', ttlMs: 60000 };
    const approved = await f.runtime.control('approve-broker', input); assert.ok('approval' in approved && approved.approval);
    const token = f.tokenFor(f.addRun('approval-lifetime'));
    await f.runtime.control('lock', {});
    await assert.rejects(f.list(token));
    assert.equal(f.runtime.brokerApproval(f.session), undefined);
    await f.runtime.control('unlock', { password });
    assert.deepEqual((await f.list(token)).secrets, []);
    await f.runtime.control('revoke-broker', { sessionId: f.session.id, approvalId: approved.approval.id });
    await assert.rejects(f.list(token));
    await assert.rejects(handleMcpRequest(f.context, token, { method: 'tools/list' }));
    const again = await f.runtime.control('approve-broker', { ...input, taskId: approved.approval.taskId });
    assert.ok('approval' in again && again.approval); assert.notEqual(again.approval.id, approved.approval.id);
    await assert.rejects(f.list(token), 'reapproval cannot revive the old capability');
    const next = f.tokenFor(f.addRun('new-approval-token'));
    assert.deepEqual((await f.list(next)).secrets, []);
    f.advance(60001);
    await assert.rejects(f.list(next));
    await assert.rejects(handleMcpRequest(f.context, next, { method: 'tools/list' }));
  } finally { await f.cleanup(); }
});

test('broker approvals reject inherited, external, remote, closed and changed root identities', async () => {
  const f = await fixture();
  try {
    await f.initialize();
    const input = { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Fixture', ttlMs: 60000 };
    const patchCases: Partial<Session>[] = [{ parentId: 'parent' }, { isSubagent: true }, { launchedByAgent: true }, { node: 'remote' }, { master: true }, { closed: true }];
    for (const patch of patchCases) {
      f.sessions.set(f.session.id, { ...f.session, ...patch }); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
      await assert.rejects(f.runtime.control('approve-broker', input));
    }
    f.sessions.set(f.session.id, f.session);
    for (const origin of [{ kind: 'agent' as const, untrustedInput: true }, { kind: 'agent' as const, untrustedInput: false, controllerId: 'controller-local' }, { kind: 'owner' as const, untrustedInput: false }]) {
      f.origins.set(f.session.id, origin); await assert.rejects(f.runtime.control('approve-broker', input));
    }
    f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    await assert.rejects(f.runtime.control('approve-broker', { ...input, root: f.alias }), /변경/);
    await assert.rejects(f.runtime.control('approve-broker', { ...input, taskId: randomUUID() }), /변경/);
    await assert.rejects(f.runtime.control('approve-broker', { ...input, hostId: randomUUID() }));
    const approval = await f.runtime.control('approve-broker', input); assert.ok('approval' in approval && approval.approval);
    const token = f.tokenFor(f.addRun('root-bound'));
    f.sessions.set(f.session.id, { ...f.session, cwd: f.directory });
    await assert.rejects(f.list(token));
    f.sessions.set(f.session.id, f.session);
    await f.runtime.endSession(f.session.id);
    await assert.rejects(f.list(token));
    assert.equal((await f.runtime.brokerAccess(f.session.id)).eligible, false);
  } finally { await f.cleanup(); }
});

test('closing a task invalidates its approval and a new task cannot inherit a token', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    const input = { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Fixture', ttlMs: 60000 };
    const first = await f.runtime.control('approve-broker', input); assert.ok('approval' in first && first.approval);
    const token = f.tokenFor(f.addRun('first-task-token'));
    await f.service.closeTask(first.approval.taskId);
    await assert.rejects(f.list(token));
    const next = await f.runtime.control('approve-broker', input); assert.ok('approval' in next && next.approval);
    assert.notEqual(first.approval.taskId, next.approval.taskId);
    await assert.rejects(f.list(token));
    const nextToken = f.tokenFor(f.addRun('next-task-token')); assert.deepEqual((await f.list(nextToken)).secrets, []);
  } finally { await f.cleanup(); }
});

test('dispatch rechecks current run and session synchronously before spawning a fixture consumer', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    await f.runtime.control('approve-broker', { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Fixture', ttlMs: 60000 });
    const run = f.addRun('dispatch-race'); const token = f.tokenFor(run);
    const dispatch = f.service.dispatch.bind(f.service);
    f.service.dispatch = (context, uses, start, validate) => {
      f.origins.set(f.session.id, { kind: 'agent', untrustedInput: true });
      return dispatch(context, uses, () => { assert.fail('consumer must not start after provenance changes'); return start(); }, validate);
    };
    const result = await f.call(token, 'secrets_run', { operationId: 'fixture-dispatch-race', command: process.execPath, args: ['-e', "process.stdout.write('fixture consumer')"] }) as SecretRunResult;
    assert.equal(result.exitCode, null); assert.equal(result.stdout, '');
    assert.match(result.stderr, /완료하지 못했습니다/);
  } finally { await f.cleanup(); }
});

test('broker service independently denies revoked approval at list, resolve, claim and dispatch', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    const approved = await f.runtime.control('approve-broker', { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Fixture', ttlMs: 60000 }); assert.ok('approval' in approved && approved.approval);
    const run = f.addRun('service-approval'); f.tokenFor(run);
    const capability: Extract<Capability, { kind: 'secret-run' }> = { kind: 'secret-run', runId: run.id, sessionId: f.session.id, approvalId: approved.approval.id };
    const context = await f.runtime.context(capability);
    const secret = await f.service.create({ kind: 'scalar', name: 'FIXTURE_ONLY', value: canary, temporary: true }, context);
    await f.service.revokeBroker(f.session.id, approved.approval.id);
    await assert.rejects(f.service.list(context));
    await assert.rejects(f.service.resolve(context, secret.reference, 'env'));
    await assert.rejects(f.service.beginOperation(context, 'fixture-claim', 'a'.repeat(64)));
    await assert.rejects(f.service.dispatch(context, [], () => assert.fail('revoked approval must not dispatch')));
  } finally { await f.cleanup(); }
});


test('concurrent approval requests compare and create one exact security task atomically', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    const input = { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Fixture race', ttlMs: 60000 };
    const results = await Promise.allSettled([f.runtime.control('approve-broker', input), f.runtime.control('approve-broker', input)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const approval = f.runtime.brokerApproval(f.session); assert.ok(approval);
    const context = { ...f.service.currentTask(f.session.id, f.projectRoot)!, runId: 'fixture', brokerApprovalId: approval.id };
    for (const patch of [{ hostId: randomUUID() }, { taskId: randomUUID() }, { sessionId: 'codex:another' }, { root: f.directory }, { brokerApprovalId: randomUUID() }]) {
      await assert.rejects(f.service.list({ ...context, ...patch }));
    }
  } finally { await f.cleanup(); }
});

test('an open task must close before the same approved session can move to another project root', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    const input = { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Root A fixture', ttlMs: 60000 };
    const approved = await f.runtime.control('approve-broker', input); assert.ok('approval' in approved && approved.approval);
    const oldToken = f.tokenFor(f.addRun('root-a-old-capability'));
    assert.deepEqual((await f.list(oldToken)).secrets, []);
    const rootB = join(f.directory, 'project-b'); await mkdir(rootB);
    f.sessions.set(f.session.id, { ...f.session, cwd: rootB });
    const nextInput = { ...input, root: rootB, taskLabel: 'Root B fixture' };
    await assert.rejects(f.runtime.control('approve-broker', nextInput), /작업|프로젝트/);
    assert.equal(f.service.currentTask(f.session.id, rootB), undefined, 'denied root change creates no task');
    await assert.rejects(f.list(oldToken));
    await f.service.closeTask(approved.approval.taskId);
    const next = await f.runtime.control('approve-broker', nextInput); assert.ok('approval' in next && next.approval);
    assert.notEqual(next.approval.taskId, approved.approval.taskId);
    assert.equal(next.approval.root, rootB);
    await assert.rejects(f.list(oldToken));
    const newToken = f.tokenFor(f.addRun('root-b-new-capability'), f.sessions.get(f.session.id));
    assert.deepEqual((await f.list(newToken)).secrets, []);
    f.sessions.set(f.session.id, f.session);
    await assert.rejects(f.list(oldToken), 'returning to root A cannot revive the retired approval');
  } finally { await f.cleanup(); }
});

test('approved agent broker tools require immutable owner admission proof rather than an owner origin label', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    const approved = await f.runtime.control('approve-broker', { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Proof fixture', ttlMs: 60000 }); assert.ok('approval' in approved && approved.approval);
    for (const brokerOwnerAuthorized of [undefined, false]) {
      const run = f.addRun('unproven-' + String(brokerOwnerAuthorized), f.session, { brokerOwnerAuthorized });
      assert.equal(f.resolver(run, f.session).servers?.tower_secrets, undefined);
      run.towerTools = 'broker-only';
      const forged = f.capabilities.issue({ kind: 'secret-run', runId: run.id, sessionId: f.session.id, approvalId: approved.approval.id });
      await assert.rejects(f.list(forged));
      await assert.rejects(handleMcpRequest(f.context, forged, { method: 'tools/list' }));
    }
    const run = f.addRun('proven-owner'); const token = f.tokenFor(run);
    assert.deepEqual((await f.list(token)).secrets, []);
    run.origin = { kind: 'agent' };
    await assert.rejects(f.list(token));
    run.origin = { kind: 'owner' }; run.brokerOwnerAuthorized = false;
    await assert.rejects(f.list(token));
    f.origins.set(f.session.id, { kind: 'owner', untrustedInput: false });
    const ordinary = f.addRun('ordinary-owner-without-new-proof', f.session, { brokerOwnerAuthorized: undefined });
    const ordinaryToken = f.tokenFor(ordinary); assert.deepEqual((await f.list(ordinaryToken)).secrets, []);
  } finally { await f.cleanup(); }
});

test('master folder identity is excluded even without a display flag and through canonical aliases', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    const master = join(f.stateDir, 'master-session'); await mkdir(master);
    const child = join(master, 'child'); await mkdir(child);
    const alias = join(f.directory, 'master-alias'); await symlink(master, alias);
    for (const cwd of [master, child, alias]) {
      const record = { ...f.session, cwd, master: false }; f.sessions.set(record.id, record);
      const access = await f.runtime.brokerAccess(record.id); assert.equal(access.eligible, false); assert.match(access.reason!, /마스터/);
      await assert.rejects(f.runtime.control('approve-broker', { sessionId: record.id, root: await realpath(cwd), taskId: null, taskLabel: 'Master denial', ttlMs: 60000 }));
      assert.equal(f.resolver(f.addRun('master-' + cwd, record), record).servers?.tower_secrets, undefined);
    }
  } finally { await f.cleanup(); }
});

test('official reopen clears the transient fence but requires a new task approval and never revives old capabilities', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    const input = { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Reopen fixture', ttlMs: 60000 };
    const before = await f.runtime.control('approve-broker', input); assert.ok('approval' in before && before.approval);
    const oldToken = f.tokenFor(f.addRun('before-reopen'));
    f.session.closed = true; await f.runtime.endSession(f.session.id);
    await assert.rejects(f.runtime.reopenSession(f.session.id));
    f.session.closed = false; await f.runtime.reopenSession(f.session.id);
    assert.equal((await f.runtime.brokerAccess(f.session.id)).eligible, true);
    assert.equal(f.runtime.brokerApproval(f.session), undefined);
    await assert.rejects(f.list(oldToken));
    const after = await f.runtime.control('approve-broker', input); assert.ok('approval' in after && after.approval);
    assert.notEqual(after.approval.id, before.approval.id); assert.notEqual(after.approval.taskId, before.approval.taskId);
    await assert.rejects(f.list(oldToken));
    assert.deepEqual((await f.list(f.tokenFor(f.addRun('after-reopen')))).secrets, []);
  } finally { await f.cleanup(); }
});

test('locked official reopen retains durable cleanup until unlock and no-vault reopen retains no permanent fence', async () => {
  const f = await fixture();
  try {
    f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    f.session.closed = true; await f.runtime.endSession(f.session.id); f.session.closed = false;
    await f.runtime.reopenSession(f.session.id);
    assert.equal((await f.runtime.brokerAccess(f.session.id)).eligible, true);
    await f.initialize();
    const input = { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Locked reopen', ttlMs: 60000 };
    const before = await f.runtime.control('approve-broker', input); assert.ok('approval' in before && before.approval);
    const token = f.tokenFor(f.addRun('locked-before-reopen'));
    await f.runtime.control('lock', {}); f.session.closed = true; await f.runtime.endSession(f.session.id);
    f.session.closed = false; await f.runtime.reopenSession(f.session.id);
    const closed = await f.runtime.brokerAccess(f.session.id); assert.equal(closed.eligible, false);
    await f.runtime.control('unlock', { password });
    assert.equal((await f.runtime.brokerAccess(f.session.id)).eligible, true);
    await assert.rejects(f.list(token));
    const after = await f.runtime.control('approve-broker', input); assert.ok('approval' in after && after.approval);
    assert.notEqual(after.approval.taskId, before.approval.taskId);
  } finally { await f.cleanup(); }
});

test('broker admission protection remains value-free while locked, across startup and project root changes', async () => {
  const f = await fixture(); let restartedRuntime: SecretRuntime | undefined;
  try {
    f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    assert.equal(f.runtime.brokerAdmissionRequired(f.session), false, 'fresh vault has no protected broker history');
    await f.initialize();
    const approved = await f.runtime.control('approve-broker', { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Locked admission', ttlMs: 60000 }); assert.ok('approval' in approved && approved.approval);
    await f.service.create({ name: 'FAKE_PRIVATE_INDEX_CHECK', kind: 'scalar', value: canary });
    assert.equal(f.runtime.brokerAdmissionRequired(f.session), true);
    await f.runtime.control('lock', {});
    assert.equal(f.runtime.brokerApproval(f.session), undefined, 'locked refusal metadata never authorizes a capability');
    assert.equal(f.runtime.brokerAdmissionRequired(f.session), true);
    assert.equal(f.service.brokerAdmissionRequired(f.session.id), true);
    f.sessions.set(f.session.id, { ...f.session, cwd: f.directory });
    assert.equal(f.runtime.brokerAdmissionRequired(f.sessions.get(f.session.id)), true, 'moving root cannot permit unproved input into the same protected conversation');
    const indexText = JSON.stringify(f.service.vault.index);
    assert.ok(indexText.includes(approved.approval.id)); assert.ok(indexText.includes('brokerApprovals'));
    assert.equal(indexText.includes(canary), false); assert.equal(indexText.includes(password), false);
    const restarted = await secretService(f.stateDir, { now: f.now });
    const registry = { list: () => [...f.runs.values()], getSession: (id: string) => f.sessions.get(id), sessionOrigin: (id: string) => f.origins.get(id) };
    restartedRuntime = new SecretRuntime({ stateDir: f.stateDir, service: restarted, runs: registry });
    assert.equal(restarted.status().locked, true);
    assert.equal(restartedRuntime.brokerAdmissionRequired(f.sessions.get(f.session.id)), true);
    assert.equal(restartedRuntime.brokerApproval(f.sessions.get(f.session.id)), undefined);
    f.sessions.set(f.session.id, f.session);
    await f.runtime.control('unlock', { password });
    assert.equal(f.runtime.brokerAdmissionRequired(f.session), true);
    assert.deepEqual((await f.list(f.tokenFor(f.addRun('proven-after-lock')))).secrets, []);
    await f.runtime.control('revoke-broker', { sessionId: f.session.id, approvalId: approved.approval.id });
    assert.equal(f.runtime.brokerAdmissionRequired(f.session), false);
    await f.runtime.control('lock', {}); assert.equal(f.service.brokerAdmissionRequired(f.session.id), undefined);
    assert.equal(f.runtime.brokerAdmissionRequired(f.session), true, 'plaintext revoked metadata cannot establish trusted absence while locked');
  } finally { restartedRuntime?.close(); await f.cleanup(); }
});

test('missing, legacy and malformed locked broker indexes protect only local agent main-session admissions', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    await f.runtime.control('approve-broker', { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Unknown locked index', ttlMs: 60000 });
    await f.runtime.control('lock', {});
    const original = structuredClone(f.service.vault.index) as Record<string, unknown>;
    const legacy = { ...original }; delete legacy.brokerApprovals;
    for (const index of [undefined, legacy, { ...original, brokerApprovals: [] }, { ...original, brokerApprovals: 'malformed' }, { ...original, brokerApprovals: [{ id: 'invalid' }] }, { ...original, policy: { deviceId: 'invalid', tasks: [] } }]) {
      f.service.vault.index = index;
      assert.equal(f.service.brokerAdmissionRequired(f.session.id), undefined);
      assert.equal(f.runtime.brokerAdmissionRequired(f.session), true, 'unknown metadata never establishes absence of protection');
      for (const patch of [{ node: 'remote' }, { isSubagent: true }, { launchedByAgent: true }, { parentId: 'parent' }, { master: true }]) assert.equal(f.runtime.brokerAdmissionRequired({ ...f.session, ...patch }), false);
      for (const origin of [{ kind: 'owner' as const, untrustedInput: false }, { kind: 'agent' as const, untrustedInput: true }, { kind: 'agent' as const, untrustedInput: false, controllerId: 'remote' }]) {
        f.origins.set(f.session.id, origin); assert.equal(f.runtime.brokerAdmissionRequired(f.session), false);
      }
      f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
      assert.equal(f.runtime.brokerApproval(f.session), undefined);
    }
    f.service.vault.index = original;
    f.advance(60001);
    assert.equal(f.service.brokerAdmissionRequired(f.session.id), undefined, 'plaintext expired metadata cannot establish trusted absence while locked');
    assert.equal(f.runtime.brokerAdmissionRequired(f.session), true);
    await f.runtime.control('unlock', { password });
    assert.equal(f.runtime.brokerAdmissionRequired(f.session), false, 'the unlocked encrypted journal establishes expiry');
  } finally { await f.cleanup(); }
});

test('unfinished unlock never treats the temporarily empty journal as trusted absence of broker protection', async () => {
  const f = await fixture();
  try {
    await f.initialize(); f.origins.set(f.session.id, { kind: 'agent', untrustedInput: false });
    await f.runtime.control('approve-broker', { sessionId: f.session.id, root: f.projectRoot, taskId: null, taskLabel: 'Delayed unlock fixture', ttlMs: 60000 });
    await f.runtime.control('lock', {});
    let resumeJournal!: () => void; let journalStarted!: () => void;
    const delayed = new Promise<void>(resolve => { resumeJournal = resolve; });
    const started = new Promise<void>(resolve => { journalStarted = resolve; });
    const originalJournal = f.service.vault.journal.bind(f.service.vault);
    f.service.vault.journal = async () => { journalStarted(); await delayed; return originalJournal(); };
    const unlocking = f.runtime.control('unlock', { password });
    await started;
    try {
      assert.equal(f.service.status().locked, false, 'synthetic gap is after key opens but before journal restoration');
      assert.equal(f.service.brokerAdmissionRequired(f.session.id), false, 'the service has not yet restored the approval journal');
      assert.equal(f.runtime.brokerAdmissionRequired(f.session), true, 'runtime initialization fence protects admission during the gap');
      assert.equal(f.runtime.brokerApproval(f.session), undefined, 'initialization fence still prevents capability issuance');
      assert.equal(f.runtime.brokerAdmissionRequired({ ...f.session, isSubagent: true }), false, 'unknown-state fallback stays limited to local agent main sessions');
    } finally { resumeJournal(); }
    await unlocking;
    assert.equal(f.runtime.brokerAdmissionRequired(f.session), true);
    assert.ok(f.runtime.brokerApproval(f.session));
  } finally { await f.cleanup(); }
});
