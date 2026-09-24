import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CapabilityRegistry, handleMcpRequest, type McpContext } from '../../../server/api/mcp.js';
import { TowerApi } from '../../../server/api/tower-api.js';
import { TriggerService } from '../../../server/triggers/service.js';
import type { AutoPromptJob, Run, RunOrigin, Session } from '../../../shared/types.js';
import type { TriggerActor, TriggerEvent } from '../../../shared/triggers.js';
import { until } from '../../helpers/until.ts';

const CONTROLLER = 'controllera1b2c3d4e5f6';
const remote: TriggerActor = { kind: 'owner', via: 'remote', controllerId: CONTROLLER };
const owner: TriggerActor = { kind: 'owner', via: 'ui' };
const requests = (() => { let next = 0; return () => `0199a2b3-c4d5-7123-8abc-${String(++next).padStart(12, '0')}`; })();

/** This computer with a shared folder `open` and a folder `secret` kept out of sharing, and a conversation in each. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tower-remote-triggers-'));
  const open = join(root, 'open'), secret = join(root, 'secret');
  await Promise.all([mkdir(open), mkdir(secret)]);
  const excluded = new Set([secret]);
  const excludes = (path: string) => [...excluded].some(folder => path === folder || path.startsWith(`${folder}/`));
  const session = (id: string, cwd: string): Session => ({ id, nativeId: id.split(':')[1], provider: 'codex', title: id, cwd, project: 'p', status: 'idle', statusReason: '',
    createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true });
  const sessions = [session('codex:shared', open), session('codex:private', secret)];
  const runs: Run[] = [];
  const started: Array<{ how: string; origin?: RunOrigin; cwd?: string }> = [];
  const job = (requestId: string): AutoPromptJob => ({ id: requestId, provider: 'codex', prompt: '', routerModel: 'r', status: 'queued', createdAt: '', updatedAt: '' });
  const triggers = new TriggerService({ stateDir: root, tickMs: 60_000, excludes: async path => excludes(path), executor: {
    submitAutoPrompt: async (request, internal) => { started.push({ how: 'auto', origin: internal.origin }); return job(request.requestId); },
    getAutoPrompt: () => undefined,
    create: async (input, internal) => {
      started.push({ how: 'folder', origin: internal.origin, cwd: input.cwd });
      const run: Run = { id: randomUUID(), sessionId: `codex:${randomUUID()}`, prompt: '', status: 'running', createdAt: '', output: '' };
      return { session: session(run.sessionId, input.cwd), run };
    },
    enqueue: async () => { throw new Error('unused'); }, runs: () => runs, session: id => sessions.find(item => item.id === id) } });
  await triggers.start();
  const submitted: Array<{ origin?: RunOrigin }> = [];
  const api = new TowerApi({ stateDir: root, triggers, runs: { list: () => runs }, sessions: { list: () => sessions, read: async () => [] },
    projects: () => [{ cwd: open, title: 'open', sessions: 1, pinned: false }, { cwd: secret, title: 'secret', sessions: 1, pinned: false }],
    autoPrompts: { submit: async (request, internal) => { submitted.push(internal); return job(request.requestId); }, get: () => undefined },
    remote: async () => ({ matcher: { revision: 1, excludes }, coordinators: new Set() }) });
  t.after(async () => { triggers.close(); await rm(root, { recursive: true, force: true }); });
  const call = <T>(name: string, input: unknown, actor = remote, key?: string) => api.call(name, input, actor, key ?? (actor.controllerId && actor.kind === 'owner' ? requests() : undefined)) as Promise<T>;
  return { root, open, secret, excluded, sessions, runs, started, submitted, triggers, api, call };
}
const trigger = (target: Record<string, unknown>, name = 'Digest') => ({ name, source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 8 * * *', timezone: 'Asia/Seoul' } },
  handler: { kind: 'task', instructions: 'Summarize', provider: 'codex', target } });

test('a controlling computer sees only triggers and runs that stay in shared folders; the rest reads as absent', async t => {
  const f = await fixture(t);
  const shared = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }, 'Shared') }, owner)).trigger;
  const hidden = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.secret }, 'Private') }, owner)).trigger;
  const inPrivate = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'session', sessionId: 'codex:private' }, 'Private session') }, owner)).trigger;
  await f.call('triggers.run', { id: hidden.id }, owner);
  await f.call('triggers.run', { id: shared.id }, owner);
  await until(() => f.started.length === 2);
  const listed = await f.call<{ triggers: Array<{ id: string }>; overview: { triggers: Array<{ id: string }>; recent: TriggerEvent[] } }>('triggers.list', {});
  assert.deepEqual(listed.triggers.map(item => item.id), [shared.id]);
  assert.deepEqual(listed.overview.triggers.map(item => item.id), [shared.id]);
  assert.ok(listed.overview.recent.every(event => event.triggerId === shared.id));
  const events = await f.call<{ events: TriggerEvent[] }>('triggers.events', {});
  assert.deepEqual([...new Set(events.events.map(event => event.triggerId))], [shared.id]);
  for (const id of [hidden.id, inPrivate.id]) {
    await assert.rejects(f.call('triggers.get', { id }), { statusCode: 404 });
    await assert.rejects(f.call('triggers.setEnabled', { id, enabled: false, expectedRevision: 1 }), { statusCode: 404 });
    await assert.rejects(f.call('triggers.delete', { id, expectedRevision: 1 }), { statusCode: 404 });
  }
  const audit = await f.call<{ audit: Array<{ triggerId: string }> }>('triggers.audit', {});
  assert.ok(audit.audit.every(entry => entry.triggerId === shared.id));
  await f.call('triggers.delete', { id: hidden.id, expectedRevision: 1 }, owner);
  assert.deepEqual((await f.call<{ triggers: unknown[] }>('triggers.deleted', {})).triggers, [], 'a deleted trigger that pointed into it stays hidden too');
  await assert.rejects(f.call('triggers.restore', { id: hidden.id }), { statusCode: 404 });
});

test('a controlling computer cannot aim a trigger at what it cannot see, and its changes mark the trigger as its own', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.secret }) }), { statusCode: 400, message: /does not exist/ });
  await assert.rejects(f.call('triggers.create', { trigger: trigger({ mode: 'session', sessionId: 'codex:private' }) }), { statusCode: 400, message: /session was not found/ });
  const created = (await f.call<{ trigger: { id: string; remoteEdited?: unknown; createdBy: TriggerActor } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }) })).trigger;
  assert.deepEqual(created.remoteEdited, { controllerId: CONTROLLER });
  assert.deepEqual(created.createdBy, remote);
  await assert.rejects(f.call('triggers.update', { id: created.id, expectedRevision: 1, trigger: trigger({ mode: 'folder', cwd: f.secret }) }), { statusCode: 400 });
  const local = (await f.call<{ trigger: { remoteEdited?: unknown } }>('triggers.update', { id: created.id, expectedRevision: 1, trigger: trigger({ mode: 'auto' }) }, owner)).trigger;
  assert.equal(local.remoteEdited, undefined, 'a change made here makes it this computer’s again');
  const again = (await f.call<{ trigger: { remoteEdited?: unknown } }>('triggers.revert', { id: created.id, expectedRevision: 2, revision: 1 })).trigger;
  assert.deepEqual(again.remoteEdited, { controllerId: CONTROLLER });
  const coordinator = { name: 'Issues', source: { kind: 'github', account: 'octo', watch: { type: 'mentions' }, schedule: { type: 'interval', everySeconds: 300 } },
    handler: { kind: 'coordinator', rules: [{ id: 'r', name: 'r', enabled: true, condition: 'c', instructions: 'i', replyInstructions: 'r', provider: 'codex' }] } };
  await assert.rejects(f.call('triggers.create', { trigger: coordinator }), (error: { statusCode?: number }) => error.statusCode === 403 || error.statusCode === 400);
  for (const [name, input] of [['triggers.updateSettings', { settings: { maxTriggers: 10, maxConcurrentRuns: 2, maxEventsPerHour: 10, privateHosts: [] } }], ['secrets.create', { secret: { name: 'x', origin: 'https://example.com', value: 'a-long-secret-value-here' } }]] as const) {
    await assert.rejects(f.call(name, input), { statusCode: 403 }, `${name} stays with this computer`);
  }
});

test('a change from a controlling computer is made once per request, even when sent again', async t => {
  const f = await fixture(t);
  const key = requests();
  const first = await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }) }, remote, key);
  const again = await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }) }, remote, key);
  assert.equal(again.trigger.id, first.trigger.id);
  assert.equal(f.triggers.list().length, 1);
});

test('what a trigger set up remotely starts never uses a folder kept out of sharing, whenever that became so', async t => {
  const f = await fixture(t);
  const folder = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }, 'Folder') })).trigger;
  const auto = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'auto' }, 'Auto') })).trigger;
  f.excluded.add(f.open);
  const refused = (await f.call<{ event: TriggerEvent }>('triggers.run', { id: folder.id }, owner)).event;
  const failed = await until(() => { const event = f.triggers.event(refused.id); return event.status === 'error' ? event : undefined; });
  assert.match(failed.error!, /keeps out of sharing/);
  assert.equal(f.started.filter(item => item.how === 'folder').length, 0);
  f.excluded.delete(f.open);
  await f.call('triggers.run', { id: auto.id }, owner);
  const routed = await until(() => f.started.find(item => item.how === 'auto'));
  assert.equal(routed.origin?.controllerId, CONTROLLER, 'Auto Prompt then leaves out folders kept from sharing');
  const mine = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'auto' }, 'Mine') }, owner)).trigger;
  await f.call('triggers.run', { id: mine.id });
  await until(() => f.started.filter(item => item.how === 'auto').length === 2);
  assert.equal(f.started.at(-1)!.origin?.controllerId, CONTROLLER, 'a run asked for from a controlling computer counts as started there');
});

test('an agent in a turn started from a controlling computer sees and starts only what that computer may', async t => {
  const f = await fixture(t);
  const run: Run = { id: randomUUID(), sessionId: 'codex:shared', prompt: '', status: 'running', createdAt: '', output: '', origin: { kind: 'owner', controllerId: CONTROLLER }, towerTools: 'attached' };
  f.runs.push(run);
  const capabilities = new CapabilityRegistry();
  const context: McpContext = { api: f.api, capabilities, run: id => f.runs.find(item => item.id === id) };
  const token = capabilities.issue({ kind: 'owner-run', runId: run.id, sessionId: run.sessionId });
  const tool = <T>(name: string, args: Record<string, unknown>) => handleMcpRequest(context, token, { method: 'tools/call', name, arguments: args }) as Promise<T>;
  assert.deepEqual((await tool<{ sessions: Array<{ id: string }> }>('sessions_list', {})).sessions.map(item => item.id), ['codex:shared']);
  assert.deepEqual((await tool<{ projects: Array<{ cwd: string }> }>('projects_list', {})).projects.map(item => item.cwd), [f.open]);
  await assert.rejects(tool('sessions_read', { id: 'codex:private' }), { statusCode: 404 });
  await tool('autoPrompt_submit', { requestId: randomUUID(), provider: 'codex', prompt: 'Look into it' });
  assert.deepEqual(f.submitted.at(-1)!.origin, { kind: 'agent', runId: run.id, controllerId: CONTROLLER });
  const created = await tool<{ trigger: { remoteEdited?: unknown; createdBy: TriggerActor } }>('triggers_create', { requestKey: 'k1', trigger: trigger({ mode: 'auto' }) });
  assert.deepEqual(created.trigger.remoteEdited, { controllerId: CONTROLLER });
  assert.equal(created.trigger.createdBy.controllerId, CONTROLLER);
});
