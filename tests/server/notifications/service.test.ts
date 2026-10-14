import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceId, notificationMessage, NotificationService, pendingEvents, secretBlockMessage, withFollowing, type NotificationContext } from '../../../server/notifications/service.js';
import type { SecretBlockNotice } from '../../../server/runs/runner-protocol.js';
import type { Run, Session, Snapshot } from '../../../shared/types.js';

const at = (minutes: number) => new Date(Date.parse('2026-09-26T00:00:00Z') + minutes * 60_000).toISOString();
const run = (id: string, fields: Partial<Run>): Run => ({ id, sessionId: 's1', prompt: 'Fix the login bug', status: 'running', createdAt: at(0), output: '', ...fields });
const session: Session = { id: 's1', nativeId: 'n1', provider: 'claude', title: 'Login bug', cwd: '/work/app', project: 'app', status: 'idle', statusReason: '',
  createdAt: at(0), updatedAt: at(0), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
const subscription = () => {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint: `https://push.example/${randomBytes(4).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};

test('owner turns that end and each trigger event as it starts are announced once; other work is not', () => {
  const runs = [
    run('done', { origin: { kind: 'owner' }, status: 'completed', finishedAt: at(5), output: 'Fixed.' }),
    run('failed', { origin: { kind: 'owner' }, status: 'error', finishedAt: at(6), error: 'boom' }),
    run('stopped', { origin: { kind: 'owner' }, status: 'cancelled', finishedAt: at(6) }),
    run('working', { origin: { kind: 'owner' }, status: 'running', startedAt: at(4) }),
    run('agent', { origin: { kind: 'agent' }, status: 'completed', finishedAt: at(6) }),
    run('slack', { origin: { kind: 'slack', workflowId: '00000000-0000-4000-8000-000000000000' }, status: 'completed', finishedAt: at(6) }),
    run('legacy', { status: 'completed', finishedAt: at(6) }),
    run('old', { origin: { kind: 'owner' }, status: 'completed', finishedAt: at(-5) }),
    run('trigger-1', { origin: { kind: 'trigger', triggerId: 't1', eventId: 'e1' }, status: 'running', startedAt: at(3) }),
    run('trigger-1b', { origin: { kind: 'trigger', triggerId: 't1', eventId: 'e1' }, status: 'completed', startedAt: at(7), finishedAt: at(8) }),
    run('trigger-queued', { origin: { kind: 'trigger', triggerId: 't1', eventId: 'e2' }, status: 'queued' }),
  ];
  assert.deepEqual(pendingEvents(runs, Date.parse(at(0)), new Set()).map(event => event.key), ['trigger:t1:e1', 'done:done', 'done:failed']);
  assert.deepEqual(pendingEvents(runs, Date.parse(at(0)), new Set(['done:done', 'trigger:t1:e1'])).map(event => event.key), ['done:failed']);
});

test('messages name the project, conversation and outcome in the device language and open the conversation', () => {
  const context: NotificationContext = { runs: () => [], session: () => ({ ...session, customTitle: '로그인 수정' }), project: () => 'App', trigger: () => 'Nightly' };
  const [done, failed, started] = pendingEvents([
    run('a', { origin: { kind: 'owner' }, status: 'completed', finishedAt: at(1), output: '## Fixed\n\nThe **login** works.' }),
    run('b', { origin: { kind: 'owner' }, status: 'error', finishedAt: at(2), error: 'Provider exited' }),
    run('c', { origin: { kind: 'trigger', triggerId: 't', eventId: 'e' }, status: 'running', startedAt: at(3) }),
  ], 0, new Set());
  assert.deepEqual(notificationMessage(done, context, 'ko'), { title: 'App · 작업 완료', body: '로그인 수정\nFixed The login works.', url: '/?session=s1', tag: 'session:s1' });
  assert.equal(notificationMessage(failed, context, 'en').title, 'App · Task failed');
  assert.match(notificationMessage(failed, context, 'en').body, /Provider exited/);
  assert.deepEqual(notificationMessage(started, context, 'en'), { title: 'Trigger started · Nightly', body: 'App — Fix the login bug', url: '/?session=s1', tag: 'trigger:t:e' });
});

test('devices subscribe, choose events, receive what they chose, and are forgotten when their push service says so', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-notifications-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let runs: Run[] = [run('before', { origin: { kind: 'owner' }, status: 'completed', finishedAt: new Date(Date.now() - 1000).toISOString() })];
  const sent: string[] = [];
  let status = 201;
  const fetcher = (async (url: string | URL | Request) => { sent.push(String(url)); return new Response(null, { status }); }) as typeof fetch;
  const context: NotificationContext = { runs: () => runs, session: () => session, project: () => 'app', trigger: () => 'Nightly' };
  const service = new NotificationService(dir, context, fetcher);
  await service.start();
  assert.equal((await stat(join(dir, 'notifications.json'))).mode & 0o777, 0o600);
  const phone = subscription(), laptop = subscription();
  await assert.rejects(service.subscribe({ subscription: { ...phone, endpoint: 'http://push.example/x' } }), /올바르지 않습니다/);
  await assert.rejects(service.subscribe({ subscription: phone, events: { runCompleted: 'yes' } }), /알림 종류/);
  await service.subscribe({ subscription: phone, label: 'iPhone · Safari', language: 'ko' });
  const overview = await service.subscribe({ subscription: laptop, label: 'Mac · Chrome', language: 'en', events: { triggerStarted: false } });
  assert.deepEqual(overview.devices.map(device => [device.id, device.events]), [
    [deviceId(phone.endpoint), { runCompleted: true, triggerStarted: true, runWaiting: true }], [deviceId(laptop.endpoint), { runCompleted: true, triggerStarted: false, runWaiting: true }]]);
  assert.ok(!JSON.stringify(overview).includes(phone.endpoint), 'endpoints and keys stay on the server');
  // Work that ended before the service started is not announced.
  service.check();
  assert.deepEqual(sent, []);
  runs = [...runs, run('trigger', { origin: { kind: 'trigger', triggerId: 't', eventId: 'e' }, status: 'running', startedAt: new Date().toISOString() })];
  service.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, [phone.endpoint]);
  status = 410;
  runs = [...runs, run('done', { origin: { kind: 'owner' }, status: 'completed', finishedAt: new Date().toISOString() })];
  service.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent.slice(1).sort(), [phone.endpoint, laptop.endpoint].sort());
  assert.deepEqual(service.overview().devices, []);
  await service.close();
  const saved = JSON.parse(await readFile(join(dir, 'notifications.json'), 'utf8'));
  assert.deepEqual(saved.delivered.keys.sort(), ['done:done', 'trigger:t:e']);
});

test('after a restart, work that ended while the web server was down is announced, and nothing is announced twice', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-notifications-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.parse(at(0));
  const sent: string[] = [];
  const fetcher = (async (url: string | URL | Request) => { sent.push(String(url)); return new Response(null, { status: 201 }); }) as typeof fetch;
  let runs: Run[] = [];
  const context: NotificationContext = { runs: () => runs, session: () => session, project: () => 'app', trigger: () => undefined };
  const first = new NotificationService(dir, context, fetcher, () => now);
  await first.start();
  await first.subscribe({ subscription: subscription() });
  now = Date.parse(at(1));
  runs = [run('seen', { origin: { kind: 'owner' }, status: 'completed', finishedAt: at(1) })];
  first.check();
  await first.close();
  assert.equal(sent.length, 1);
  // Down for ten minutes: one turn ends meanwhile.
  runs = [...runs, run('missed', { origin: { kind: 'owner' }, status: 'completed', finishedAt: at(5) })];
  now = Date.parse(at(11));
  const second = new NotificationService(dir, context, fetcher, () => now);
  await second.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 2);
  second.check();
  await second.close();
  assert.equal(sent.length, 2);
  // Much later, only an hour of missed work is caught up.
  runs = [...runs, run('stale', { origin: { kind: 'owner' }, status: 'completed', finishedAt: at(20) })];
  now = Date.parse(at(200));
  const third = new NotificationService(dir, context, fetcher, () => now);
  await third.start();
  await third.close();
  assert.equal(sent.length, 2);
});

test('the master\'s turns ending are not announced (its chat and voice give them), while work it asks the owner about is', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-notifications-'));
  const sent: string[] = [];
  const fetcher = (async (url: string | URL | Request) => { sent.push(String(url)); return new Response(null, { status: 201 }); }) as typeof fetch;
  let runs: Run[] = [];
  const master: Session = { ...session, id: 'm1', cwd: '/state/master-session', master: true };
  const context: NotificationContext = { runs: () => runs, session: id => id === 'm1' ? master : session, project: () => 'app', trigger: () => undefined };
  const service = new NotificationService(dir, context, fetcher);
  await service.start();
  // Hooks run in order: the service's last write lands before its folder goes.
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  await service.subscribe({ subscription: subscription() });
  runs = [run('answer', { sessionId: 'm1', origin: { kind: 'owner' }, status: 'completed', finishedAt: new Date(Date.now() + 1000).toISOString() })];
  service.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, []);
  runs = [...runs, run('other', { origin: { kind: 'owner' }, status: 'completed', finishedAt: new Date(Date.now() + 1000).toISOString() })];
  service.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1, 'a handed-out or ordinary conversation still is');
});

test('a secret use the reviewer refused is announced once, to devices that hear what waits on the owner, with the reason and the conversation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-notifications-'));
  const sent: { endpoint: string }[] = [];
  const fetcher = (async (url: string | URL | Request) => { sent.push({ endpoint: String(url) }); return new Response(null, { status: 201 }); }) as typeof fetch;
  let blocks: SecretBlockNotice[] = [];
  const context: NotificationContext = { runs: () => [], session: () => ({ ...session, customTitle: '배포' }), project: () => 'App', trigger: () => undefined, secretBlocks: () => blocks };
  let service = new NotificationService(dir, context, fetcher);
  await service.start();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const phone = subscription(), quiet = subscription();
  await service.subscribe({ subscription: phone, language: 'ko' });
  await service.subscribe({ subscription: quiet, events: { runWaiting: false } });
  const block: SecretBlockNotice = { key: 'secret-block:op-1:5', sessionId: 's1', at: Date.now() + 1000, reason: '토큰을 외부로 보냅니다. (근거: "paste.example")', secrets: ['deploy token'] };
  assert.deepEqual(secretBlockMessage(block, context, 'ko'), { title: 'App · 시크릿 사용 차단', body: '배포\n토큰을 외부로 보냅니다. (근거: "paste.example")\n시크릿: deploy token', url: '/?session=s1', tag: 'secret-block:op-1:5' });
  assert.equal(secretBlockMessage(block, context, 'en').title, 'App · Secret use blocked');
  // Older than the service's start: not announced.
  blocks = [{ ...block, key: 'secret-block:old:1', at: Date.now() - 2 * 60 * 60_000 }];
  service.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, []);
  blocks = [...blocks, block];
  service.check(); service.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  service.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, [{ endpoint: phone.endpoint }], 'once, and only to devices that want what waits on the owner');
  // A restart does not announce it again.
  await service.close();
  service = new NotificationService(dir, context, fetcher);
  await service.start();
  service.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
});

const HOST = 'a'.repeat(32), NODE = 'b'.repeat(32), OTHER = 'c'.repeat(32);
const mirrored = (runs: Run[]): Snapshot => ({ sessions: [{ ...session, id: 'n1', cwd: '/home/me/Workspace/app' }], runs, providers: [], groups: [{ cwd: '/home/me/Workspace/app', title: 'App', pinned: false }],
  repositories: [], autoPrompts: [], hostname: 'office', updatedAt: at(0) } as unknown as Snapshot);
async function pushes(t: test.TestContext, context: NotificationContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-notifications-follow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const service = new NotificationService(dir, context, (async (url: string | URL | Request) => { sent.push(String(url)); return new Response(null, { status: 201 }); }) as typeof fetch);
  await service.start();
  await service.subscribe({ subscription: subscription(), label: 'Phone', language: 'ko' });
  t.after(() => service.close());
  const settle = async () => { service.check(); await new Promise(resolve => setTimeout(resolve, 30)); service.check(); await new Promise(resolve => setTimeout(resolve, 30)); };
  return { sent, settle };
}

test('the host announces the work it sent to a computer that follows it, once, and opens it in its own page', async t => {
  const now = () => new Date().toISOString();
  let nodeRuns: Run[] = [];
  const context: NotificationContext = { runs: () => [], session: () => undefined, project: () => '', trigger: () => undefined,
    following: () => ({ self: HOST, computers: [{ id: NODE, name: 'office-tower-1', snapshot: mirrored(nodeRuns) }] }) };
  const { sent, settle } = await pushes(t, context);
  nodeRuns = [
    run('sent', { sessionId: 'n1', origin: { kind: 'owner', controllerId: HOST }, status: 'completed', finishedAt: now(), output: 'Done.' }),
    run('local', { sessionId: 'n1', origin: { kind: 'owner' }, status: 'completed', finishedAt: now() }),
    run('other', { sessionId: 'n1', origin: { kind: 'owner', controllerId: OTHER }, status: 'completed', finishedAt: now() }),
  ];
  await settle();
  assert.equal(sent.length, 1, 'only the work this Tower sent, and only once');
  await settle();
  assert.equal(sent.length, 1);
  nodeRuns = [...nodeRuns, run('waiting', { sessionId: 'n1', origin: { kind: 'owner', controllerId: HOST }, status: 'running', approvals: [{ id: 'p1', toolName: 'Bash', description: 'gh pr merge' }] as Run['approvals'] })];
  await settle();
  assert.equal(sent.length, 2, 'an approval it waits on too');

  const view = withFollowing(context);
  const [event] = pendingEvents(view.runs(), 0, new Set()).filter(item => item.run.id === `@${NODE}/sent`);
  const message = notificationMessage(event!, view, 'ko');
  assert.equal(message.url, `/?session=${encodeURIComponent(`@${NODE}/n1`)}`);
  assert.equal(message.title, 'App (office-tower-1) · 작업 완료');
});

test('a computer that follows a host leaves the host\'s work to it and still announces its own', async t => {
  const now = () => new Date().toISOString();
  let runs: Run[] = [];
  let host: string | undefined = HOST;
  const { sent, settle } = await pushes(t, { runs: () => runs, session: () => session, project: () => 'app', trigger: () => undefined, followedHost: () => host });
  runs = [run('from-host', { origin: { kind: 'owner', controllerId: HOST }, status: 'completed', finishedAt: now() })];
  await settle();
  assert.equal(sent.length, 0);
  runs = [...runs, run('mine', { origin: { kind: 'owner' }, status: 'completed', finishedAt: now() }),
    run('from-other', { origin: { kind: 'owner', controllerId: OTHER }, status: 'completed', finishedAt: now() })];
  await settle();
  assert.equal(sent.length, 2, 'its own owner\'s and another controller\'s work, as before');
  // Decided for good: following nobody later does not announce it after all.
  host = undefined;
  await settle();
  assert.equal(sent.length, 2);
});

test('a trigger this Tower set up on a following computer is announced starting here, once, and not there', async t => {
  const now = () => new Date().toISOString();
  let nodeRuns: Run[] = [];
  const host = await pushes(t, { runs: () => [], session: () => undefined, project: () => '', trigger: () => undefined,
    following: () => ({ self: HOST, computers: [{ id: NODE, name: 'office-tower-1', snapshot: mirrored(nodeRuns) }] }) });
  // As the node mirrors it to the host that set the trigger up: its ids included (remoteRun).
  const started = run('t-run', { sessionId: 'n1', origin: { kind: 'trigger', triggerId: 'nightly', eventId: 'e1', controllerId: HOST }, status: 'running', startedAt: now() });
  nodeRuns = [started];
  await host.settle();
  await host.settle();
  assert.equal(host.sent.length, 1);
  const view = withFollowing({ runs: () => [], session: () => undefined, project: () => '', trigger: () => undefined,
    following: () => ({ self: HOST, computers: [{ id: NODE, name: 'office-tower-1', snapshot: mirrored(nodeRuns) }] }) });
  assert.deepEqual(pendingEvents(view.runs(), 0, new Set()).map(event => event.key), [`trigger:@${NODE}/nightly:@${NODE}/e1`], 'named by that computer\'s ids');
  const node = await pushes(t, { runs: () => [started], session: () => session, project: () => 'app', trigger: () => 'Nightly', followedHost: () => HOST });
  await node.settle();
  assert.equal(node.sent.length, 0);
});
