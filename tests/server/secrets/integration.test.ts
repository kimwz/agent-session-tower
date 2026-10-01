import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { SecretService } from '../../../server/secrets/service.js';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import { MAX_SECRET_BYTES, type SecretContext, type SecretMetadata, type SecretOverview, type SecretRunResult } from '../../../shared/secrets.js';
import type { Run, Session, Snapshot } from '../../../shared/types.js';
import type { SessionOrigin } from '../../../server/runs/origin.js';
import type { Capability } from '../../../server/api/mcp.js';
import { createMonitorServer, type Backend } from '../../../server/http/server.js';
import { createRemoteRouter } from '../../../server/remote/router.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
const VISIBLE = 'VISIBLE_INTEGRATION_CANARY_732';
const HIDDEN = 'HIDDEN_INTEGRATION_CANARY_928';
const PASSWORD = 'fixture-integration-vault-password';
class FixtureRuns {
  readonly sessions = new Map<string, Session>(); readonly running: Run[] = [];
  add(root: string): Extract<Capability, { kind: 'secret-run' }> {
    const sessionId = `codex:${randomUUID()}`; const runId = randomUUID(); const at = new Date().toISOString();
    this.sessions.set(sessionId, { id: sessionId, nativeId: sessionId.slice(6), provider: 'codex', title: 'fixture', cwd: root, project: 'fixture', status: 'working', statusReason: '', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 0, isSubagent: false, resumable: true });
    this.running.push({ id: runId, sessionId, prompt: 'fixture owner task', status: 'running', createdAt: at, startedAt: at, output: '', origin: { kind: 'owner' }, towerTools: 'attached' });
    return { kind: 'secret-run', runId, sessionId };
  }
  list() { return this.running; } getSession(id: string) { return this.sessions.get(id); }
  sessionOrigin(_id: string): SessionOrigin { return { kind: 'owner', untrustedInput: false }; }
}
async function storedText(directory: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) text += entry.isDirectory() ? await storedText(join(directory, entry.name)) : await readFile(join(directory, entry.name), 'utf8');
  return text;
}
async function pair(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-integration-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const stateA = join(root, 'state-a'), stateB = join(root, 'state-b'), projectA = join(root, 'project-a'), projectB = join(root, 'project-b'); await Promise.all([stateA, stateB, projectA, projectB].map(path => mkdir(path)));
  let now = Date.now(); const a = new SecretService({ stateDir: stateA, now: () => now }), b = new SecretService({ stateDir: stateB }); await a.start(); await b.start(); await a.initialize(PASSWORD); await b.initialize(PASSWORD);
  const runsA = new FixtureRuns(), runsB = new FixtureRuns(); const capB = runsB.add(projectB);
  const source = new SecretRuntime({ stateDir: stateA, service: a, runs: runsA }); const recipient = new SecretRuntime({ stateDir: stateB, service: b, runs: runsB }); t.after(() => { source.close(); recipient.close(); });
  await source.control('trust', { device: b.device(), direction: 'node', routeId: 'node-b' }); await recipient.control('trust', { device: a.device(), direction: 'controller', routeId: 'controller-a' });
  const logical = await a.project({ name: 'shared logical project', bindings: [{ hostId: a.device().id, root: projectA }, { hostId: b.device().id, root: projectB }] }); const local = await b.project({ name: 'B local project', bindings: [{ hostId: b.device().id, root: projectB }] }); assert.notEqual(logical.id, local.id);
  const wires: unknown[] = []; const errors: unknown[] = [];
  async function relay<T>(pending: Promise<T>, offline = false): Promise<T> {
    let done = false; const observed = pending.then(value => { done = true; return value; }, error => { done = true; throw error; }); observed.catch(() => undefined);
    for (let count = 0; !done && count < 300; count++) {
      for (const request of recipient.remote.poll('controller-a')) {
        wires.push(request);
        if (offline) { recipient.remote.close(); break; }
        try { const response = await source.remote.answer('node-b', request); wires.push(response); recipient.remote.deliver('controller-a', response); }
        catch (error) { errors.push(error); recipient.remote.close(); }
      }
      if (!done) await new Promise(resolve => setTimeout(resolve, 5));
    }
    if (!done) { recipient.remote.close(); throw new Error('Fixture relay did not settle within its bounded poll window'); }
    return observed;
  }
  return { root, stateA, stateB, projectA, projectB, a, b, source, recipient, runsB, capB, logical, local, wires, errors, relay, advance: (ms: number) => { now += ms; } };
}
test('two encrypted runtimes relay source-authoritative selected fields, manual grants and signed task closure', { timeout: 20000 }, async t => {
  const f = await pair(t);
  const bundle = await f.a.create({ name: 'source env bundle', kind: 'env', scope: 'project', projectId: f.logical.id, value: `VISIBLE=${VISIBLE}\nHIDDEN=${HIDDEN}` });
  await f.source.control('rule', { groupId: bundle.groupId, secretIds: [bundle.id], hostId: f.b.device().id, projectId: f.logical.id, activation: 'auto', operations: ['discover', 'env'], fields: { [bundle.id]: ['VISIBLE'] }, enabled: true });
  const listed = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[]; unavailableSources: unknown[] }; assert.deepEqual(listed.unavailableSources, []); assert.equal(listed.secrets.length, 1); assert.deepEqual(listed.secrets[0].fields, ['VISIBLE']); assert.equal(JSON.stringify(listed).includes(VISIBLE), false); assert.equal(JSON.stringify(listed).includes(HIDDEN), false);
  const context = await f.recipient.context(f.capB); assert.equal(context.projectId, f.local.id); const sourceContext = await f.a.ensureRemoteTask(context); assert.equal(sourceContext.projectId, f.logical.id); assert.equal(f.a.overview(sourceContext).task?.expiresAt! - f.a.overview(sourceContext).task?.createdAt!, 8 * 60 * 60_000);
  const result = await f.relay(f.recipient.tool(f.capB, 'secrets_run', { operationId: 'env-bundle-1', command: process.execPath, args: ['-e', "console.log(process.env.VISIBLE ? 'visible-present' : 'visible-missing'); console.log(process.env.HIDDEN === undefined ? 'hidden-absent' : 'hidden-leaked'); console.log(process.env.VISIBLE)"], envBundle: bundle.reference })) as SecretRunResult;
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /visible-present\nhidden-absent\n\[REDACTED\]/); assert.equal(JSON.stringify(result).includes(VISIBLE), false);
  const deniedField = await f.relay(f.recipient.tool(f.capB, 'secrets_run', { operationId: 'forbidden-field', command: process.execPath, args: ['-e', "console.log('must-not-run')"], env: { HIDDEN: `${bundle.reference}#HIDDEN` } })) as SecretRunResult; assert.equal(deniedField.exitCode, null); assert.equal(deniedField.stdout, '');
  const manual = await f.a.create({ name: 'manual scalar', kind: 'scalar', scope: 'project', projectId: f.logical.id, value: VISIBLE });
  await f.a.setRule({ groupId: manual.groupId, secretIds: [manual.id], hostId: f.b.device().id, projectId: f.logical.id, activation: 'manual', operations: ['discover', 'env'], enabled: true, maxTtlMs: 60000 });
  const beforeAttach = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[] }; assert.equal(beforeAttach.secrets.some(secret => secret.id === manual.id), false);
  await f.a.attach(sourceContext, [manual.id]); const afterAttach = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[] }; assert.equal(afterAttach.secrets.some(secret => secret.id === manual.id), true);
  await f.a.revoke(sourceContext, [bundle.id]); const revoked = await f.relay(f.recipient.tool(f.capB, 'secrets_run', { operationId: 'revoked-use', command: process.execPath, args: ['-e', "console.log('must-not-run')"], envBundle: bundle.reference })) as SecretRunResult; assert.equal(revoked.exitCode, null); assert.equal(revoked.stdout, '');
  await f.relay(f.recipient.endSession(f.capB.sessionId)); assert.equal(f.a.overview(sourceContext).task?.status, 'closed'); assert.equal(f.b.overview(context).task?.status, 'closed'); await assert.rejects(f.recipient.tool(f.capB, 'secrets_list', {})); assert.equal(f.runsB.list()[0].status, 'running');
  assert.deepEqual(f.errors, []); assert.equal(JSON.stringify(f.wires).includes(VISIBLE), false); assert.equal(JSON.stringify(f.wires).includes(HIDDEN), false); assert.equal(f.b.overview().secrets.length, 0); assert.equal(f.runsB.list()[0].output, '');
  const disk = await storedText(f.stateA) + await storedText(f.stateB); assert.equal(disk.includes(VISIBLE), false); assert.equal(disk.includes(HIDDEN), false); assert.equal(disk.includes(PASSWORD), false);
});
test('source lock, offline relay and task expiry fail closed while owner run remains active', { timeout: 15000 }, async t => {
  const f = await pair(t); const secret = await f.a.create({ name: 'remote scalar', kind: 'scalar', scope: 'project', projectId: f.logical.id, value: VISIBLE }); await f.a.setRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: f.b.device().id, projectId: f.logical.id, activation: 'auto', operations: ['discover', 'env'], enabled: true, maxTtlMs: 60000 });
  await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})); const fixedTask = (await f.recipient.context(f.capB)).taskId; await f.a.lock(); const locked = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[]; unavailableSources: unknown[] }; assert.deepEqual(locked.secrets, []); assert.equal(locked.unavailableSources.length, 1);
  await f.a.unlock(PASSWORD); const offline = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {}), true) as { secrets: SecretMetadata[]; unavailableSources: unknown[] }; assert.deepEqual(offline.secrets, []); assert.equal(offline.unavailableSources.length, 1);
  f.advance(8 * 60 * 60_000 + 1); const expired = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[]; unavailableSources: unknown[] }; assert.deepEqual(expired.secrets, []); assert.equal(expired.unavailableSources.length, 1); assert.equal(f.runsB.list()[0].status, 'running'); assert.equal(f.b.overview().secrets.length, 0); assert.equal((await f.recipient.context(f.capB)).taskId, fixedTask);
});
test('recipient task revocation filters remote owner overview and lists and blocks use without revoking source grants', { timeout: 20000 }, async t => {
  const f = await pair(t);
  const secret = await f.a.create({ name: 'B can revoke this remote key', kind: 'scalar', scope: 'project', projectId: f.logical.id, value: VISIBLE });
  await f.a.setRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: f.b.device().id, projectId: f.logical.id, activation: 'auto', operations: ['discover', 'env'], enabled: true });
  const context = await f.recipient.context(f.capB);
  const overview = await f.relay(f.recipient.overview(context));
  assert.equal(overview.secrets.some(item => item.id === secret.id && item.sourceHostId === f.a.device().id), true);
  assert.equal(overview.connected.includes(secret.id), true); assert.equal(overview.groups.some(group => group.id === secret.groupId), true);
  assert.equal(JSON.stringify(overview).includes(VISIBLE), false);
  const revoked = await f.relay(f.recipient.control('revoke', { sessionId: f.capB.sessionId, secretIds: [secret.id] })) as SecretOverview;
  assert.equal(revoked.secrets.some(item => item.id === secret.id), false); assert.equal(revoked.connected.includes(secret.id), false);
  const listed = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[]; unavailableSources: unknown[] };
  assert.deepEqual(listed.secrets, []); assert.deepEqual(listed.unavailableSources, []);
  const before = f.wires.length;
  const denied = await f.relay(f.recipient.tool(f.capB, 'secrets_run', { operationId: 'B-revoked-before-use', command: process.execPath, args: ['-e', "console.log('must-not-run')"], env: { TOKEN: secret.reference } })) as SecretRunResult;
  assert.equal(denied.exitCode, null); assert.equal(denied.stdout, ''); assert.equal(f.wires.length, before);
  const sourceContext = await f.a.ensureRemoteTask(context); assert.equal((await f.a.resolve(sourceContext, secret.reference, 'env')).bytes.toString(), VISIBLE);
  await f.b.closeTask(context.taskId);
  await assert.rejects(f.recipient.broker.list(context));
  await assert.rejects(f.recipient.broker.run(context, { operationId: 'B-closed-before-use', command: process.execPath, env: { TOKEN: secret.reference } }));
  assert.equal(f.runsB.list()[0].status, 'running'); assert.equal(f.b.overview().secrets.length, 0); assert.deepEqual(f.errors, []);
});

test('recipient task closure or revocation while a sealed response is in flight denies remote consumption', { timeout: 20000 }, async t => {
  const f = await pair(t);
  const secret = await f.a.create({ name: 'inflight remote key', kind: 'scalar', scope: 'project', projectId: f.logical.id, value: VISIBLE });
  await f.a.setRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: f.b.device().id, projectId: f.logical.id, activation: 'auto', operations: ['discover', 'env', 'compare'], enabled: true });
  for (const mode of ['revoke', 'close'] as const) {
    const cap = f.runsB.add(f.projectB), context = await f.recipient.context(cap);
    const pending = f.recipient.broker.compare(context, secret.reference, secret.reference);
    const denied = assert.rejects(pending);
    let request;
    for (let count = 0; !request && count < 100; count++) { request = f.recipient.remote.poll('controller-a')[0]; if (!request) await new Promise(resolve => setTimeout(resolve, 1)); }
    assert.ok(request);
    const response = await f.source.remote.answer('node-b', request);
    if (mode === 'revoke') await f.b.revoke(context, [secret.id]); else await f.b.closeTask(context.taskId);
    f.recipient.remote.deliver('controller-a', response); await denied;
    assert.equal(f.recipient.remote.pending(), 0); assert.equal(f.runsB.list().find(run => run.id === cap.runId)?.status, 'running');
  }
});

test('two encrypted vaults deliver an exact 1MiB remote file through a bounded sealed envelope', { timeout: 30000 }, async t => {
  const f = await pair(t), payload = Buffer.alloc(MAX_SECRET_BYTES, 0xa5);
  const secret = await f.a.create({ name: 'maximum fixture file', kind: 'file', scope: 'project', projectId: f.logical.id, content: payload.toString('base64') });
  await assert.rejects(f.a.create({ name: 'oversized fixture file', kind: 'file', scope: 'project', projectId: f.logical.id, content: Buffer.alloc(MAX_SECRET_BYTES + 1).toString('base64') }));
  await f.a.setRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: f.b.device().id, projectId: f.logical.id, activation: 'auto', operations: ['discover', 'file'], enabled: true });
  const result = await f.relay(f.recipient.tool(f.capB, 'secrets_run', { operationId: 'maximum-remote-file', command: process.execPath,
    args: ['-e', "const v=require('fs').readFileSync(process.argv[1]);console.log(v.length+':'+require('crypto').createHash('sha256').update(v).digest('hex'));", '{secret-file:MAXIMUM}'], files: { MAXIMUM: secret.reference } })) as SecretRunResult;
  assert.equal(result.exitCode, 0); assert.equal(result.stdout.trim(), `${MAX_SECRET_BYTES}:${createHash('sha256').update(payload).digest('hex')}`);
  const { REMOTE_SECRET_MAX_RESPONSE_BYTES } = await import('../../../server/secrets/remote.js');
  const responses = f.wires.filter(wire => typeof wire === 'object' && wire !== null && 'ciphertext' in wire);
  assert.equal(responses.length, 2);
  for (const response of responses) assert.ok(Buffer.byteLength(JSON.stringify(response)) <= REMOTE_SECRET_MAX_RESPONSE_BYTES);
  assert.equal(JSON.stringify(f.wires).includes(payload.toString('base64')), false); assert.equal(f.b.overview().secrets.length, 0);
  assert.deepEqual(await readdir(join(f.stateB, 'secrets', 'consumers')), []); assert.deepEqual(f.errors, []);
});

const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: '' };
test('owner HTTP secret API requires sign-in and page token; generic remote router exposes no secret management', { timeout: 15000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-secret-http-integration-')); t.after(() => rm(stateDir, { recursive: true, force: true })); const service = new SecretService({ stateDir }); await service.start(); const runtime = new SecretRuntime({ stateDir, service, runs: new FixtureRuns() }); t.after(() => runtime.close());
  const auth = await createRemoteAuthFixture(stateDir); const masterSecret = 'a'.repeat(64); let secretCalls = 0;
  const backend: Backend = { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('No native provider may run in this fixture'); }, cancel: async () => {}, subscribe: () => () => {}, secrets: async (action, input) => { secretCalls++; return runtime.control(action, input); } };
  const monitor = createMonitorServer({ port: 0, clientDir: stateDir, auth: auth.auth, remote: { origins: auth.origins }, backend, master: { callerSecret: masterSecret, handle: async () => false } });
  t.after(async () => { monitor.dispose(); monitor.server.closeAllConnections(); if (monitor.server.listening) await new Promise<void>(resolve => monitor.server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => { monitor.server.once('error', reject); monitor.server.listen(0, '127.0.0.1', resolve); }); const base = `http://127.0.0.1:${(monitor.server.address() as AddressInfo).port}`;
  const { token } = await (await auth.fetch(`${base}/api/bootstrap`, { headers: { cookie: auth.cookie } })).json() as { token: string };
  const post = (action: string, body: unknown, headers: Record<string, string> = { cookie: auth.cookie, 'X-Agent-Monitor-Token': token }) => auth.fetch(`${base}/api/secrets/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await auth.fetch(`${base}/api/secrets/overview`)).status, 401); assert.equal((await post('initialize', { password: PASSWORD }, { cookie: auth.cookie })).status, 403); assert.equal(secretCalls, 0);
  assert.equal((await post('initialize', { password: PASSWORD })).status, 200); const created = await post('create', { name: 'HTTP key', kind: 'scalar', scope: 'global', value: VISIBLE }); assert.equal(created.status, 200); assert.equal((await created.text()).includes(VISIBLE), false);
  const shown = await auth.fetch(`${base}/api/secrets/overview`, { headers: { cookie: auth.cookie } }); assert.equal(shown.status, 200); assert.equal((await shown.text()).includes(VISIBLE), false);
  assert.equal((await post('unlock', { password: PASSWORD }, { cookie: auth.cookie, 'X-Agent-Monitor-Token': token, 'x-tower-master': masterSecret })).status, 403);
  assert.equal((await fetch(`${base}/api/secrets/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, 'x-tower-agent': 'local' }, body: '{}' })).status, 403);
  const exclusions = new RemoteExclusionStore(stateDir); await exclusions.start(); const remote = createRemoteRouter({ backend, exclusions }); const server = createServer((req, res) => { void remote.handle(req, res, { controllerId: 'fixture-controller-123456789' }); });
  t.after(async () => { remote.dispose(); server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const remoteBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const before = secretCalls;
  assert.equal((await fetch(`${remoteBase}/api/secrets/overview`)).status, 404); assert.equal((await fetch(`${remoteBase}/api/secrets/initialize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).status, 404); assert.equal(secretCalls, before);
  assert.equal((await storedText(stateDir)).includes(VISIBLE), false); assert.equal((await storedText(stateDir)).includes(PASSWORD), false);
});
