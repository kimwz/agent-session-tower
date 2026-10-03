import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SecretService } from '../../../server/secrets/service.js';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import type { Run, Session } from '../../../shared/types.js';
import type { SessionOrigin } from '../../../server/runs/origin.js';

const PASSWORD = 'fixture-handoff-password';
const CANARY = 'HANDOFF_VALUE_CANARY_8172';

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-handoff-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDir = join(directory, 'state'), root = join(directory, 'project');
  await Promise.all([stateDir, root].map(path => mkdir(path)));
  const service = new SecretService({ stateDir }); await service.start(); await service.initialize(PASSWORD);
  const target = await service.ensureTask('codex:session-a', root);
  await service.create({ name: 'API_KEY', kind: 'scalar', scope: 'global', value: CANARY, allProjects: true, target, activation: 'manual', connect: true });
  /** The next worker's view of the same state folder: it starts locked, as every worker does. */
  const successor = async () => { const next = new SecretService({ stateDir }); await next.start(); return next; };
  return { directory, stateDir, root, service, target, successor };
}

class FixtureRuns {
  readonly sessions = new Map<string, Session>();
  add(id: string, root: string) { const at = new Date().toISOString(); this.sessions.set(id, { id, nativeId: id.slice(6), provider: 'codex', title: 'fixture', cwd: root, project: 'fixture', status: 'idle', statusReason: '', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 0, isSubagent: false, resumable: true }); }
  list(): Run[] { return []; } getSession(id: string) { return this.sessions.get(id); }
  sessionOrigin(_id: string): SessionOrigin { return { kind: 'owner', untrustedInput: false }; }
}

test('an open vault handed to the next worker opens it without the password, with its tasks and connections', async t => {
  const f = await fixture(t);
  const carry = f.service.handoff();
  assert.ok(carry);
  const next = await f.successor();
  assert.equal(next.status().locked, true);
  await next.adopt(carry);
  assert.equal(next.status().locked, false);
  assert.deepEqual(next.overview().secrets.map(secret => secret.name), ['API_KEY']);
  assert.equal(next.currentTask('codex:session-a', f.root)?.taskId, f.target.taskId, 'the session keeps its task across the handoff');
  assert.deepEqual(next.overview(f.target).connected.length, 1);
  // Nothing about the key reaches the state folder.
  for (const name of ['vault.json', 'journal.json', 'index.json']) {
    const bytes = await readFile(join(f.stateDir, 'secrets', name), 'utf8');
    assert.ok(!bytes.includes(JSON.parse(carry.toString()).key) && !bytes.includes(CANARY), name);
  }
});

test('a locked vault hands nothing over, and an owner lock is not undone by a handoff', async t => {
  const f = await fixture(t);
  await f.service.lock();
  assert.equal(f.service.handoff(), undefined);
  const next = await f.successor();
  assert.equal(next.status().locked, true);
});

test('a handoff that does not open this very vault leaves it locked', async t => {
  const f = await fixture(t);
  const carry = JSON.parse(f.service.handoff()!.toString()) as { format: number; vaultId: string; key: string };
  const other = await fixture(t);
  const foreign = other.service.handoff()!;
  const tampered = Buffer.from(carry.key, 'base64'); tampered[0] ^= 0xff;
  const cases: Array<[string, Buffer]> = [
    ['another vault', foreign],
    ['another vault id with this key', Buffer.from(JSON.stringify({ ...carry, vaultId: randomUUID() }))],
    ['a tampered key', Buffer.from(JSON.stringify({ ...carry, key: tampered.toString('base64') }))],
    ['a short key', Buffer.from(JSON.stringify({ ...carry, key: Buffer.alloc(16).toString('base64') }))],
    ['an unknown format', Buffer.from(JSON.stringify({ ...carry, format: 2 }))],
    ['not JSON', Buffer.from('not json')],
  ];
  for (const [name, bytes] of cases) {
    const next = await f.successor();
    await assert.rejects(next.adopt(bytes), name);
    assert.equal(next.status().locked, true, name);
  }
  // The genuine handoff still opens it afterwards.
  const next = await f.successor(); await next.adopt(Buffer.from(JSON.stringify(carry)));
  assert.equal(next.status().locked, false);
});

test('adopting a handoff completes it like a password unlock: archives made while locked are applied', async t => {
  const f = await fixture(t);
  const carry = f.service.handoff()!;
  const runs = new FixtureRuns(); runs.add('codex:session-a', f.root);
  // The successor starts locked; the owner archives the session before the vault is open.
  const next = await f.successor();
  const runtime = new SecretRuntime({ stateDir: f.stateDir, service: next, runs }); t.after(() => runtime.close());
  await runtime.endSession('codex:session-a');
  assert.equal(runtime.handoff(), undefined, 'nothing to hand over while locked');
  await runtime.adopt(carry);
  assert.equal(next.status().locked, false);
  assert.equal(next.currentTask('codex:session-a', f.root), undefined, 'the archive recorded while locked closed the task');
  assert.ok(runtime.handoff(), 'once open, the next handoff carries it on');
});
