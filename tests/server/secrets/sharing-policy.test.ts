import test from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_OPERATIONS, type SecretGroup, type SecretOperation, type SecretPeer, type SecretProject, type SecretRule, type SecretTask } from '../../../shared/secrets.js';
import { available, covered, decide, servedHosts, type PolicySecret, type PolicyState } from '../../../server/secrets/policy.js';
import { legacySummary } from '../../../server/secrets/legacy-policy.js';
import * as oracle from './fixtures/grant-policy-1.130.2.js';

const NOW = 1_000_000;
const HOST = '11111111-1111-4111-8111-111111111111', NODE = '22222222-2222-4222-8222-222222222222', CONTROLLER = '33333333-3333-4333-8333-333333333333', STRANGER = '44444444-4444-4444-8444-444444444444';
const peer = (id: string, direction: SecretPeer['direction'], enabled = true): SecretPeer => ({ device: { id, name: id, signingKey: '', encryptionKey: '', fingerprint: '' }, routeId: id, direction, enabled });
const secret = (id: string, patch: Partial<PolicySecret['metadata']> = {}, extra: Omit<PolicySecret, 'metadata'> = {}): PolicySecret =>
  ({ metadata: { id, name: id, groupId: 'tower', kind: extra.fieldNames ? 'env' : 'scalar', version: 1, reference: `tower-secret://${HOST}/${id}@1`, ...patch }, ...extra });
const task = (patch: Partial<SecretTask> = {}): SecretTask => ({ id: 'task', hostId: HOST, sessionId: 'session', root: '/work/repo', status: 'open', createdAt: NOW - 10, excluded: [], connected: [], ...patch });
const state = (secrets: PolicySecret[], patch: Partial<PolicyState> = {}): PolicyState =>
  ({ deviceId: HOST, servedHosts: servedHosts(HOST, [peer(NODE, 'node'), peer(CONTROLLER, 'controller'), peer(STRANGER, 'node', false)]), projects: [], groups: [{ id: 'tower', name: 'Tower', scope: 'global' }], rules: [], secrets, tasks: [], ...patch });
const shared = (global: boolean, folders: { hostId: string; root: string }[] = []) => ({ sharing: { revision: 1, global, folders } });
const bases = (policy: PolicyState, subject: SecretTask, item: PolicySecret, operation: SecretOperation = 'env') => decide(policy, subject, item, operation, NOW)?.basis;

test('GLOBAL covers every folder of this computer and of enabled node peers, nothing else', () => {
  const key = secret('global', {}, shared(true)); const policy = state([key]);
  assert.deepEqual(servedHosts(HOST, [peer(NODE, 'node'), peer(CONTROLLER, 'controller'), peer(STRANGER, 'node', false)]), [HOST, NODE]);
  for (const [hostId, root] of [[HOST, '/work/repo'], [HOST, '/elsewhere'], [NODE, '/node/repo']]) assert.deepEqual(bases(policy, task({ hostId, root }), key), ['global'], `${hostId}:${root}`);
  for (const hostId of [CONTROLLER, STRANGER, 'unknown-host']) assert.equal(bases(policy, task({ hostId }), key), undefined, hostId);
  for (const operation of SECRET_OPERATIONS) assert.ok(decide(policy, task(), key, operation, NOW), operation);
});

test('folders match the exact computer and canonical root: other hosts, other roots, siblings and subfolders stay out', () => {
  const key = secret('folders', {}, shared(false, [{ hostId: HOST, root: '/work/repo' }, { hostId: NODE, root: '/node/repo' }])); const policy = state([key]);
  assert.deepEqual(bases(policy, task(), key), ['folder']);
  assert.deepEqual(bases(policy, task({ hostId: NODE, root: '/node/repo' }), key), ['folder']);
  for (const subject of [task({ hostId: NODE }), task({ root: '/node/repo' }), task({ root: '/work/repo-xyz' }), task({ root: '/work/repo/sub' }), task({ root: '/work' }), task({ hostId: CONTROLLER })])
    assert.equal(bases(policy, subject, key), undefined, `${subject.hostId}:${subject.root}`);
});

test('an unshared secret is used only where the owner connected it, with every operation and field', () => {
  const key = secret('none', {}, { ...shared(false), fieldNames: ['A', 'B'] }); const policy = state([key]);
  assert.equal(bases(policy, task(), key), undefined);
  assert.deepEqual(available(policy, task(), NOW), []);
  const connected = task({ connected: ['none'] });
  assert.deepEqual(available(policy, connected, NOW), [{ ...key.metadata, fields: ['A', 'B'], basis: ['session'], sourceHostId: HOST, operations: [...SECRET_OPERATIONS] }]);
  assert.equal(bases(policy, task({ id: 'other-task' }), key), undefined, 'a connection belongs to its task');
});

test('exclusion, expiry and a closed or expired task stop every basis, and a withheld secret keeps only the session', () => {
  const key = secret('key', {}, shared(true, [{ hostId: HOST, root: '/work/repo' }])); const policy = state([key]);
  assert.deepEqual(bases(policy, task({ connected: ['key'] }), key), ['session', 'global', 'folder']);
  assert.equal(bases(policy, task({ connected: ['key'], excluded: ['key'] }), key), undefined);
  assert.equal(bases(policy, task({ status: 'closed' }), key), undefined);
  assert.equal(bases(policy, task({ expiresAt: NOW }), key), undefined);
  assert.equal(bases(state([{ ...key, metadata: { ...key.metadata, expiresAt: NOW } }]), task(), { ...key, metadata: { ...key.metadata, expiresAt: NOW } }), undefined);
  // A rule names the edited secret again, as only an older build writes: GLOBAL and folders wait for the owner.
  const rolledBack = state([key], { rules: [{ id: 'old', groupId: 'tower', secretIds: ['key'], hostId: HOST, root: '/elsewhere', activation: 'manual', operations: ['env'], enabled: false, revision: 1 }] });
  assert.equal(bases(rolledBack, task(), key), undefined);
  assert.equal(bases(rolledBack, task({ root: '/elsewhere' }), key), undefined, 'the rule itself never applies to an edited secret');
  assert.deepEqual(bases(rolledBack, task({ connected: ['key'] }), key), ['session']);
});

test('an owner connection opens a rule-policy secret beyond its rules, with all fields; alone its rule keeps its selection', () => {
  const key = secret('legacy', { groupId: 'g' }, { fieldNames: ['A', 'B'] });
  const policy = state([key], { groups: [{ id: 'g', name: 'G', scope: 'global' }], rules: [{ id: 'r', groupId: 'g', secretIds: ['legacy'], hostId: HOST, root: '/work/repo', activation: 'manual', operations: ['discover', 'env'], fields: { legacy: ['A'] }, enabled: true, revision: 1 }] });
  assert.deepEqual(decide(policy, task(), key, 'env', NOW), { basis: ['legacy'], fields: ['A'] }, 'manual counts as automatic');
  assert.equal(decide(policy, task(), key, 'file', NOW), undefined);
  assert.deepEqual(decide(policy, task({ connected: ['legacy'] }), key, 'env', NOW), { basis: ['session', 'legacy'], fields: ['A', 'B'] });
  assert.deepEqual(decide(policy, task({ connected: ['legacy'] }), key, 'file', NOW), { basis: ['session'], fields: ['A', 'B'] });
  assert.equal(decide(policy, task({ root: '/other' }), key, 'env', NOW), undefined);
});

test('a rule time limit counts from the task, never from a later use', () => {
  const key = secret('timed', { groupId: 'g' });
  const policy = state([key], { groups: [{ id: 'g', name: 'G', scope: 'global' }], rules: [{ id: 'r', groupId: 'g', secretIds: ['timed'], hostId: HOST, allProjects: true, activation: 'auto', operations: ['env'], maxTtlMs: 100, enabled: true, revision: 1 }] });
  assert.ok(decide(policy, task({ createdAt: NOW - 99 }), key, 'env', NOW));
  assert.equal(decide(policy, task({ createdAt: NOW - 100 }), key, 'env', NOW), undefined);
  // 1.130.2 issued a fresh grant at first use and counted from it; the narrower start is the only difference.
  const before = { ...policy, rules: policy.rules, grants: [] as oracle.PolicyGrant[] };
  assert.ok(oracle.authorize(before, task({ createdAt: NOW - 100 }), key, 'env', NOW, (t, s, r) => ({ taskId: t.id, secretId: s.metadata.id, version: s.metadata.version, ruleId: r.id, revision: r.revision, deadline: NOW + r.maxTtlMs! })));
});

test('covered admits automatic use only where something is allowed or the task already has connections', () => {
  const folder = secret('folder', {}, shared(false, [{ hostId: NODE, root: '/node/repo' }]));
  const ruled = secret('ruled', { groupId: 'g' });
  const policy = state([folder, ruled], { groups: [{ id: 'g', name: 'G', scope: 'global' }], rules: [{ id: 'r', groupId: 'g', secretIds: ['ruled'], hostId: NODE, root: '/node/rule', activation: 'manual', operations: ['discover'], enabled: true, revision: 1 }],
    tasks: [task({ id: 'connected', hostId: NODE, root: '/node/empty', connected: ['folder'] }), task({ id: 'empty', hostId: NODE, root: '/node/empty' })] });
  assert.equal(covered(policy, NODE, '/node/repo', 'fresh', NOW), true);
  assert.equal(covered(policy, NODE, '/node/rule', 'fresh', NOW), true);
  assert.equal(covered(policy, NODE, '/node/empty', 'connected', NOW), true);
  assert.equal(covered(policy, NODE, '/node/empty', 'empty', NOW), false);
  assert.equal(covered(policy, NODE, '/node/empty', 'fresh', NOW), false);
  assert.equal(covered(policy, NODE, '/node/other', 'connected', NOW), false, 'a connection covers only its own task folder');
  assert.equal(covered(state([secret('global', {}, shared(true))]), CONTROLLER, '/any', 'fresh', NOW), false);
});

test('covered admits a folder where a rule allows only a use operation, as 1.130.2 resolved there', () => {
  const envOnly = secret('env-only', { groupId: 'g' });
  const policy = state([envOnly], { groups: [{ id: 'g', name: 'G', scope: 'global' }], rules: [{ id: 'r', groupId: 'g', secretIds: ['env-only'], hostId: NODE, root: '/node/env', activation: 'auto', operations: ['env'], enabled: true, revision: 1 }] });
  assert.deepEqual(available(policy, task({ hostId: NODE, root: '/node/env' }), NOW), [], 'nothing to list');
  assert.ok(decide(policy, task({ hostId: NODE, root: '/node/env' }), envOnly, 'env', NOW), 'but env is allowed');
  assert.equal(covered(policy, NODE, '/node/env', 'fresh', NOW), true);
  assert.equal(covered(policy, NODE, '/node/other', 'fresh', NOW), false);
});

test('the rule summary shows where rules apply and whether they limit use', () => {
  const projects: SecretProject[] = [{ id: 'p', name: 'P', bindings: [{ hostId: HOST, root: '/work/repo' }, { hostId: NODE, root: '/node/repo' }] }];
  const groups: SecretGroup[] = [{ id: 'g', name: 'G', scope: 'global' }, { id: 'pg', name: 'PG', scope: 'project', projectId: 'p' }];
  const rule = (patch: Partial<SecretRule>): SecretRule => ({ id: String(Math.random()), groupId: 'g', secretIds: ['s'], hostId: HOST, activation: 'manual', operations: [...SECRET_OPERATIONS], enabled: true, revision: 1, ...patch });
  const key = secret('s', { groupId: 'g' });
  const summary = (rules: SecretRule[], item = key) => legacySummary({ projects, groups, rules }, item, NOW);
  assert.deepEqual(summary([]), { global: [], folders: [], limited: false });
  assert.deepEqual(summary([rule({ allProjects: true })]), { global: [{ hostId: HOST }], folders: [], limited: false });
  assert.deepEqual(summary([rule({ hostId: NODE, projectId: 'p' })]), { global: [], folders: [{ hostId: NODE, root: '/node/repo' }], limited: false });
  assert.deepEqual(summary([rule({ root: '/x', operations: ['env'] })]), { global: [], folders: [{ hostId: HOST, root: '/x' }], limited: true });
  assert.deepEqual(summary([rule({ root: '/x', enabled: false }), rule({ root: '/y', expiresAt: NOW })]), { global: [], folders: [], limited: false });
  assert.deepEqual(summary([rule({ root: '/x', maxTtlMs: 5 }), rule({ allProjects: true })]).limited, true);
  assert.deepEqual(summary([rule({ groupId: 'pg', root: '/elsewhere' }), rule({ groupId: 'pg', root: '/work/repo' })], secret('s', { groupId: 'pg' })).folders, [{ hostId: HOST, root: '/work/repo' }], 'a project group stays inside its project');
});

/** Deterministic pseudo-random numbers, so a failure reproduces from its seed. */
function random(seed: number) {
  let value = seed >>> 0;
  const next = () => { value = (value + 0x6D2B79F5) >>> 0; let t = value; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T,>(items: readonly T[]): T => items[int(items.length)]!;
  const chance = (p: number) => next() < p;
  const subset = <T,>(items: readonly T[], p = 0.5) => items.filter(() => chance(p));
  return { int, pick, chance, subset };
}

/** A rule set built the way owners and older builds built them: duplicates, overlaps, project and root rules, task groups, field selections. */
function scenario(seed: number) {
  const r = random(seed);
  const hosts = [HOST, NODE], roots = ['/a', '/b', '/c'];
  const subject = task({ hostId: r.pick(hosts), root: r.pick(roots), createdAt: NOW - r.int(1000) });
  const projects: SecretProject[] = [{ id: 'p0', name: 'P0', bindings: [] }, { id: 'p1', name: 'P1', bindings: [] }];
  for (const hostId of hosts) for (const root of roots) if (r.chance(0.6)) r.pick(projects).bindings.push({ hostId, root });
  const groups: SecretGroup[] = [{ id: 'g0', name: 'G0', scope: 'global' }, { id: 'g1', name: 'G1', scope: 'global' }, { id: 'pg0', name: 'PG0', scope: 'project', projectId: 'p0' }, { id: 'pg1', name: 'PG1', scope: 'project', projectId: r.pick(['p1', 'missing']) },
    { id: 'tg', name: 'TG', scope: 'task', taskId: r.pick([subject.id, 'other-task']) }];
  const secrets: PolicySecret[] = Array.from({ length: 1 + r.int(4) }, (_unused, index) => {
    const fieldNames = r.chance(0.4) ? ['A', 'B', 'C'] : undefined;
    return secret(`s${index}`, { groupId: r.pick(groups).id, version: 1 + r.int(3), ...(r.chance(0.15) ? { expiresAt: r.pick([NOW, NOW + 1]) } : {}) }, fieldNames ? { fieldNames } : {});
  });
  const rules: SecretRule[] = [];
  for (let index = r.int(8); index > 0; index--) {
    const owner = r.pick(secrets), groupId = r.chance(0.8) ? owner.metadata.groupId : r.pick(groups).id;
    const fields = r.chance(0.3) ? Object.fromEntries(r.subset(secrets).map(item => [item.metadata.id, r.pick([['A'], ['A', 'B'], ['A', 'A'], ['Z'], [], ['C', 'B', 'A']])])) : undefined;
    const rule: SecretRule = { id: `r${index}`, groupId, secretIds: [...new Set([owner.metadata.id, ...r.subset(secrets.map(item => item.metadata.id), 0.3)])], hostId: r.chance(0.8) ? subject.hostId : r.pick(hosts),
      ...(r.chance(0.35) ? { projectId: r.pick(['p0', 'p1', 'missing']) } : {}), ...(r.chance(0.3) ? { allProjects: true } : {}), ...(r.chance(0.35) ? { root: r.pick(roots) } : {}),
      activation: r.pick(['manual', 'auto'] as const), operations: (() => { const picked = r.subset(SECRET_OPERATIONS, 0.6); return picked.length ? picked : ['discover' as const]; })(),
      ...(fields ? { fields } : {}), ...(r.chance(0.2) ? { maxTtlMs: 1000 + r.int(5000) } : {}), ...(r.chance(0.15) ? { expiresAt: r.pick([NOW, NOW + 1]) } : {}), enabled: r.chance(0.85), revision: 1 + r.int(3) };
    rules.push(rule);
    if (r.chance(0.15)) rules.push({ ...structuredClone(rule), id: `${rule.id}-again` });
  }
  if (r.chance(0.2)) subject.excluded.push(r.pick(secrets).metadata.id);
  return { subject, policy: state(secrets, { projects, groups, rules, tasks: [subject] }) };
}

test('the rule policy decides as 1.130.2 did with every rule automatic and its grant issued at first use', () => {
  let allowed = 0, denied = 0;
  for (let seed = 1; seed <= 4000; seed++) {
    const { subject, policy } = scenario(seed);
    const before = { ...policy, rules: policy.rules.map(rule => ({ ...rule, activation: 'auto' as const })), grants: [] as oracle.PolicyGrant[] };
    const issue: oracle.Automatic = (t, s, r) => { const grant = { taskId: t.id, secretId: s.metadata.id, version: s.metadata.version, ruleId: r.id, revision: r.revision, deadline: r.maxTtlMs === undefined ? undefined : NOW + r.maxTtlMs }; before.grants.push(grant); return grant; };
    for (const item of policy.secrets) for (const operation of SECRET_OPERATIONS) {
      let expected: string[] | undefined | false;
      try { const rule = oracle.authorize(before, subject, item, operation, NOW, issue); expected = oracle.selectedFields(item, rule); } catch { expected = false; }
      const decision = decide(policy, subject, item, operation, NOW);
      assert.deepEqual(decision ? decision.fields : false, expected, `seed ${seed}, ${item.metadata.id}, ${operation}`);
      if (decision) { assert.deepEqual(decision.basis, ['legacy'], `seed ${seed}`); allowed++; } else denied++;
    }
    const listed = oracle.discoverable(structuredClone(before), subject, NOW, 'assume').map(({ activation: _activation, ...item }) => item);
    assert.deepEqual(available(policy, subject, NOW).map(({ basis: _basis, ...item }) => item), listed, `seed ${seed}: listing`);
  }
  assert.ok(allowed > 2000 && denied > 2000, `both outcomes are exercised (${allowed} allowed, ${denied} denied)`);
});
