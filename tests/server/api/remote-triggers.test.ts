import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CapabilityRegistry, handleMcpRequest, type McpContext } from '../../../server/api/mcp.js';
import { TowerApi } from '../../../server/api/tower-api.js';
import { MAX_REVISIONS, REMOTE_FOLDER_REFUSED, TriggerService } from '../../../server/triggers/service.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { remoteTriggerLaunch } from '../../../server/remote/visibility.js';
import type { AutoPromptJob, Run, RunOrigin, Session } from '../../../shared/types.js';
import type { TriggerActor, TriggerEvent } from '../../../shared/triggers.js';
import { RemoteView } from '../../../server/api/remote-view.js';
import { until } from '../../helpers/until.ts';

const CONTROLLER = 'controllera1b2c3d4e5f6';
const remote: TriggerActor = { kind: 'owner', via: 'remote', controllerId: CONTROLLER };
const owner: TriggerActor = { kind: 'owner', via: 'ui' };
/** Request IDs as a controlling computer makes them: UUIDv7, with the time they were made. */
const requests = (() => { let next = 0; return () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7123-8abc-${String(++next).padStart(12, '0')}`; }; })();

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
  // Runs while a run is being admitted, before its last check (like a change to the sharing list at that moment).
  const admitting: { before?: () => void } = {};
  const triggers = new TriggerService({ stateDir: root, tickMs: 60_000, sharing: { check: async path => excludes(path), now: excludes }, executor: {
    submitAutoPrompt: async (request, internal) => { started.push({ how: 'auto', origin: internal.origin }); return job(request.requestId); },
    getAutoPrompt: () => undefined,
    create: async (input, internal) => {
      admitting.before?.();
      internal.validate?.();
      started.push({ how: 'folder', origin: internal.origin, cwd: input.cwd });
      const run: Run = { id: randomUUID(), sessionId: `codex:${randomUUID()}`, prompt: '', status: 'running', createdAt: '', output: '' };
      // A session a run starts is listed like any other.
      sessions.push(session(run.sessionId, input.cwd));
      return { session: session(run.sessionId, input.cwd), run };
    },
    enqueue: async () => { throw new Error('unused'); }, runs: () => runs, session: id => sessions.find(item => item.id === id) } });
  await triggers.start();
  const submitted: Array<{ origin?: RunOrigin }> = [];
  // Runs during a look (after `skip` others), after what it judges was read: like a change made here at that moment.
  const looking: { during?: () => Promise<unknown>; skip?: number } = {};
  const api = new TowerApi({ stateDir: root, triggers, runs: { list: () => runs }, sessions: { list: () => sessions, read: async () => [] },
    projects: () => [{ cwd: open, title: 'open', sessions: 1, pinned: false }, { cwd: secret, title: 'secret', sessions: 1, pinned: false }],
    autoPrompts: { submit: async (request, internal) => { submitted.push(internal); return { ...job(request.requestId), ...(internal.origin ? { origin: internal.origin } : {}) }; }, get: () => undefined },
    remote: async () => {
      const during = looking.skip ? undefined : looking.during;
      if (looking.skip) looking.skip--; else looking.during = undefined;
      await during?.();
      return { matcher: { revision: 1, excludes }, coordinators: new Set(['codex:coordinator']) }; } });
  // Runs still being handed over finish writing before the folder goes.
  t.after(async () => { triggers.close(); await triggers.settle(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const call = <T>(name: string, input: unknown, actor = remote, key?: string) => api.call(name, input, actor, key ?? (actor.controllerId && actor.kind === 'owner' ? requests() : undefined)) as Promise<T>;
  return { root, open, secret, excluded, sessions, runs, started, submitted, triggers, api, call, admitting, looking };
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
  const refusal = (cwd: string) => f.call('triggers.create', { trigger: trigger({ mode: 'folder', cwd }) }).then(() => '', (error: Error & { statusCode: number }) => `${error.statusCode} ${error.message.replace(cwd, '<folder>')}`);
  const missing = await refusal(join(f.root, 'nope'));
  assert.match(missing, /^400 /);
  for (const cwd of [f.secret, join(f.secret, 'inner'), join(f.secret, 'nope')]) assert.equal(await refusal(cwd), missing, 'a folder kept from sharing reads exactly as one that is not there');
  const sessionMissing = await f.call('triggers.create', { trigger: trigger({ mode: 'session', sessionId: 'codex:nowhere' }) }).catch((error: Error) => error.message);
  assert.equal(await f.call('triggers.create', { trigger: trigger({ mode: 'session', sessionId: 'codex:private' }) }).catch((error: Error) => error.message), sessionMissing);
  const created = (await f.call<{ trigger: { id: string; remoteEdited?: unknown; createdBy: TriggerActor } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }) })).trigger;
  assert.deepEqual(created.remoteEdited, { controllerId: CONTROLLER });
  assert.deepEqual(created.createdBy, remote);
  await assert.rejects(f.call('triggers.update', { id: created.id, expectedRevision: 1, trigger: trigger({ mode: 'folder', cwd: f.secret }) }), { statusCode: 400 });
  const local = (await f.call<{ trigger: { remoteEdited?: unknown } }>('triggers.update', { id: created.id, expectedRevision: 1, trigger: trigger({ mode: 'auto' }) }, owner)).trigger;
  assert.equal(local.remoteEdited, undefined, 'a change made here makes it this computer’s again');
  assert.deepEqual(await f.call('triggers.delete', { id: created.id, expectedRevision: 2 }), { deleted: true, trigger: { id: created.id, name: 'Digest' } });
  const restored = (await f.call<{ trigger: { remoteEdited?: unknown } }>('triggers.restore', { id: created.id }, owner)).trigger;
  assert.equal(restored.remoteEdited, undefined, 'restored here, it is this computer’s');
  const coordinator = { name: 'Issues', source: { kind: 'github', account: 'octo', auth: { type: 'gh' }, watch: { type: 'assigned-to-me' }, schedule: { type: 'interval', everySeconds: 300 } },
    handler: { kind: 'coordinator', rules: [{ id: 'r', name: 'r', enabled: true, condition: 'c', instructions: 'i', replyInstructions: 'r', provider: 'codex' }] } };
  await assert.rejects(f.call('triggers.create', { trigger: coordinator }), { statusCode: 403, message: /on that computer itself/ });
  const issues = (await f.call<{ trigger: { id: string; revision: number } }>('triggers.create', { trigger: coordinator }, owner)).trigger;
  await assert.rejects(f.call('triggers.run', { id: issues.id }), { statusCode: 403 });
  const off = (await f.call<{ trigger: { enabled: boolean; remoteEdited?: unknown } }>('triggers.setEnabled', { id: issues.id, enabled: false, expectedRevision: issues.revision })).trigger;
  assert.equal(off.enabled, false, 'a coordinator trigger can still be turned off from there');
  assert.deepEqual(off.remoteEdited, { controllerId: CONTROLLER }, 'turning it on or off is a change too');
  await assert.rejects(f.call('triggers.setEnabled', { id: issues.id, enabled: true, expectedRevision: issues.revision + 1 }), { statusCode: 403, message: /on that computer itself/ }, 'it is turned on there');
  for (const [name, input] of [['triggers.updateSettings', { settings: { maxTriggers: 10, maxConcurrentRuns: 2, maxEventsPerHour: 10, privateHosts: [] } }], ['secrets.create', { secret: { name: 'x', origin: 'https://example.com', value: 'a-long-secret-value-here' } }]] as const) {
    await assert.rejects(f.call(name, input), { statusCode: 403 }, `${name} stays with this computer`);
  }
});

test('a folder kept from sharing is refused at the same step, and in the same words, as one that is not there', async t => {
  const f = await fixture(t);
  const broken = (target: Record<string, unknown>) => ({ ...trigger(target), source: { kind: 'schedule', schedule: { type: 'cron', expression: '61 * * * *', timezone: 'Asia/Seoul' } } });
  const refusal = (target: Record<string, unknown>, cwd = '') => f.call('triggers.create', { trigger: broken(target) }).then(() => '', (error: Error & { statusCode: number }) => `${error.statusCode} ${cwd ? error.message.replace(cwd, '<folder>') : error.message}`);
  const missing = await refusal({ mode: 'folder', cwd: join(f.root, 'nope') }, join(f.root, 'nope'));
  assert.equal(await refusal({ mode: 'folder', cwd: f.open }, f.open), missing, 'a bad schedule is reported first');
  assert.equal(await refusal({ mode: 'folder', cwd: f.secret }, f.secret), missing);
  assert.equal(await refusal({ mode: 'session', sessionId: 'codex:private' }), await refusal({ mode: 'session', sessionId: 'codex:nowhere' }));
  const shared = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }) }, owner)).trigger;
  const hidden = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.secret }) }, owner)).trigger;
  const stale = (id: string) => f.call('triggers.update', { id, expectedRevision: 5, trigger: broken({ mode: 'auto' }) }).catch((error: Error & { statusCode: number }) => `${error.statusCode} ${error.message}`);
  assert.equal(await stale(hidden.id), await stale(randomUUID()), 'a trigger it cannot see reads as one that is not there, even for a bad change');
  const revert = (id: string) => f.call('triggers.revert', { id, revision: 1, expectedRevision: 5 }).catch((error: Error & { statusCode: number }) => error.statusCode);
  assert.equal(await revert(shared.id), 409, 'the revision it names is looked at after the trigger’s own');
});

test('a change from a controlling computer is made once per request, and its answer sent again follows what is shared now', async t => {
  const f = await fixture(t);
  const key = requests();
  const first = await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }) }, remote, key);
  const again = await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }) }, remote, key);
  assert.equal(again.trigger.id, first.trigger.id);
  assert.equal(f.triggers.list().length, 1);
  f.excluded.add(f.open);
  assert.deepEqual(await f.call('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }) }, remote, key), { done: true, note: 'This request succeeded. Read the current state for details.' },
    'the recorded answer names a folder no longer shared, so it says only that the change was made');
  f.excluded.delete(f.open);
  const old = `00000000-0001-7123-8abc-000000000001`;
  await assert.rejects(f.call('triggers.create', { trigger: trigger({ mode: 'auto' }) }, remote, old), { statusCode: 409, disposition: 'not-admitted' }, 'a request older than the record kept is never run');
  // A result too large to keep whole is read again when it is sent again.
  const long = { ...trigger({ mode: 'auto' }, 'Long'), handler: { ...trigger({ mode: 'auto' }).handler, instructions: 'x'.repeat(8000) } };
  const longKey = requests();
  const made = await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: long }, remote, longKey);
  const replayed = await f.call<{ trigger: { id: string; name: string } }>('triggers.create', { trigger: long }, remote, longKey);
  assert.equal(replayed.trigger.id, made.trigger.id);
  assert.equal(replayed.trigger.name, 'Long');
  // Reads that name no folder are answered too.
  assert.equal((await f.call<{ runs: string[] }>('triggers.preview', { schedule: { type: 'cron', expression: '0 8 * * *', timezone: 'Asia/Seoul' } })).runs.length, 5);
  assert.ok((await f.call<{ settings: { maxTriggers: number } }>('triggers.settings', {})).settings.maxTriggers > 0);
});

test('an answer shows what was read before it was judged, and a change that was made is never answered as not found', async t => {
  const f = await fixture(t);
  const shared = (await f.call<{ trigger: { id: string; revision: number } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }, 'Shared') }, owner)).trigger;
  // Moved into the private folder while the answer is being judged.
  f.looking.during = () => f.call('triggers.update', { id: shared.id, expectedRevision: shared.revision, trigger: trigger({ mode: 'folder', cwd: f.secret }, 'Private now') }, owner);
  const listed = await f.call<unknown>('triggers.list', {});
  assert.ok(!JSON.stringify(listed).includes('Private now'), 'what it became meanwhile is not shown');
  assert.ok(!JSON.stringify(listed).includes(f.secret));
  const again = await f.call<{ triggers: unknown[]; overview: { triggers: unknown[] } }>('triggers.list', {});
  assert.deepEqual([again.triggers.length, again.overview.triggers.length], [0, 0]);
  const mine = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }, 'Mine') })).trigger;
  // The look that admits it comes first; the folder is kept from sharing during the one that answers.
  Object.assign(f.looking, { skip: 1, during: async () => { f.excluded.add(f.open); } });
  assert.deepEqual(await f.call('triggers.run', { id: mine.id }), { done: true, note: 'This request succeeded. Read the current state for details.' }, 'it ran, though its folder was kept from sharing as it was answered');
});

test('history a controlling computer reads leaves out revisions, runs and conversations it cannot see', async t => {
  const f = await fixture(t);
  const moved = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.secret }, 'Private at first') }, owner)).trigger;
  await f.call('triggers.update', { id: moved.id, expectedRevision: 1, trigger: trigger({ mode: 'folder', cwd: f.open }, 'Shared now') }, owner);
  await f.call('triggers.setEnabled', { id: moved.id, expectedRevision: 2, enabled: false }, owner);
  const audit = (await f.call<{ audit: Array<{ action: string; triggerName: string }> }>('triggers.audit', {})).audit;
  assert.deepEqual(audit.map(entry => entry.action), ['disable'], 'the creation and the change away from the private folder name a revision it cannot see');
  const got = await f.call<{ trigger: { name: string }; revisions: unknown[] }>('triggers.get', { id: moved.id });
  assert.equal(got.trigger.name, 'Shared now');
  assert.deepEqual(got.revisions, [], 'the earlier revision, in the private folder, is left out');
  const agent: TriggerActor = { kind: 'agent', via: 'mcp', sessionId: 'codex:private', runId: randomUUID() };
  const byAgent = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'auto' }, 'By an agent') }, agent, 'agent-1')).trigger;
  const seen = await f.call<{ trigger: { createdBy: TriggerActor } }>('triggers.get', { id: byAgent.id });
  assert.deepEqual(seen.trigger.createdBy, { kind: 'agent', via: 'mcp' }, 'a conversation it cannot see is not named');
  const hidden = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.secret }, 'Private') }, owner)).trigger;
  const shared = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.open }, 'Shared') }, owner)).trigger;
  await f.call('triggers.run', { id: shared.id }, owner);
  await until(() => f.started.length === 1);
  await f.call('triggers.run', { id: hidden.id }, owner);
  await until(() => f.started.length === 2);
  const page = (await f.call<{ events: TriggerEvent[] }>('triggers.events', { limit: 1 })).events;
  assert.deepEqual(page.map(event => event.triggerId), [shared.id], 'a newer run it cannot see does not take the only place on the page');
});

test('a revision whose definition is no longer known keeps its history here', async t => {
  const f = await fixture(t);
  const audit = async () => (await f.call<{ audit: Array<{ triggerId: string; action: string; triggerName: string }> }>('triggers.audit', { limit: 200 })).audit;
  // Moved out of the private folder, then deleted: the deleted copy is the shared one.
  const deleted = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.secret }, 'Private at first') }, owner)).trigger;
  await f.call('triggers.update', { id: deleted.id, expectedRevision: 1, trigger: trigger({ mode: 'folder', cwd: f.open }, 'Shared later') }, owner);
  await f.call('triggers.delete', { id: deleted.id, expectedRevision: 2 }, owner);
  assert.deepEqual((await audit()).filter(entry => entry.triggerId === deleted.id).map(entry => entry.action), ['delete']);
  // Moved out, then changed until the private revision is no longer kept.
  const pruned = (await f.call<{ trigger: { id: string } }>('triggers.create', { trigger: trigger({ mode: 'folder', cwd: f.secret }, 'Private at first') }, owner)).trigger;
  for (let revision = 1; revision <= MAX_REVISIONS + 1; revision++) await f.call('triggers.update', { id: pruned.id, expectedRevision: revision, trigger: trigger({ mode: 'folder', cwd: f.open }, `Shared ${revision}`) }, owner);
  const entries = (await audit()).filter(entry => entry.triggerId === pruned.id);
  assert.equal(entries.length, MAX_REVISIONS, 'only changes between revisions it can see');
  assert.ok(!JSON.stringify(await audit()).includes('Private at first'));
});

test('a coordinator’s runs stay on this computer with its conversations', () => {
  const scope = { matcher: { revision: 1, excludes: () => false }, coordinators: new Set(['codex:coordinator']) };
  const view = new RemoteView(scope, [], { triggers: [], deleted: [], revisions: {} });
  const base = { id: 'e', triggerId: 't', triggerName: 'Issues', triggerRevision: 1, kind: 'github', dedupKey: 'k', occurredAt: '', receivedAt: '', updatedAt: '', status: 'running', summary: '', requestId: 'r' } as const;
  assert.equal(view.event({ ...base, input: { instructions: '', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'auto' }, untrustedInput: true, overlap: 'skip', handler: 'coordinator', rules: [] },
    dispatch: { workflowId: '10000000-0000-4000-8000-000000000001', sessionId: 'codex:coordinator', createdSessionId: 'codex:coordinator', runId: 'r1' } }), false);
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
  // Kept from sharing while the run is being admitted.
  f.admitting.before = () => { f.admitting.before = undefined; f.excluded.add(f.open); };
  const late = (await f.call<{ event: TriggerEvent }>('triggers.run', { id: folder.id }, owner)).event;
  const refusedLate = await until(() => { const event = f.triggers.event(late.id); return event.status === 'error' ? event : undefined; });
  assert.equal(refusedLate.error, REMOTE_FOLDER_REFUSED);
  assert.equal(f.started.filter(item => item.how === 'folder').length, 0);
});

test('where a folder really is, and the sharing list, are looked at again for every answer and as a run starts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-remote-sharing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = join(root, 'open'), secret = join(root, 'secret'), link = join(root, 'link');
  await Promise.all([mkdir(open), mkdir(secret), mkdir(join(root, 'state'))]);
  await symlink(open, link);
  const store = new RemoteExclusionStore(join(root, 'state'));
  await store.start();
  await store.add(secret);
  const triggers = new TriggerService({ stateDir: root, tickMs: 60_000, executor: { submitAutoPrompt: async () => { throw new Error('unused'); }, getAutoPrompt: () => undefined,
    create: async () => { throw new Error('unused'); }, enqueue: async () => { throw new Error('unused'); }, runs: () => [], session: () => undefined } });
  await triggers.start();
  t.after(() => triggers.close());
  const api = new TowerApi({ stateDir: root, triggers, sessions: { list: () => [], read: async () => [] },
    remote: async paths => { await store.reload(); await store.prepare(paths, { fresh: true }); return { matcher: store.matcher(), coordinators: new Set() }; } });
  await api.call('triggers.create', { trigger: trigger({ mode: 'folder', cwd: link }, 'Through a link') }, owner);
  const names = async () => ((await api.call('triggers.list', {}, remote)) as { triggers: Array<{ name: string }> }).triggers.map(item => item.name);
  assert.deepEqual(await names(), ['Through a link']);
  await rm(link);
  await symlink(secret, link);
  assert.deepEqual(await names(), [], 'the link now leads into the private folder');

  // A run waiting to start: its folder's last look grows old, and the list changes in another process.
  const session: Session = { id: 'codex:s', nativeId: 's', provider: 'codex', title: '', cwd: open, project: 'p', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
  const run: Run = { id: 'r', sessionId: session.id, prompt: '', status: 'queued', createdAt: '', output: '', origin: { kind: 'trigger', triggerId: 't', eventId: 'e', controllerId: CONTROLLER } };
  const worker = new RemoteExclusionStore(join(root, 'state'), { recheckMs: 10 });
  await worker.start();
  const launch = remoteTriggerLaunch(worker, { list: () => [run], getSession: () => session });
  await launch.prepareRun(run);
  assert.equal(launch.refused(run), false);
  await new Promise(resolve => setTimeout(resolve, 100));
  await launch.prepareRun(run);
  assert.equal(launch.refused(run), false, 'a shared folder is looked at again, not taken as private because its last look is old');
  await store.add(open);
  await launch.prepareRun(run);
  assert.equal(launch.refused(run), true, 'the list as saved now');
  await store.remove(open);
  await launch.prepareRun(run);
  assert.equal(launch.refused(run), false, 'looked at again for the one run about to start');
  assert.equal(launch.refused({ ...run, origin: { kind: 'trigger', triggerId: 't', eventId: 'e' } }), false, 'only work set up from another computer');
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
