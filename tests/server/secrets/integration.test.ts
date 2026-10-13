import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import { MAX_SECRET_BYTES, type SecretContext, type SecretMetadata, type SecretRunResult, type SecretSessionView, type SecretSettingsView } from '../../../shared/secrets.js';
import type { Snapshot } from '../../../shared/types.js';
import { createMonitorServer, type Backend } from '../../../server/http/server.js';
import { createRemoteRouter } from '../../../server/remote/router.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { ownerSecretControl } from '../../../server/link/secret-routes.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';
import { FixtureRuns, editPayload, legacyRecord, legacyRule, secretService, stored, storedTask, vaultTemplate } from '../../helpers/secrets.js';
const VISIBLE = 'VISIBLE_INTEGRATION_CANARY_732';
const HIDDEN = 'HIDDEN_INTEGRATION_CANARY_928';
const PASSWORD = 'fixture-integration-vault-password';
async function storedText(directory: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) text += entry.isDirectory() ? await storedText(join(directory, entry.name)) : await readFile(join(directory, entry.name), 'utf8');
  return text;
}
/** Source A's and recipient B's vaults, initialized once for this file and copied open into each test. */
const vaults = { a: vaultTemplate(PASSWORD), b: vaultTemplate(PASSWORD) };
before(() => Promise.all([vaults.a.ready(), vaults.b.ready()]));
after(() => Promise.all([vaults.a.dispose(), vaults.b.dispose()]));
async function pair(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-integration-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const stateA = join(root, 'state-a'), stateB = join(root, 'state-b'), projectA = join(root, 'project-a'), projectB = join(root, 'project-b'); await Promise.all([stateA, stateB, projectA, projectB].map(path => mkdir(path)));
  let now = Date.now(); const a = await vaults.a.open(stateA, { now: () => now }), b = await vaults.b.open(stateB);
  const runsA = new FixtureRuns(), runsB = new FixtureRuns(); const capB = runsB.add(projectB);
  const source = new SecretRuntime({ stateDir: stateA, service: a, runs: runsA }); const recipient = new SecretRuntime({ stateDir: stateB, service: b, runs: runsB }); t.after(() => { source.close(); recipient.close(); });
  await source.control('trust', { device: b.device(), direction: 'node', routeId: 'node-b' }); await recipient.control('trust', { device: a.device(), direction: 'controller', routeId: 'controller-a' });
  // Projects registered by builds before per-secret sharing, for the rules of keys saved then.
  const logical = { id: randomUUID(), name: 'shared logical project', bindings: [{ hostId: a.device().id, root: projectA }, { hostId: b.device().id, root: projectB }] }, local = { id: randomUUID(), name: 'B local project', bindings: [{ hostId: b.device().id, root: projectB }] };
  await editPayload(a, payload => { payload.projects.push(logical); }); await editPayload(b, payload => { payload.projects.push(local); });
  const wires: unknown[] = []; const errors: unknown[] = [];
  /** A's relay polling B as a build that serves reads does (`features`), answering each request until `pending` settles. */
  async function relay<T>(pending: Promise<T>, offline = false, features: string[] = ['available']): Promise<T> {
    let done = false; const observed = pending.then(value => { done = true; return value; }, error => { done = true; throw error; }); observed.catch(() => undefined);
    for (let count = 0; !done && count < 300; count++) {
      for (const request of recipient.remote.poll('controller-a', features)) {
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
  /** Shared from A to B's project folder: what B's sessions there may use automatically. */
  const toB = { global: false, folders: [{ hostId: b.device().id, root: projectB }] };
  /** A's relay polled B just now as a build that serves reads, as it does every second. */
  const confirm = () => { assert.deepEqual(recipient.remote.poll('controller-a', ['available']), []); };
  return { root, stateA, stateB, projectA, projectB, a, b, source, recipient, runsB, capB, logical, local, toB, wires, errors, relay, confirm, advance: (ms: number) => { now += ms; } };
}
test('two encrypted runtimes relay source-authoritative selected fields, owner connections and signed task closure', { timeout: 20000 }, async t => {
  const f = await pair(t);
  // A key saved before per-secret sharing, in a logical project's group, follows A's rules for B.
  const record = legacyRecord(f.a.device().id, { name: 'source env bundle', groupId: 'logical-group', kind: 'env', value: `VISIBLE=${VISIBLE}\nHIDDEN=${HIDDEN}` }); const bundle = record.metadata;
  await editPayload(f.a, payload => {
    payload.groups.push({ id: 'logical-group', name: 'Logical', scope: 'project', projectId: f.logical.id }); payload.secrets.push(record);
    payload.rules.push(legacyRule({ groupId: bundle.groupId, secretIds: [bundle.id], hostId: f.b.device().id, projectId: f.logical.id, activation: 'auto', operations: ['discover', 'env'], fields: { [bundle.id]: ['VISIBLE'] }, maxTtlMs: 8 * 60 * 60_000 }));
  });
  const listed = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[]; unavailableSources: unknown[] }; assert.deepEqual(listed.unavailableSources, []); assert.equal(listed.secrets.length, 1); assert.deepEqual(listed.secrets[0].fields, ['VISIBLE']); assert.equal(JSON.stringify(listed).includes(VISIBLE), false); assert.equal(JSON.stringify(listed).includes(HIDDEN), false);
  const context = await f.recipient.context(f.capB); assert.equal(context.projectId, f.local.id); const sourceContext = await f.a.ensureRemoteTask(context); assert.equal(sourceContext.projectId, f.logical.id); assert.equal(storedTask(f.a, sourceContext.taskId)!.expiresAt! - storedTask(f.a, sourceContext.taskId)!.createdAt, 8 * 60 * 60_000);
  const result = await f.relay(f.recipient.tool(f.capB, 'secrets_run', { operationId: 'env-bundle-1', command: process.execPath, args: ['-e', "console.log(process.env.VISIBLE ? 'visible-present' : 'visible-missing'); console.log(process.env.HIDDEN === undefined ? 'hidden-absent' : 'hidden-leaked'); console.log(process.env.VISIBLE)"], envBundle: bundle.reference })) as SecretRunResult;
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /visible-present\nhidden-absent\n\[REDACTED\]/); assert.equal(JSON.stringify(result).includes(VISIBLE), false);
  const deniedField = await f.relay(f.recipient.tool(f.capB, 'secrets_run', { operationId: 'forbidden-field', command: process.execPath, args: ['-e', "console.log('must-not-run')"], env: { HIDDEN: `${bundle.reference}#HIDDEN` } })) as SecretRunResult; assert.equal(deniedField.exitCode, null); assert.equal(deniedField.stdout, '');
  const unshared = await f.a.create({ name: 'unshared scalar', kind: 'scalar', value: VISIBLE });
  const beforeConnect = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[] }; assert.equal(beforeConnect.secrets.some(secret => secret.id === unshared.id), false);
  await f.a.connectSession(sourceContext, [unshared.id]); const afterConnect = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[] }; assert.equal(afterConnect.secrets.some(secret => secret.id === unshared.id), true);
  await f.a.disconnectSession(sourceContext, [bundle.id]); const revoked = await f.relay(f.recipient.tool(f.capB, 'secrets_run', { operationId: 'revoked-use', command: process.execPath, args: ['-e', "console.log('must-not-run')"], envBundle: bundle.reference })) as SecretRunResult; assert.equal(revoked.exitCode, null); assert.equal(revoked.stdout, '');
  await f.relay(f.recipient.endSession(f.capB.sessionId)); assert.equal(storedTask(f.a, sourceContext.taskId)?.status, 'closed'); assert.equal(storedTask(f.b, context.taskId)?.status, 'closed'); await assert.rejects(f.recipient.tool(f.capB, 'secrets_list', {})); assert.equal(f.runsB.list()[0].status, 'running');
  assert.deepEqual(f.errors, []); assert.equal(JSON.stringify(f.wires).includes(VISIBLE), false); assert.equal(JSON.stringify(f.wires).includes(HIDDEN), false); assert.equal(stored(f.b).secrets.length, 0); assert.equal(f.runsB.list()[0].output, '');
  const disk = await storedText(f.stateA) + await storedText(f.stateB); assert.equal(disk.includes(VISIBLE), false); assert.equal(disk.includes(HIDDEN), false); assert.equal(disk.includes(PASSWORD), false);
});
test('source lock, offline relay and task expiry fail closed while owner run remains active', { timeout: 15000 }, async t => {
  const f = await pair(t); await f.a.create({ name: 'remote scalar', kind: 'scalar', value: VISIBLE, sharing: f.toB });
  await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})); const fixedTask = (await f.recipient.context(f.capB)).taskId; const carry = f.a.handoff()!; await f.a.lock(); const locked = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[]; unavailableSources: unknown[] }; assert.deepEqual(locked.secrets, []); assert.equal(locked.unavailableSources.length, 1);
  await f.a.adopt(carry); const offline = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {}), true) as { secrets: SecretMetadata[]; unavailableSources: unknown[] }; assert.deepEqual(offline.secrets, []); assert.equal(offline.unavailableSources.length, 1);
  f.advance(8 * 60 * 60_000 + 1); const expired = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[]; unavailableSources: unknown[] }; assert.deepEqual(expired.secrets, []); assert.equal(expired.unavailableSources.length, 1); assert.equal(f.runsB.list()[0].status, 'running'); assert.equal(stored(f.b).secrets.length, 0); assert.equal((await f.recipient.context(f.capB)).taskId, fixedTask);
});
test('recipient session disconnection filters the session view and lists and blocks use without changing the source sharing', { timeout: 20000 }, async t => {
  const f = await pair(t);
  const secret = await f.a.create({ name: 'B can revoke this remote key', kind: 'scalar', value: VISIBLE, sharing: f.toB });
  const context = await f.recipient.context(f.capB); f.confirm();
  const view = await f.relay(f.recipient.control('session', { sessionId: f.capB.sessionId })) as SecretSessionView;
  assert.deepEqual(view.available.map(item => [item.id, item.basis, item.sourceHostId]), [[secret.id, ['remote'], f.a.device().id]]); assert.deepEqual(view.unavailableSources, []);
  assert.equal(JSON.stringify(view).includes(VISIBLE), false);
  const revoked = await f.relay(f.recipient.control('session-disconnect', { sessionId: f.capB.sessionId, secretIds: [secret.id] })) as SecretSessionView;
  assert.equal(revoked.available.some(item => item.id === secret.id), false);
  const listed = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[]; unavailableSources: unknown[] };
  assert.deepEqual(listed.secrets, []); assert.deepEqual(listed.unavailableSources, []);
  const before = f.wires.length;
  const denied = await f.relay(f.recipient.tool(f.capB, 'secrets_run', { operationId: 'B-revoked-before-use', command: process.execPath, args: ['-e', "console.log('must-not-run')"], env: { TOKEN: secret.reference } })) as SecretRunResult;
  assert.equal(denied.exitCode, null); assert.equal(denied.stdout, ''); assert.equal(f.wires.length, before);
  const sourceContext = await f.a.ensureRemoteTask(context); assert.equal((await f.a.resolve(sourceContext, secret.reference, 'env')).bytes.toString(), VISIBLE);
  await f.b.closeTask(context.taskId);
  await assert.rejects(f.recipient.broker.list(context));
  await assert.rejects(f.recipient.broker.run(context, { operationId: 'B-closed-before-use', command: process.execPath, env: { TOKEN: secret.reference } }));
  assert.equal(f.runsB.list()[0].status, 'running'); assert.equal(stored(f.b).secrets.length, 0); assert.deepEqual(f.errors, []);
});

test('a key disconnected in a session of the joined computer is offered there to allow again, and the source still decides its use', { timeout: 20000 }, async t => {
  const f = await pair(t);
  const secret = await f.a.create({ name: 'remote key to allow again', kind: 'scalar', value: VISIBLE, sharing: f.toB });
  const own = await f.b.create({ name: 'B own key', kind: 'scalar', value: VISIBLE, sharing: { global: true, folders: [] } });
  await f.recipient.context(f.capB); f.confirm();
  const session = { sessionId: f.capB.sessionId };
  const stopped = await f.relay(f.recipient.control('session-disconnect', { ...session, secretIds: [secret.id, own.id] })) as SecretSessionView;
  assert.deepEqual(stopped.available, []);
  assert.deepEqual(stopped.disconnected?.map(item => [item.id, item.remote, item.sourceHostId]), [[secret.id, true, f.a.device().id]], 'this vault’s saved key is offered among the connectable ones instead');
  assert.deepEqual(stopped.connectable.map(item => item.id), [own.id]);
  f.confirm(); const allowed = await f.relay(f.recipient.control('session-reallow', { ...session, secretIds: [secret.id, own.id] })) as SecretSessionView;
  assert.deepEqual(allowed.available.map(item => [item.id, item.basis]), [[secret.id, ['remote']]], 'only another source’s key is allowed again; this vault’s own comes back by connecting it');
  assert.deepEqual(allowed.disconnected, []);
  const listed = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[] };
  assert.deepEqual(listed.secrets.map(item => item.id), [secret.id]);
  // Allowing again lifts only this session's stop: once the source stops sharing, the key is neither listed nor offered.
  await f.relay(f.recipient.control('session-disconnect', { ...session, secretIds: [secret.id] }));
  await f.a.setSharing(secret.id, 1, { global: false, folders: [] });
  f.confirm(); const unshared = await f.relay(f.recipient.control('session', session)) as SecretSessionView;
  assert.deepEqual([unshared.available, unshared.disconnected], [[], []]);
  await assert.rejects(f.recipient.control('session-reallow', { ...session, nodeId: 'node-a', secretIds: [secret.id] }), { kind: 'invalid' });
  assert.equal(JSON.stringify([stopped, allowed]).includes(VISIBLE), false); assert.deepEqual(f.errors, []);
});

test('the source sees what the joined computer’s session stopped, and connecting a key there lifts that stop', { timeout: 20000 }, async t => {
  const f = await pair(t);
  const secret = await f.a.create({ name: 'stopped on B', kind: 'scalar', value: VISIBLE, sharing: f.toB });
  const own = await f.b.create({ name: 'B local key', kind: 'scalar', value: VISIBLE, sharing: { global: true, folders: [] } });
  const context = await f.recipient.context(f.capB); f.confirm();
  await f.relay(f.recipient.control('session-disconnect', { sessionId: f.capB.sessionId, secretIds: [secret.id, own.id] }));
  // A controller that does not ask for exclusions gets the subject an older build knows.
  assert.equal('excluded' in (await f.recipient.sessionSubject(f.capB.sessionId) as object), false);
  const subject = await f.recipient.sessionSubject(f.capB.sessionId, true);
  assert.deepEqual((subject as { excluded?: string[] }).excluded, [secret.id, own.id]);
  const remote = { sessionId: f.capB.sessionId, nodeId: 'node-b' };
  const view = await f.source.control('session', remote, subject) as SecretSessionView;
  assert.deepEqual(view.available, [], 'the joined computer refuses what its session stopped');
  assert.deepEqual(view.connectable.map(item => item.id), [secret.id], 'so it is offered for connecting');
  const { excluded: _excluded, ...older } = subject as { excluded?: string[] };
  assert.deepEqual((await f.source.control('session', remote, older) as SecretSessionView).available.map(item => item.id), [secret.id], 'a joined computer that reports none');
  // Connecting it at the source, then the notice the web sends with the keys connected.
  const target = (await f.recipient.remoteTarget(f.capB.sessionId))!;
  assert.deepEqual(await f.source.control('session-connect', { ...remote, secretIds: [secret.id] }, target), { connectedTarget: { hostId: target.hostId, sessionId: target.sessionId, root: target.root, taskId: target.taskId } });
  await f.recipient.reallowFromController(target, [secret.id, own.id]);
  const after = await f.recipient.sessionSubject(f.capB.sessionId, true);
  assert.deepEqual((after as { excluded?: string[] }).excluded, [own.id], 'its own keys stay stopped; only connecting them here brings them back');
  assert.deepEqual((await f.source.control('session', remote, after) as SecretSessionView).available.map(item => [item.id, item.basis]), [[secret.id, ['session', 'folder']]]);
  const used = await f.relay(f.recipient.broker.compare(context, secret.reference, secret.reference));
  assert.ok(used); assert.deepEqual(f.errors, []);
});

test('a source that confirmed reads but does not answer is listed as unavailable, not as waiting for its update', { timeout: 20000 }, async t => {
  const f = await pair(t);
  await f.a.create({ name: 'silent source key', kind: 'scalar', value: VISIBLE, sharing: f.toB });
  f.confirm();
  // Nobody relays the read: it times out.
  const view = await f.recipient.control('session', { sessionId: f.capB.sessionId }) as SecretSessionView;
  assert.deepEqual([view.available, view.unavailableSources, view.updatePendingSources, view.error], [[], [f.a.device().id], [], undefined]);
});

test('a joined computer’s session view lists a source’s keys only once its relay confirmed reads, and starts no task on either computer', { timeout: 20000 }, async t => {
  const f = await pair(t);
  const shared = await f.a.create({ name: 'shared with B', kind: 'scalar', value: VISIBLE, sharing: { global: true, folders: [] } });
  await f.a.create({ name: 'unshared on A', kind: 'scalar', value: VISIBLE });
  const sourceJournal = await readFile(join(f.stateA, 'secrets', 'journal.json')), recipientJournal = await readFile(join(f.stateB, 'secrets', 'journal.json'));
  const before = f.wires.length;
  // No poll from A at all: it is unreachable, as far as B can tell.
  const offline = await f.recipient.control('session', { sessionId: f.capB.sessionId }) as SecretSessionView;
  assert.deepEqual([offline.available, offline.unavailableSources, offline.updatePendingSources, offline.error], [[], [f.a.device().id], [], undefined]);
  assert.equal(f.wires.length, before); assert.equal(f.recipient.remote.pending(), 0, 'nothing was sent to a source that did not confirm reads');
  // A's relay polls without the header: an older source, waiting for its update, never asked and never read with `list` instead.
  assert.deepEqual(f.recipient.remote.poll('controller-a', []), []);
  const older = await f.recipient.control('session', { sessionId: f.capB.sessionId }) as SecretSessionView;
  assert.deepEqual([older.available, older.unavailableSources, older.updatePendingSources], [[], [], [f.a.device().id]]);
  assert.equal(f.wires.length, before); assert.equal(f.recipient.remote.pending(), 0);
  f.confirm(); const view = await f.relay(f.recipient.control('session', { sessionId: f.capB.sessionId })) as SecretSessionView;
  assert.deepEqual(view.available.map(item => [item.name, item.basis, item.sourceHostId, item.operations.length]), [['shared with B', ['remote'], f.a.device().id, 6]]);
  assert.deepEqual([view.unavailableSources, view.updatePendingSources], [[], []]); assert.deepEqual(view.connectable, [], 'only this vault’s own keys are connectable here');
  assert.deepEqual(f.wires.filter(wire => typeof wire === 'object' && wire !== null && 'operation' in wire).map(wire => (wire as { operation: string }).operation), ['available']);
  assert.deepEqual(await readFile(join(f.stateA, 'secrets', 'journal.json')), sourceJournal, 'the source started no task and claimed nothing');
  assert.deepEqual(await readFile(join(f.stateB, 'secrets', 'journal.json')), recipientJournal, 'neither did the joined computer');
  assert.equal(f.b.currentTask(f.capB.sessionId), undefined);
  assert.equal(JSON.stringify(view).includes(VISIBLE), false); assert.ok(shared); assert.deepEqual(f.errors, []);
});

test('after the source revokes the last share, the node lists nothing and still closes its source task', { timeout: 20000 }, async t => {
  const f = await pair(t);
  const secret = await f.a.create({ name: 'revoked share', kind: 'scalar', value: VISIBLE, sharing: f.toB });
  const listed = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[] };
  assert.deepEqual(listed.secrets.map(item => item.id), [secret.id]);
  const context = await f.recipient.context(f.capB);
  await f.a.setSharing(secret.id, 1, { global: false, folders: [] });
  const after = await f.relay(f.recipient.tool(f.capB, 'secrets_list', {})) as { secrets: SecretMetadata[]; unavailableSources: unknown[] };
  assert.deepEqual([after.secrets, after.unavailableSources], [[], []], 'the source still answers for the task it already has');
  await f.relay(f.recipient.endSession(f.capB.sessionId));
  assert.equal(storedTask(f.a, context.taskId)?.status, 'closed'); assert.deepEqual(f.errors, []);
});

test('recipient task closure or revocation while a sealed response is in flight denies remote consumption', { timeout: 20000 }, async t => {
  const f = await pair(t);
  const secret = await f.a.create({ name: 'inflight remote key', kind: 'scalar', value: VISIBLE, sharing: f.toB });
  for (const mode of ['revoke', 'close'] as const) {
    const cap = f.runsB.add(f.projectB), context = await f.recipient.context(cap);
    const pending = f.recipient.broker.compare(context, secret.reference, secret.reference);
    const denied = assert.rejects(pending);
    let request;
    for (let count = 0; !request && count < 100; count++) { request = f.recipient.remote.poll('controller-a')[0]; if (!request) await new Promise(resolve => setTimeout(resolve, 1)); }
    assert.ok(request);
    const response = await f.source.remote.answer('node-b', request);
    if (mode === 'revoke') await f.b.disconnectSession(context, [secret.id]); else await f.b.closeTask(context.taskId);
    f.recipient.remote.deliver('controller-a', response); await denied;
    assert.equal(f.recipient.remote.pending(), 0); assert.equal(f.runsB.list().find(run => run.id === cap.runId)?.status, 'running');
  }
});

test('two encrypted vaults deliver an exact 1MiB remote file through a bounded sealed envelope', { timeout: 30000 }, async t => {
  const f = await pair(t), payload = Buffer.alloc(MAX_SECRET_BYTES, 0xa5);
  const secret = await f.a.create({ name: 'maximum fixture file', kind: 'file', content: payload.toString('base64'), sharing: f.toB });
  await assert.rejects(f.a.create({ name: 'oversized fixture file', kind: 'file', content: Buffer.alloc(MAX_SECRET_BYTES + 1).toString('base64'), sharing: f.toB }));
  for (let use = 0; use < 4; use++) {
    const result = await f.relay(f.recipient.tool(f.capB, 'secrets_run', { operationId: `maximum-remote-file-${use}`, command: process.execPath,
      args: ['-e', "const v=require('fs').readFileSync(process.argv[1]);console.log(v.length+':'+require('crypto').createHash('sha256').update(v).digest('hex'));", '{secret-file:MAXIMUM}'], files: { MAXIMUM: secret.reference } })) as SecretRunResult;
    assert.equal(result.exitCode, 0); assert.equal(result.stdout.trim(), `${MAX_SECRET_BYTES}:${createHash('sha256').update(payload).digest('hex')}`);
  }
  const { REMOTE_SECRET_MAX_RESPONSE_BYTES } = await import('../../../server/secrets/remote.js');
  const responses = f.wires.filter(wire => typeof wire === 'object' && wire !== null && 'ciphertext' in wire);
  assert.equal(responses.length, 8);
  for (const response of responses) assert.ok(Buffer.byteLength(JSON.stringify(response)) <= REMOTE_SECRET_MAX_RESPONSE_BYTES);
  assert.equal(JSON.stringify(f.wires).includes(payload.toString('base64')), false); assert.equal(stored(f.b).secrets.length, 0);
  const journal = await f.a.vault.journal() as { operations: Record<string, { result?: unknown }> };
  assert.ok(Buffer.byteLength(JSON.stringify(journal)) < 64 * 1024, 'remote proofs must not retain unused response ciphertext');
  for (const claim of Object.values(journal.operations)) if (claim.result !== undefined) assert.deepEqual(claim.result, { answered: true });
  assert.equal(f.a.status().locked, false);
  await assert.rejects(f.source.remote.answer('node-b', f.wires[0]), /SECRET_REMOTE_DENIED/);
  assert.deepEqual(await f.a.vault.journal(), journal, 'replayed requests cannot create a new claim or retain another response');
  assert.deepEqual(await readdir(join(f.stateB, 'secrets', 'consumers')), []); assert.deepEqual(f.errors, []);
});

const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: '' };
test('owner HTTP secret API requires sign-in and page token; generic remote router exposes no secret management', { timeout: 20000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-http-integration-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state'), project = join(root, 'project'), link = join(root, 'project-link'); await mkdir(stateDir); await mkdir(project); await symlink(project, link);
  const service = await secretService(stateDir); const runs = new FixtureRuns(); runs.session('codex:http-session', link);
  const runtime = new SecretRuntime({ stateDir, service, runs }); t.after(() => runtime.close());
  const auth = await createRemoteAuthFixture(stateDir); const masterSecret = 'a'.repeat(64); let secretCalls = 0; let sharing = true;
  // The web's owner control in front of this worker, as server/index.ts wires it; `sharing` says whether the worker serves per-secret sharing.
  const worker = { supports: () => sharing, secretCall: async (operation: string, args: unknown[] = []) => {
    secretCalls++;
    if (operation === 'peers') return runtime.peers();
    if (operation === 'device') return runtime.device();
    assert.equal(operation, 'control');
    // An older worker answers its `overview`, of which the web reads only the status.
    if (!sharing && args[0] === 'overview') return { status: (await runtime.control('settings', {}) as SecretSettingsView).status, projects: [], groups: [], rules: [], secrets: [{ id: 'old' }] };
    return runtime.control(String(args[0]), args[1] as Record<string, unknown>, args[2]);
  } };
  const backend: Backend = { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('No native provider may run in this fixture'); }, cancel: async () => {}, subscribe: () => () => {}, secrets: (action, input) => ownerSecretControl(undefined, worker, action, input) };
  const monitor = createMonitorServer({ port: 0, clientDir: stateDir, auth: auth.auth, remote: { origins: auth.origins }, backend, master: { callerSecret: masterSecret, handle: async () => false } });
  t.after(async () => { monitor.dispose(); monitor.server.closeAllConnections(); if (monitor.server.listening) await new Promise<void>(resolve => monitor.server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => { monitor.server.once('error', reject); monitor.server.listen(0, '127.0.0.1', resolve); }); const base = `http://127.0.0.1:${(monitor.server.address() as AddressInfo).port}`;
  const { token } = await (await auth.fetch(`${base}/api/bootstrap`, { headers: { cookie: auth.cookie } })).json() as { token: string };
  const secureHost = `secure.test:${new URL(base).port}`;
  auth.origins.add(`https://${secureHost}`);
  const secureFetch = (path: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init.headers); headers.set('Host', secureHost); headers.set('Origin', `https://${secureHost}`); headers.set('X-Forwarded-For', '192.0.2.1');
    const request = httpRequest(`${base}${path}`, { method: init.method ?? 'GET', headers: Object.fromEntries(headers) }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('error', reject);
      response.once('end', () => resolve(new Response(Buffer.concat(chunks).toString(), { status: response.statusCode ?? 500 })));
    });
    request.once('error', reject); request.end(typeof init.body === 'string' ? init.body : undefined);
  });
  const post = (action: string, body: unknown, headers: Record<string, string> = { cookie: auth.cookie, 'X-Agent-Monitor-Token': token }) => secureFetch(`/api/secrets/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const READS = ['settings', `session?sessionId=${encodeURIComponent('codex:http-session')}`];
  const WRITES = ['sharing', 'create', 'session-connect', 'session-disconnect', 'initialize'];
  // Signed out, without the page token, over plain HTTP from afar, or from an agent or the master: refused before the worker.
  for (const read of READS) assert.equal((await auth.fetch(`${base}/api/secrets/${read}`)).status, 401);
  for (const action of WRITES) assert.equal((await post(action, { password: PASSWORD }, { cookie: auth.cookie })).status, 403);
  const insecureHeaders = { cookie: auth.cookie, 'X-Agent-Monitor-Token': token, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' };
  for (const action of WRITES) assert.equal((await auth.fetch(`${base}/api/secrets/${action}`, { method: 'POST', headers: insecureHeaders, body: JSON.stringify({ password: PASSWORD }) })).status, 403);
  for (const read of READS) assert.equal((await auth.fetch(`${base}/api/secrets/${read}`, { headers: { cookie: auth.cookie } })).status, 403);
  auth.origins.add(`http://${secureHost}`);
  assert.equal((await post('initialize', { password: PASSWORD })).status, 403);
  auth.origins.delete(`http://${secureHost}`);
  for (const action of WRITES) {
    assert.equal((await post(action, { password: PASSWORD }, { cookie: auth.cookie, 'X-Agent-Monitor-Token': token, 'x-tower-master': masterSecret })).status, 403);
    assert.equal((await fetch(`${base}/api/secrets/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, 'x-tower-agent': 'local' }, body: '{}' })).status, 403);
  }
  for (const read of READS) assert.equal((await fetch(`${base}/api/secrets/${read}`, { headers: { 'x-tower-agent': 'local' } })).status, 403);
  for (const removed of ['overview', 'rule', 'project', 'attach', 'connect', 'revoke', 'end-task']) assert.equal((await post(removed, {})).status, 404);
  assert.equal((await post('settings', {})).status, 404, 'views are read with GET'); assert.equal((await post('session', {})).status, 404);
  assert.equal(secretCalls, 0);
  // An older worker is asked only for the vault's status; the page learns that a new one is pending.
  sharing = false;
  const pending = await secureFetch('/api/secrets/settings', { headers: { cookie: auth.cookie } });
  assert.equal(pending.status, 200); assert.deepEqual(await pending.json(), { status: { initialized: false, locked: true, pendingImports: 0, pendingImportIds: [] }, peers: [], secrets: [], workerUpdatePending: true });
  assert.equal(secretCalls, 1);
  assert.equal((await post('initialize', { password: PASSWORD })).status, 503); assert.equal(secretCalls, 1);
  sharing = true;
  assert.equal((await post('initialize', { password: PASSWORD })).status, 200);
  const created = await post('create', { name: 'HTTP key', kind: 'scalar', value: VISIBLE, sharing: { global: false, folders: [{ cwd: link }] } });
  assert.equal(created.status, 200); const settings = await created.json() as SecretSettingsView;
  assert.deepEqual(settings.secrets.map(secret => secret.sharing?.folders), [[{ hostId: service.device().id, root: project }]], 'the folder key becomes the real folder');
  assert.equal(JSON.stringify(settings).includes(VISIBLE), false);
  const refused = await post('sharing', { secretId: settings.secrets[0]!.id, revision: 1, global: false, folders: [{ cwd: join(root, 'missing') }] });
  assert.equal(refused.status, 400); assert.match((await refused.json() as { error: string }).error, /폴더를 찾을 수 없습니다/);
  const stale = await post('sharing', { secretId: settings.secrets[0]!.id, revision: 0, global: true, folders: [] }); assert.equal(stale.status, 409);
  const shown = await secureFetch('/api/secrets/settings', { headers: { cookie: auth.cookie } }); assert.equal(shown.status, 200); assert.equal((await shown.text()).includes(VISIBLE), false);
  const view = await secureFetch(`/api/secrets/session?sessionId=${encodeURIComponent('codex:http-session')}`, { headers: { cookie: auth.cookie } });
  assert.deepEqual((await view.json() as SecretSessionView).available.map(item => [item.name, item.basis]), [['HTTP key', ['folder']]]);
  assert.equal(service.currentTask('codex:http-session'), undefined, 'the view started no task');
  const connected = await post('session-connect', { sessionId: 'codex:http-session', secretIds: [settings.secrets[0]!.id] });
  assert.equal(connected.status, 200); assert.deepEqual((await connected.json() as SecretSessionView).available[0]?.basis, ['session', 'folder']);
  assert.equal((await fetch(`${base}/api/secrets/settings`)).status, 200, 'loopback reads as before');
  const exclusions = new RemoteExclusionStore(stateDir); await exclusions.start(); const remote = createRemoteRouter({ backend, exclusions }); const server = createServer((req, res) => { void remote.handle(req, res, { controllerId: 'fixture-controller-123456789' }); });
  t.after(async () => { remote.dispose(); server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const remoteBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const before = secretCalls;
  for (const read of READS) assert.equal((await fetch(`${remoteBase}/api/secrets/${read}`)).status, 404);
  for (const action of WRITES) assert.equal((await fetch(`${remoteBase}/api/secrets/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).status, 404);
  assert.equal(secretCalls, before);
  assert.equal((await storedText(stateDir)).includes(VISIBLE), false); assert.equal((await storedText(stateDir)).includes(PASSWORD), false);
});

test('every secret route refuses the master, local agents and run capabilities before the worker is asked', { timeout: 20000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-secret-http-callers-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const auth = await createRemoteAuthFixture(stateDir); const masterSecret = 'c'.repeat(64); const calls: string[] = [];
  const backend: Backend = { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('No native provider may run in this fixture'); }, cancel: async () => {}, subscribe: () => () => {},
    secrets: async action => { calls.push(action); return {}; } };
  const monitor = createMonitorServer({ port: 0, clientDir: stateDir, auth: auth.auth, remote: { origins: auth.origins }, backend, master: { callerSecret: masterSecret, handle: async () => false } });
  t.after(async () => { monitor.dispose(); monitor.server.closeAllConnections(); if (monitor.server.listening) await new Promise<void>(resolve => monitor.server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => { monitor.server.once('error', reject); monitor.server.listen(0, '127.0.0.1', resolve); }); const base = `http://127.0.0.1:${(monitor.server.address() as AddressInfo).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie: auth.cookie } })).json() as { token: string };
  const owner = { cookie: auth.cookie, 'X-Agent-Monitor-Token': token, 'Content-Type': 'application/json' };
  const READS = ['settings', 'session?sessionId=codex%3Afixture', 'broker-access?sessionId=codex%3Afixture'];
  const WRITES = ['sharing', 'create', 'session-connect', 'session-disconnect', 'update', 'remove', 'unlock', 'lock', 'password', 'import', 'trust', 'untrust', 'preview', 'initialize', 'approve-broker', 'revoke-broker'];
  // On this computer the owner's own page reaches the worker; the same page request naming another caller does not.
  assert.equal((await fetch(`${base}/api/secrets/settings`, { headers: { cookie: auth.cookie } })).status, 200); assert.deepEqual(calls, ['settings']); calls.length = 0;
  const callers: Record<string, string>[] = [{ 'x-tower-master': masterSecret }, { 'x-tower-master': 'not-the-master' }, { 'x-tower-agent': 'local' }, { [CALLER_CAPABILITY_HEADER]: 'b'.repeat(64) }];
  for (const caller of callers) {
    for (const read of READS) assert.equal((await fetch(`${base}/api/secrets/${read}`, { headers: { cookie: auth.cookie, ...caller } })).status, 403, `${read} with ${Object.keys(caller)[0]}`);
    // Changes count against the page's request budget; the verified master and local agents have budgets of their own.
    const writes = caller['x-tower-master'] === masterSecret || caller['x-tower-agent'] ? WRITES : ['sharing', 'create', 'session-connect', 'unlock', 'update'];
    for (const action of writes) assert.equal((await fetch(`${base}/api/secrets/${action}`, { method: 'POST', headers: { ...owner, ...caller }, body: '{}' })).status, 403, `${action} with ${Object.keys(caller)[0]}`);
  }
  assert.deepEqual(calls, []);
});

test('a folder identity the page sends back is accepted only where that key already keeps it; anything new is resolved first', { timeout: 20000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-kept-folders-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state'), project = join(root, 'project'); await mkdir(stateDir); await mkdir(project);
  const service = await secretService(stateDir, { password: PASSWORD }); const runtime = new SecretRuntime({ stateDir, service, runs: new FixtureRuns() }); t.after(() => runtime.close());
  const worker = { supports: () => true, secretCall: async (operation: string, args: unknown[] = []) => operation === 'peers' ? runtime.peers() : operation === 'device' ? runtime.device() : runtime.control(String(args[0]), args[1] as Record<string, unknown>, args[2]) };
  const control = (action: string, input: Record<string, unknown>) => ownerSecretControl(undefined, worker, action, input) as Promise<SecretSettingsView>;
  const host = service.device().id, gone = randomUUID();
  // Kept from when that computer was trusted for secrets.
  await service.trustPeer({ device: { ...service.device(), id: gone }, routeId: 'f'.repeat(32), direction: 'node', enabled: true });
  const secret = await service.create({ name: 'kept', kind: 'scalar', value: VISIBLE, sharing: { global: false, folders: [{ hostId: gone, root: '/gone/project' }, { hostId: host, root: project }] } });
  await service.removePeer(gone);
  const sharing = () => service.settings().secrets.find(item => item.id === secret.id)!.sharing!;
  for (const folders of [[{ hostId: host, root: join(root, 'missing') }], [{ hostId: host, root: '/' }], [{ hostId: gone, root: '/gone/other' }]]) {
    await assert.rejects(control('sharing', { secretId: secret.id, revision: 1, global: false, folders }), { kind: 'invalid' }, JSON.stringify(folders));
    await assert.rejects(control('create', { name: 'raw', kind: 'scalar', value: 'v', sharing: { global: false, folders } }), { kind: 'invalid' });
  }
  assert.equal(sharing().revision, 1); assert.equal(service.settings().secrets.length, 1);
  const saved = await control('sharing', { secretId: secret.id, revision: 1, global: true, folders: [{ hostId: gone, root: '/gone/project' }, { hostId: host, root: project }] });
  assert.deepEqual(saved.secrets.find(item => item.id === secret.id)?.sharing, { revision: 2, global: true, folders: [{ hostId: gone, root: '/gone/project' }, { hostId: host, root: project }] }, 'folders it keeps come back as identities');
  await control('sharing', { secretId: secret.id, revision: 2, global: true, folders: [], kept: [{ hostId: host, root: '/' }] });
  assert.deepEqual(sharing(), { revision: 3, global: true, folders: [] }, 'the page cannot name what counts as kept');
});
