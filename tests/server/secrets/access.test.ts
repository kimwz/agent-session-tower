import test from 'node:test';
import assert from 'node:assert/strict';
import type { Run, RunDelegation, RunOrigin, Session } from '../../../shared/types.js';
import { secretSubject, type KnownSession, type SecretStage, type SecretSubject } from '../../../server/secrets/access.js';
import { PUBLIC_TRIGGER_PREFIX, type SessionOrigin } from '../../../server/runs/origin.js';
import { noticeAdmission } from '../../../server/runs/continuations.js';

const CONTROLLER = 'c'.repeat(32);
const PUBLIC = `${PUBLIC_TRIGGER_PREFIX}agent-1`;
const record = (id: string, patch: Partial<Session> = {}): Session => ({ id, nativeId: id.split(':')[1] ?? id, provider: 'codex', title: 'fixture', cwd: '/work/repo', project: 'repo', status: 'working',
  statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true, ...patch });

/** Sessions and turns the server knows, each session with the provenance Tower recorded for it (if any). */
function fixture() {
  const known = new Map<string, KnownSession>();
  const runs = new Map<string, Pick<Run, 'origin' | 'delegation' | 'sessionId'>>();
  const add = (id: string, patch: Partial<Session> = {}, provenance?: SessionOrigin) => { const session = record(id, patch); known.set(id, { session, ...(provenance ? { provenance } : {}) }); return session; };
  /** A turn that is (or was) in the run list; `delegation` names the turn whose calling credential started it. */
  const turn = (id: string, sessionId: string, origin: RunOrigin, delegation?: RunDelegation) => { runs.set(id, { sessionId, origin, ...(delegation ? { delegation } : {}) }); return id; };
  const subject = (sessionId: string | undefined, origin?: RunOrigin, extra: { run?: Partial<Run>; stage?: SecretStage } = {}): SecretSubject => {
    const found = sessionId === undefined ? undefined : known.get(sessionId);
    return secretSubject({ ...(origin || extra.run ? { run: { sessionId: sessionId ?? '', origin, ...extra.run } } : {}), session: found?.session, provenance: found?.provenance,
      stage: extra.stage ?? 'issue', lookup: id => known.get(id), findRun: id => runs.get(id) });
  };
  const mode = (...args: Parameters<typeof subject>) => { const decided = subject(...args); return decided.mode === 'none' ? `none:${decided.reason}` : decided.mode; };
  return { known, runs, add, turn, subject, mode };
}

test('the owner’s own conversations are exempt from review; outside content does not take the exemption away', async t => {
  const f = fixture();
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
  const f = fixture();
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
  const f = fixture();
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

test('closed, joined-computer and unknown sessions get no secret tools', () => {
  const f = fixture();
  f.add('codex:closed', { closed: true }, { kind: 'owner', untrustedInput: false });
  f.add('codex:node', { node: 'joined' }, { kind: 'owner', untrustedInput: false });
  for (const stage of ['issue', 'discover', 'use'] as const) {
    assert.equal(f.mode(undefined, { kind: 'owner' }, { stage }), 'none:no-session');
    assert.equal(f.mode('codex:closed', { kind: 'owner' }, { stage }), 'none:closed');
    assert.equal(f.mode('codex:node', { kind: 'owner' }, { stage }), 'none:joined-computer');
  }
});

test('a session still being created gets its tools as it will be; its secrets wait until the creation is confirmed', () => {
  const f = fixture();
  f.add('codex:pending', { creationPending: true }, { kind: 'owner', untrustedInput: false });
  f.add('codex:pending-slack', { creationPending: true }, { kind: 'slack', untrustedInput: true });
  f.add('codex:pending-public', { creationPending: true, launchedBy: { kind: 'trigger', triggerId: PUBLIC } }, { kind: 'trigger', triggerId: PUBLIC, untrustedInput: true });
  assert.deepEqual(['issue', 'discover', 'use'].map(stage => f.mode('codex:pending', { kind: 'owner' }, { stage: stage as SecretStage })), ['owner', 'owner', 'none:pending']);
  assert.deepEqual(['issue', 'discover', 'use'].map(stage => f.mode('codex:pending-slack', { kind: 'slack', workflowId: '11111111-1111-4111-8111-111111111111' }, { stage: stage as SecretStage })), ['reviewed', 'reviewed', 'none:pending']);
  assert.equal(f.mode('codex:pending-public', { kind: 'trigger', triggerId: PUBLIC }), 'none:public-agent');
  f.known.get('codex:pending')!.session.creationPending = false;
  assert.equal(f.mode('codex:pending', { kind: 'owner' }, { stage: 'use' }), 'owner', 'once confirmed');
});

test('a turn started with another turn’s calling credential is reviewed, and refused when a public agent started it, however far up', () => {
  const f = fixture();
  f.add('codex:owner', {}, { kind: 'owner', untrustedInput: false });
  f.add('codex:public', { launchedBy: { kind: 'trigger', triggerId: PUBLIC } }, { kind: 'trigger', triggerId: PUBLIC, untrustedInput: true });
  f.add('codex:public-child', { isSubagent: true, parentId: 'codex:public' });
  // A calling credential admits its work as the owner's, so the session it opens records the owner as its creator.
  f.add('codex:opened', {}, { kind: 'owner', untrustedInput: false });
  const owner = f.turn('owner-run', 'codex:owner', { kind: 'owner' });
  const outsider = f.turn('public-run', 'codex:public', { kind: 'trigger', triggerId: PUBLIC, eventId: 'request' });
  const typedIntoPublic = f.turn('typed-run', 'codex:public', { kind: 'owner' });
  const fromOwner = { parentRunId: owner, rootRunId: owner }, fromPublic = { parentRunId: outsider, rootRunId: outsider };
  assert.equal(f.mode('codex:opened', { kind: 'owner' }, { run: { delegation: fromOwner } }), 'reviewed', 'never exempt, even in a conversation recorded as the owner’s');
  assert.equal(f.mode('codex:owner', { kind: 'owner' }, { run: { delegation: fromOwner } }), 'reviewed');
  assert.equal(f.mode('codex:opened', { kind: 'owner' }), 'owner', 'a later turn the owner types there is the owner’s own');
  assert.equal(f.mode('codex:opened', { kind: 'owner' }, { run: { delegation: fromPublic } }), 'none:public-agent', 'a public agent’s new conversation');
  assert.equal(f.mode('codex:owner', { kind: 'owner' }, { run: { delegation: fromPublic } }), 'none:public-agent', 'a public agent’s turn in an existing conversation');
  assert.equal(f.mode('codex:owner', { kind: 'owner' }, { run: { delegation: { parentRunId: typedIntoPublic, rootRunId: typedIntoPublic } } }), 'none:public-agent', 'called from a public agent’s conversation');
  const child = f.turn('child-run', 'codex:public-child', { kind: 'owner' });
  assert.equal(f.mode('codex:owner', { kind: 'owner' }, { run: { delegation: { parentRunId: child, rootRunId: child } } }), 'none:public-agent', 'called from a public agent’s native child');
  const middle = f.turn('middle-run', 'codex:opened', { kind: 'owner' }, fromPublic);
  assert.equal(f.mode('codex:owner', { kind: 'owner' }, { run: { delegation: { parentRunId: middle, rootRunId: middle } } }), 'none:public-agent', 'through an intermediate turn');
  const cycle = f.turn('cycle-run', 'codex:owner', { kind: 'owner' }, { parentRunId: 'cycle-run', rootRunId: owner });
  assert.equal(f.mode('codex:owner', { kind: 'owner' }, { run: { delegation: { parentRunId: cycle, rootRunId: owner } } }), 'reviewed');
});

test('a calling turn the server no longer knows refuses the broker, but does not take back a credential already issued', () => {
  const f = fixture();
  f.add('codex:owner', {}, { kind: 'owner', untrustedInput: false });
  const gone = { parentRunId: 'left-history', rootRunId: 'left-history' };
  assert.equal(f.mode('codex:owner', { kind: 'owner' }, { run: { delegation: gone } }), 'none:unknown-caller');
  assert.equal(f.mode('codex:owner', { kind: 'owner' }, { run: { delegation: gone }, stage: 'discover' }), 'reviewed');
  assert.equal(f.mode('codex:owner', { kind: 'owner' }, { run: { delegation: gone }, stage: 'use' }), 'reviewed');
  f.turn('lost-session-run', 'codex:gone', { kind: 'owner' });
  assert.equal(f.mode('codex:owner', { kind: 'owner' }, { run: { delegation: { parentRunId: 'lost-session-run', rootRunId: 'lost-session-run' } } }), 'none:unknown-caller');
});

test('the master’s conversation follows the same rules as any other', () => {
  const f = fixture();
  f.add('codex:master', { master: true, cwd: '/state/master-session' }, { kind: 'owner', untrustedInput: false });
  f.add('codex:heartbeat', { master: true, cwd: '/state/master-session' });
  f.add('codex:delegated', { master: true, cwd: '/state/master-session/child' }, { kind: 'agent', untrustedInput: false });
  assert.equal(f.mode('codex:master', { kind: 'owner' }), 'owner', 'the owner’s own requests to the master');
  assert.equal(f.mode('codex:heartbeat', { kind: 'agent' }, { run: { heartbeat: { checkId: 'check', updatedAt: '', sessionIds: [], targets: [] } } }), 'reviewed', 'a heartbeat turn');
  assert.equal(f.mode('codex:delegated', { kind: 'owner' }), 'reviewed');
  f.add('codex:public-master', { master: true }, { kind: 'trigger', triggerId: PUBLIC, untrustedInput: true });
  assert.equal(f.mode('codex:public-master', { kind: 'owner' }), 'none:public-agent');
});

test('public agents and every native descendant of one get no secret tools', async t => {
  const f = fixture();
  const triggerId = PUBLIC;
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
  const f = fixture();
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

test('a permissions_run result or refusal notice is admitted as the work it reports to: a delegated run’s notice is reviewed', () => {
  const f = fixture();
  f.add('codex:caller', {}, { kind: 'owner', untrustedInput: false });
  f.add('codex:worker', {}, { kind: 'owner', untrustedInput: false });
  const caller = f.turn('caller-run', 'codex:caller', { kind: 'owner' });
  const delegated: Run = { id: 'delegated-run', sessionId: 'codex:worker', origin: { kind: 'owner' }, delegation: { parentRunId: caller, rootRunId: caller },
    prompt: 'Delegated work', status: 'completed', createdAt: '', output: '' };
  f.runs.set(delegated.id, delegated);
  const notice = noticeAdmission(delegated);
  assert.deepEqual(notice, { origin: { kind: 'owner' }, delegation: { parentRunId: caller, rootRunId: caller } });
  assert.equal(f.mode('codex:worker', notice.origin, { run: notice }), 'reviewed', 'not the owner’s own turn');
  const own = noticeAdmission({ ...delegated, id: 'own-run', delegation: undefined, unattended: true });
  assert.deepEqual(own, { origin: { kind: 'owner' }, unattended: true });
  assert.equal(f.mode('codex:worker', own.origin, { run: own }), 'owner');
  // A refusal whose run is no longer known, or predates origins, is told as the owner's, as before.
  for (const gone of [undefined, { ...delegated, origin: undefined }]) assert.deepEqual(noticeAdmission(gone), { origin: { kind: 'owner' } });
});
