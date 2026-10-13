import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MASTER_FOLDER } from '../../../shared/master.js';
import type { Run, RunOrigin, Session } from '../../../shared/types.js';
import { secretSubject, type KnownSession, type SecretSubject } from '../../../server/secrets/access.js';
import { PUBLIC_TRIGGER_PREFIX, type SessionOrigin } from '../../../server/runs/origin.js';

const CONTROLLER = 'c'.repeat(32);
const record = (id: string, patch: Partial<Session> = {}): Session => ({ id, nativeId: id.split(':')[1] ?? id, provider: 'codex', title: 'fixture', cwd: '/work/repo', project: 'repo', status: 'working',
  statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true, ...patch });

/** Sessions the server knows, each with the provenance Tower recorded for it (if any). */
async function fixture(t: test.TestContext) {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-access-')));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const known = new Map<string, KnownSession>();
  const add = (id: string, patch: Partial<Session> = {}, provenance?: SessionOrigin) => { const session = record(id, patch); known.set(id, { session, ...(provenance ? { provenance } : {}) }); return session; };
  const subject = (sessionId: string | undefined, origin?: RunOrigin, extra: { root?: string; run?: Partial<Run> } = {}): SecretSubject => {
    const found = sessionId === undefined ? undefined : known.get(sessionId);
    return secretSubject({ ...(origin || extra.run ? { run: { origin, ...extra.run } } : {}), session: found?.session, provenance: found?.provenance, stateDir, ...(extra.root ? { root: extra.root } : {}), lookup: id => known.get(id) });
  };
  const mode = (...args: Parameters<typeof subject>) => { const decided = subject(...args); return decided.mode === 'none' ? `none:${decided.reason}` : decided.mode; };
  return { stateDir, known, add, subject, mode };
}

test('the owner’s own conversations are exempt from review; outside content does not take the exemption away', async t => {
  const f = await fixture(t);
  f.add('codex:created', {}, { kind: 'owner', untrustedInput: false });
  f.add('codex:issue', {}, { kind: 'owner', untrustedInput: true });
  f.add('codex:remote', {}, { kind: 'owner', untrustedInput: false, controllerId: CONTROLLER });
  f.add('codex:native');
  assert.equal(f.mode('codex:created', { kind: 'owner' }), 'owner');
  assert.equal(f.mode('codex:issue', { kind: 'owner' }), 'owner', 'untrustedInput is a record of where words came from, not who opened the conversation');
  assert.equal(f.mode('codex:remote', { kind: 'owner', controllerId: CONTROLLER }), 'owner', 'opened by the owner from a controlling computer');
  assert.equal(f.mode('codex:created', { kind: 'agent' }), 'owner', 'decided by the conversation, not by who started this turn');
  assert.equal(f.mode('codex:created', { kind: 'trigger', triggerId: 'daily' }), 'owner');
  assert.equal(f.mode('codex:created'), 'owner', 'no turn: the conversation alone decides');
  assert.equal(f.mode('codex:native', { kind: 'owner' }), 'owner', 'a native conversation the owner opened in Tower, top level, the owner’s turn');
  assert.equal(f.mode('codex:native', { kind: 'owner', controllerId: CONTROLLER }), 'owner');
});

test('agent, Slack, trigger, coordinator and unknown work is reviewed, from this computer or a controller', async t => {
  const f = await fixture(t);
  const cases: [SessionOrigin | undefined, RunOrigin | undefined, string][] = [
    [{ kind: 'agent', untrustedInput: false }, { kind: 'agent' }, 'a delegated session'],
    [{ kind: 'agent', untrustedInput: false }, { kind: 'owner' }, 'the owner typing into a delegated session'],
    [{ kind: 'agent', untrustedInput: true }, { kind: 'agent' }, 'untrusted delegated work'],
    [{ kind: 'slack', untrustedInput: true, workflowId: '11111111-1111-4111-8111-111111111111' }, { kind: 'slack', workflowId: '11111111-1111-4111-8111-111111111111' }, 'a Slack coordinator'],
    [{ kind: 'trigger', triggerId: 'daily', untrustedInput: false }, { kind: 'trigger', triggerId: 'daily' }, 'a scheduled trigger'],
    [{ kind: 'trigger', triggerId: 'gh', untrustedInput: true }, { kind: 'trigger', triggerId: 'gh' }, 'a GitHub coordinator conversation'],
    [{ kind: 'trigger', triggerId: 'gh', untrustedInput: true }, { kind: 'owner' }, 'the owner in a GitHub coordinator conversation'],
    [{ kind: 'unknown', untrustedInput: true }, { kind: 'owner' }, 'a record that could not be read back'],
    [{ kind: 'agent', untrustedInput: false, controllerId: CONTROLLER }, { kind: 'agent', controllerId: CONTROLLER }, 'a controller’s agent'],
    [{ kind: 'trigger', triggerId: 'remote', untrustedInput: false, controllerId: CONTROLLER }, { kind: 'trigger', triggerId: 'remote', controllerId: CONTROLLER }, 'a controller’s trigger'],
    [undefined, { kind: 'agent' }, 'an agent turn in a native conversation'],
    [undefined, { kind: 'trigger', triggerId: 'daily' }, 'a trigger turn in a native conversation'],
    [undefined, { kind: 'slack', workflowId: '11111111-1111-4111-8111-111111111111' }, 'a Slack turn in a native conversation'],
    [undefined, { kind: 'unknown' }, 'an unknown turn in a native conversation'],
    [undefined, { kind: 'agent', controllerId: CONTROLLER }, 'a controller’s agent in a native conversation'],
    [undefined, undefined, 'a native conversation without a turn'],
  ];
  for (const [index, [provenance, origin, label]] of cases.entries()) {
    f.add(`codex:case-${index}`, {}, provenance);
    assert.equal(f.mode(`codex:case-${index}`, origin), 'reviewed', label);
  }
});

test('children and launched sessions are reviewed and never inherit their parent’s exemption', async t => {
  const f = await fixture(t);
  f.add('codex:parent', {}, { kind: 'owner', untrustedInput: false });
  for (const [id, patch] of [['codex:child', { parentId: 'codex:parent' }], ['codex:subagent', { isSubagent: true, parentId: 'codex:parent' }], ['codex:exec', { launchedByAgent: true, parentId: 'codex:parent' }],
    ['codex:detached-subagent', { isSubagent: true }], ['codex:launched', { launchedByAgent: true }], ['codex:triggered', { launchedBy: { kind: 'trigger', triggerId: 'daily' } }]] as const) {
    f.add(id, patch);
    assert.equal(f.mode(id, { kind: 'owner' }), 'reviewed', id);
    assert.equal(f.mode(id, { kind: 'agent' }), 'reviewed', id);
  }
  f.add('codex:grandchild', { parentId: 'codex:child' });
  assert.equal(f.mode('codex:grandchild', { kind: 'owner' }), 'reviewed');
});

test('closed, pending, joined-computer and unknown sessions get no secret tools', async t => {
  const f = await fixture(t);
  f.add('codex:closed', { closed: true }, { kind: 'owner', untrustedInput: false });
  f.add('codex:pending', { creationPending: true }, { kind: 'owner', untrustedInput: false });
  f.add('codex:node', { node: 'joined' }, { kind: 'owner', untrustedInput: false });
  assert.equal(f.mode(undefined, { kind: 'owner' }), 'none:no-session');
  assert.equal(f.mode('codex:closed', { kind: 'owner' }), 'none:closed');
  assert.equal(f.mode('codex:pending', { kind: 'owner' }), 'none:pending');
  assert.equal(f.mode('codex:node', { kind: 'owner' }), 'none:joined-computer');
});

test('the master’s conversation and folder get no secret tools, through any name the folder has', async t => {
  const f = await fixture(t);
  const master = join(f.stateDir, MASTER_FOLDER); await mkdir(join(master, 'child'), { recursive: true });
  const alias = join(f.stateDir, 'master-alias'); await symlink(master, alias);
  f.add('codex:flagged', { master: true }, { kind: 'owner', untrustedInput: false });
  f.add('codex:folder', { cwd: master }, { kind: 'owner', untrustedInput: false });
  f.add('codex:inside', { cwd: join(master, 'child') }, { kind: 'agent', untrustedInput: false });
  f.add('codex:alias', { cwd: alias }, { kind: 'agent', untrustedInput: false });
  f.add('codex:heartbeat', { cwd: master });
  for (const id of ['codex:flagged', 'codex:folder', 'codex:inside']) assert.equal(f.mode(id, { kind: 'owner' }), 'none:master', id);
  assert.equal(f.mode('codex:alias', { kind: 'owner' }, { root: await realpath(alias) }), 'none:master', 'the folder with links followed');
  assert.equal(f.mode('codex:heartbeat', { kind: 'agent' }, { run: { heartbeat: { checkId: 'check', updatedAt: '', sessionIds: [], targets: [] } } }), 'none:master', 'a heartbeat turn runs in the master’s folder');
});

test('public agents and every native descendant of one get no secret tools', async t => {
  const f = await fixture(t);
  const triggerId = `${PUBLIC_TRIGGER_PREFIX}agent-1`;
  f.add('codex:public', { launchedBy: { kind: 'trigger', triggerId } }, { kind: 'trigger', triggerId, eventId: 'request', untrustedInput: true });
  f.add('codex:recorded', {}, { kind: 'trigger', triggerId, untrustedInput: true });
  f.add('codex:launched', { launchedBy: { kind: 'trigger', triggerId } });
  f.add('codex:child', { parentId: 'codex:public', isSubagent: true });
  f.add('codex:grandchild', { parentId: 'codex:child', launchedByAgent: true });
  f.add('codex:owner', {}, { kind: 'owner', untrustedInput: false });
  assert.equal(f.mode('codex:public', { kind: 'trigger', triggerId, eventId: 'request' }), 'none:public-agent');
  assert.equal(f.mode('codex:public', { kind: 'owner' }), 'none:public-agent', 'the conversation’s provenance alone');
  assert.equal(f.mode('codex:recorded', { kind: 'owner' }), 'none:public-agent');
  assert.equal(f.mode('codex:launched', { kind: 'owner' }), 'none:public-agent');
  assert.equal(f.mode('codex:child', { kind: 'owner' }), 'none:public-agent', 'a public agent’s native child');
  assert.equal(f.mode('codex:grandchild', { kind: 'owner' }), 'none:public-agent');
  assert.equal(f.mode('codex:owner', { kind: 'trigger', triggerId }), 'none:public-agent', 'the turn’s own origin, even in the owner’s conversation');
  assert.equal(f.mode('codex:owner', { kind: 'trigger', triggerId: 'publicity' }), 'owner', 'only the exact prefix');
});

test('a parent the server does not know, or a circular chain, refuses rather than guesses', async t => {
  const f = await fixture(t);
  f.add('codex:orphan', { parentId: 'codex:missing' });
  f.add('codex:a', { parentId: 'codex:b' }); f.add('codex:b', { parentId: 'codex:a' });
  f.add('codex:self', { parentId: 'codex:self' });
  assert.equal(f.mode('codex:orphan', { kind: 'owner' }), 'none:unknown-parent');
  assert.equal(f.mode('codex:a', { kind: 'owner' }), 'none:unknown-parent');
  assert.equal(f.mode('codex:self', { kind: 'owner' }), 'none:unknown-parent');
  for (let depth = 0; depth <= 20; depth++) f.add(`codex:depth-${depth}`, depth ? { parentId: `codex:depth-${depth - 1}` } : {}, depth ? undefined : { kind: 'owner', untrustedInput: false });
  assert.equal(f.mode('codex:depth-5', { kind: 'owner' }), 'reviewed');
  assert.equal(f.mode('codex:depth-20', { kind: 'owner' }), 'none:unknown-parent', 'a chain longer than any real one');
});
