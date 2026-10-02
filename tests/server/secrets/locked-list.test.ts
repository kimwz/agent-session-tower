import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SecretService } from '../../../server/secrets/service.js';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import { SECRET_LOCKED_USE } from '../../../server/secrets/notices.js';
import type { SecretContext, SecretMetadata } from '../../../shared/secrets.js';
import type { Run, Session } from '../../../shared/types.js';
import type { Capability } from '../../../server/api/mcp.js';
import type { SessionOrigin } from '../../../server/runs/origin.js';

const PASSWORD = 'fixture-locked-list-password';
const CANARY = 'LOCKED_LIST_VALUE_CANARY_5531';

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-locked-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDir = join(directory, 'state'), root = join(directory, 'project'), other = join(directory, 'other');
  await Promise.all([stateDir, root, other].map(path => mkdir(path)));
  let now = Date.now(); const clock = { advance: (ms: number) => { now += ms; } };
  const service = new SecretService({ stateDir, now: () => now }); await service.start(); await service.initialize(PASSWORD);
  const host = service.device().id;
  const project = await service.project({ name: 'fixture', bindings: [{ hostId: host, root }] });
  const otherProject = await service.project({ name: 'other', bindings: [{ hostId: host, root: other }] });
  const startedAt = new Date(now).toISOString();
  const target = await service.bindRun('codex:session-a', root, startedAt);
  const context: SecretContext = { ...target, runId: 'run-a' };
  return { stateDir, root, service, host, project, otherProject, target, context, startedAt, clock, restart: async () => { const next = new SecretService({ stateDir, now: () => now }); await next.start(); return next; } };
}

/** Every rule shape that decides discovery or operations, so locked and unlocked evaluation are held to one outcome. */
async function scenario(f: Awaited<ReturnType<typeof fixture>>) {
  const { service, target, project, otherProject, host } = f;
  await service.create({ name: 'GLOBAL_AUTO', kind: 'scalar', scope: 'global', value: CANARY, allProjects: true, target, activation: 'auto', operations: ['discover', 'env'] });
  await service.create({ name: 'PROJECT_MANUAL_UNCONNECTED', kind: 'scalar', scope: 'project', projectId: project.id, value: CANARY, target, activation: 'manual' });
  await service.create({ name: 'PROJECT_MANUAL_CONNECTED', kind: 'scalar', scope: 'project', projectId: project.id, value: CANARY, target, activation: 'manual', connect: true });
  await service.create({ name: 'TASK_ONLY', kind: 'scalar', scope: 'task', value: CANARY, target, activation: 'manual', operations: ['discover', 'env'], connect: true });
  await service.create({ name: 'OTHER_PROJECT', kind: 'scalar', scope: 'project', projectId: otherProject.id, value: CANARY, activation: 'auto' });
  await service.create({ name: 'EXPIRING', kind: 'scalar', scope: 'project', projectId: project.id, value: CANARY, target, activation: 'auto', expiresAt: Date.now() + 60_000 });
  const dotenv = await service.create({ name: 'DOTENV', kind: 'env', scope: 'project', projectId: project.id, value: `A=${CANARY}\nB=${CANARY}\n`, target, activation: 'auto', operations: ['discover', 'env'] });
  const rule = service.overview().rules.find(rule => rule.secretIds.includes(dotenv.id))!;
  await service.setRule({ ...rule, fields: { [dotenv.id]: ['A'] } });
  // A second rule granting only env makes env ambiguous while discover stays single.
  const overlap = await service.create({ name: 'OVERLAP', kind: 'scalar', scope: 'project', projectId: project.id, value: CANARY, target, activation: 'auto', operations: ['discover', 'env'] });
  await service.setRule({ groupId: overlap.groupId, secretIds: [overlap.id], hostId: host, projectId: project.id, activation: 'auto', operations: ['env'], enabled: true });
  const disabled = await service.create({ name: 'DISABLED', kind: 'scalar', scope: 'project', projectId: project.id, value: CANARY, target, activation: 'auto' });
  const disabledRule = service.overview().rules.find(rule => rule.secretIds.includes(disabled.id))!;
  await service.setRule({ ...disabledRule, enabled: false });
  const revoked = await service.create({ name: 'REVOKED', kind: 'scalar', scope: 'project', projectId: project.id, value: CANARY, target, activation: 'auto' });
  await service.revoke(target, [revoked.id]);
  const stale = await service.create({ name: 'STALE_GRANT', kind: 'scalar', scope: 'project', projectId: project.id, value: CANARY, target, activation: 'manual', connect: true });
  await service.update({ id: stale.id, value: `${CANARY}-v2` });
  // An automatic grant issued before a value change no longer matches the secret's version.
  const autoStale = await service.create({ name: 'AUTO_STALE', kind: 'scalar', scope: 'project', projectId: project.id, value: CANARY, target, activation: 'auto' });
  await service.list(f.context); await service.update({ id: autoStale.id, value: `${CANARY}-v2` });
  // A grant with a deadline that passes while the vault is locked.
  const deadline = await service.create({ name: 'DEADLINE', kind: 'scalar', scope: 'project', projectId: project.id, value: CANARY, target, activation: 'manual' });
  const deadlineRule = service.overview().rules.find(rule => rule.secretIds.includes(deadline.id))!;
  await service.setRule({ ...deadlineRule, maxTtlMs: 60_000 }); await service.connect(target, [deadline.id]);
}

const names = (list: SecretMetadata[]) => list.map(item => item.name).sort();
/** Tool results travel as JSON, where an undefined field and a missing one are the same. */
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

test('locked listing matches unlocked authorization, including operations, fields, grants and expiry', async t => {
  const f = await fixture(t); await scenario(f);
  const unlocked = await f.service.list(f.context);
  assert.deepEqual(names(unlocked), ['DEADLINE', 'DOTENV', 'EXPIRING', 'GLOBAL_AUTO', 'OVERLAP', 'PROJECT_MANUAL_CONNECTED', 'TASK_ONLY']);
  assert.deepEqual(unlocked.find(item => item.name === 'OVERLAP')!.operations, ['discover']);
  assert.deepEqual(unlocked.find(item => item.name === 'DOTENV')!.fields, ['A']);
  await f.service.lock();
  assert.deepEqual(wire(f.service.lockedList(f.target.sessionId, f.root, f.startedAt, f.target)), wire(unlocked));
  const restarted = await f.restart();
  assert.equal(restarted.status().locked, true);
  assert.deepEqual(wire(restarted.lockedList(f.target.sessionId, f.root, f.startedAt, f.target)), wire(unlocked));
  assert.deepEqual(wire(restarted.lockedList(f.target.sessionId, f.root, f.startedAt)), wire(unlocked), 'an unbound run finds the session’s open task');

  f.clock.advance(120_000);
  const lockedLater = restarted.lockedList(f.target.sessionId, f.root, f.startedAt, f.target);
  await restarted.unlock(PASSWORD);
  assert.deepEqual(wire(lockedLater), wire(await restarted.list(f.context)));
  assert.ok(!names(lockedLater).includes('EXPIRING')); assert.ok(!names(lockedLater).includes('DEADLINE'));
});

test('a session without a task lists only what a fresh task would, and closed tasks stay closed', async t => {
  const f = await fixture(t); await scenario(f);
  await f.service.lock();
  const fresh = f.service.lockedList('codex:session-b', f.root, new Date().toISOString());
  await f.service.unlock(PASSWORD);
  const bound = await f.service.bindRun('codex:session-b', f.root, new Date().toISOString());
  assert.deepEqual(wire(fresh), wire(await f.service.list({ ...bound, runId: 'run-b' })));
  assert.deepEqual(names(fresh), ['AUTO_STALE', 'DOTENV', 'EXPIRING', 'GLOBAL_AUTO', 'OVERLAP', 'REVOKED'], 'a revocation belongs to the task it was made for');

  await f.service.closeTask(f.target.taskId); await f.service.lock();
  assert.throws(() => f.service.lockedList(f.target.sessionId, f.root, f.startedAt, f.target), /Task identity denied/);
  assert.throws(() => f.service.lockedList(f.target.sessionId, f.root, f.startedAt), /Run predates task closure/);
});

test('the plaintext index holds names but no value or password, and a foreign index is ignored', async t => {
  const f = await fixture(t); await scenario(f); await f.service.lock();
  const text = await readFile(join(f.stateDir, 'secrets', 'index.json'), 'utf8');
  assert.match(text, /GLOBAL_AUTO/); assert.doesNotMatch(text, new RegExp(`${CANARY}|${PASSWORD}`));
  const index = JSON.parse(text); index.vaultId = randomUUID();
  await writeFile(join(f.stateDir, 'secrets', 'index.json'), JSON.stringify(index));
  assert.deepEqual((await f.restart()).lockedList(f.target.sessionId, f.root, f.startedAt), []);
});

test('a failed index write never leaves an older index listing names, in memory or after restart', async t => {
  const f = await fixture(t); await scenario(f);
  const path = join(f.stateDir, 'secrets', 'index.json'); const previous = await readFile(path, 'utf8');
  await rm(path); await mkdir(join(path, 'blocked'), { recursive: true });
  await f.service.revoke(f.target, f.service.overview().secrets.map(secret => secret.id));
  assert.deepEqual(await f.service.list(f.context), []);
  await f.service.lock();
  assert.deepEqual(f.service.lockedList(f.target.sessionId, f.root, f.startedAt, f.target), []);
  await rm(path, { recursive: true }); await writeFile(path, previous);
  assert.deepEqual((await f.restart()).lockedList(f.target.sessionId, f.root, f.startedAt, f.target), [], 'an index from an earlier save is not trusted');
});

class FixtureRuns {
  readonly sessions = new Map<string, Session>(); readonly running: Run[] = [];
  add(root: string, sessionId = `codex:${randomUUID()}`): Extract<Capability, { kind: 'secret-run' }> {
    const runId = randomUUID(); const at = new Date().toISOString();
    this.sessions.set(sessionId, { id: sessionId, nativeId: sessionId.slice(6), provider: 'codex', title: 'fixture', cwd: root, project: 'fixture', status: 'working', statusReason: '', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 0, isSubagent: false, resumable: true });
    this.running.push({ id: runId, sessionId, prompt: 'fixture owner task', status: 'running', createdAt: at, startedAt: at, output: '', origin: { kind: 'owner' }, towerTools: 'attached' });
    return { kind: 'secret-run', runId, sessionId };
  }
  list() { return this.running; } getSession(id: string) { return this.sessions.get(id); }
  sessionOrigin(_id: string): SessionOrigin { return { kind: 'owner', untrustedInput: false }; }
}

test('locked tools list names and turn any use into an unlock request; ineligible runs are still refused', async t => {
  const f = await fixture(t); await scenario(f);
  const runs = new FixtureRuns(); const runtime = new SecretRuntime({ stateDir: f.stateDir, service: f.service, runs }); t.after(() => runtime.close());
  const capability = runs.add(f.root);
  const unlocked = await runtime.tool(capability, 'secrets_list', {}) as { secrets: SecretMetadata[]; locked?: boolean };
  assert.equal(unlocked.locked, undefined);
  await f.service.lock();

  const locked = await runtime.tool(capability, 'secrets_list', {}) as { secrets: SecretMetadata[]; locked: boolean; notice: string };
  assert.equal(locked.locked, true); assert.match(locked.notice, /locked/);
  assert.deepEqual(wire(locked.secrets), wire(unlocked.secrets));
  assert.deepEqual(await runtime.tool(capability, 'secrets_cli', { argv: ['list'] }), locked);

  const reference = locked.secrets.find(item => item.name === 'GLOBAL_AUTO')!.reference;
  await assert.rejects(runtime.tool(capability, 'secrets_run', { operationId: 'locked-use', command: process.execPath, args: ['-e', ''], env: { KEY: reference } }),
    (error: Error & { statusCode?: number }) => error.statusCode === 423 && error.message === SECRET_LOCKED_USE);
  await assert.rejects(runtime.tool(capability, 'secrets_cli', { argv: ['fingerprint', reference] }), (error: Error & { statusCode?: number }) => error.statusCode === 423);
  await assert.rejects(runtime.tool(capability, 'secrets_cli', { operationId: 'locked-cli', argv: ['run', '--env', `KEY=${reference}`, '--', process.execPath, '-e', ''] }), (error: Error & { statusCode?: number }) => error.statusCode === 423);

  runs.running.find(run => run.id === capability.runId)!.status = 'completed';
  await assert.rejects(runtime.tool(capability, 'secrets_list', {}), (error: Error & { statusCode?: number }) => error.statusCode === 403);
});
