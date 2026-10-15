import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classify, ciScope, gatePassed, pathTier, planCi, reuseEvidence, versionOnly, GATE } from '../../scripts/ci-scope.mjs';
import { gateVerdict, rereadClaims } from '../../scripts/ci-gate.mjs';
import { lanesFor, plan } from '../../scripts/ci-plan.mjs';

const real = (path: string) => readFileSync(path, 'utf8');
const pkg = real('package.json'), lock = real('package-lock.json'), identity = real('shared/app-identity.ts');
const version = JSON.parse(pkg).version as string;
const [major, minor, patch] = version.split('.').map(Number);
const bumpJson = (text: string, to: string, lockfile = false) => {
  const value = JSON.parse(text);
  value.version = to;
  if (lockfile) value.packages[''].version = to;
  return `${JSON.stringify(value, null, 2)}\n`;
};
const bumpIdentity = (to: string) => identity.replace(/APP_VERSION = '[^']*'/, `APP_VERSION = '${to}'`);
/** A change where `head` overrides files of the real tree; a null removes the file. */
const change = (head: Record<string, string | null>, baseGreen = true) => classify({
  changes: Object.keys(head), baseGreen,
  content: (path, side) => side === 'head' && path in head ? head[path] : path === 'package.json' ? pkg : path === 'package-lock.json' ? lock
    : path === 'shared/app-identity.ts' ? identity : side === 'base' || !(path in head) ? 'base text' : head[path],
});
const release = (to: string) => ({ 'package.json': bumpJson(pkg, to), 'package-lock.json': bumpJson(lock, to, true),
  'shared/app-identity.ts': bumpIdentity(to), 'CHANGELOG.md': `## [${to}]\n` });
const nextPatch = `${major}.${minor}.${patch + 1}`;

test('documentation and a patch version bump are quick; anything that runs is not', () => {
  assert.equal(change({ 'docs/development.md': 'x', 'README.md': 'x', 'AGENTS.md': 'x' }).tier, 'quick');
  assert.equal(change(release(nextPatch)).tier, 'quick');
  // A default value in code changes what Tower does, however small.
  assert.equal(change({ 'client/App.tsx': "const days = '7'" }).tier, 'related');
  assert.equal(change({ ...release(nextPatch), 'client/App.tsx': 'x' }).tier, 'related');
  assert.equal(change({ 'tests/client/app.test.ts': 'x' }).tier, 'related');
  assert.equal(change({ 'server/slack/service.ts': 'x' }).tier, 'full', 'server code holds storage, access and lifetime');
  assert.equal(change({ 'shared/triggers.ts': 'x' }).tier, 'full', 'shared code feeds the server');
});

test('server and shared code, sensitive browser views, build and CI, minor or major versions and unknown paths need the full run', () => {
  for (const path of ['server/storage/x.ts', 'tests/server/storage/x.test.ts', 'server/secrets/vault.ts', 'server/runs/worker.ts',
    'server/slack/service.ts', 'server/slack/owner-consent.ts', 'server/triggers/http.ts', 'server/master/voice-turn-end.ts',
    'shared/triggers.ts', 'shared/types.ts', 'tests/master/live-read.test.ts', 'tests/server/slack/service.test.ts',
    'client/src/secrets/SecretsPanel.tsx', 'client/src/auth/AuthGate.tsx', 'client/src/permissions/PermissionsPanel.tsx',
    'client/src/backup/RetentionPanel.tsx', 'tests/client/secrets.test.ts', 'scripts/release.mjs', '.github/workflows/ci.yml',
    'bin/agent-session-tower.mjs', 'tests/helpers/fixture.ts', 'tests/gates/ci-scope.test.ts', 'assets/logo.svg', 'vite.config.ts',
    'tsconfig.json', '.npmrc', 'newdir/file.ts']) {
    assert.equal(pathTier(path).tier, 'full', path);
  }
  for (const path of ['client/src/app/App.tsx', 'client/src/chat/ChatPanel.tsx', 'tests/client/app.test.ts']) assert.equal(pathTier(path).tier, 'related', path);
  assert.match(change(release(`${major}.${minor + 1}.0`)).reasons.join(), /minor or major/);
  assert.equal(change(release(`${major}.${minor + 1}.0`)).tier, 'full');
  assert.equal(change(release(`${major + 1}.0.0`)).tier, 'full');
  assert.equal(change(release(`${major}.${minor}.${patch}`)).tier, 'quick', 'unchanged version');
  assert.equal(change({ 'package.json': bumpJson(pkg, `${major}.${minor}.${Math.max(patch - 1, 0)}`) }).tier, patch ? 'full' : 'quick');
  assert.equal(change({ 'package.json': bumpJson(pkg, 'next') }).tier, 'full');
  // `npm version` checks before it writes the version it was asked for.
  const docs = { changes: ['docs/usage.md'], baseGreen: true, content: (path: string) => path === 'package.json' ? pkg : 'x' };
  assert.equal(classify({ ...docs, nextVersion: nextPatch }).tier, 'quick');
  assert.equal(classify({ ...docs, nextVersion: `${major}.${minor + 1}.0` }).tier, 'full');
});

test('version metadata counts as metadata only when nothing but the version changed', () => {
  const scripts = JSON.parse(bumpJson(pkg, nextPatch));
  scripts.scripts.test = 'true';
  assert.equal(change({ 'package.json': JSON.stringify(scripts) }).tier, 'full');
  const dependency = JSON.parse(bumpJson(lock, nextPatch, true));
  dependency.packages['node_modules/ws'] = { ...dependency.packages['node_modules/ws'], version: '0.0.1' };
  assert.equal(change({ 'package-lock.json': JSON.stringify(dependency) }).tier, 'full');
  assert.equal(change({ 'shared/app-identity.ts': bumpIdentity(nextPatch).replace("'Agent Session Tower'", "'Tower'") }).tier, 'full');
  assert.equal(change({ 'shared/app-identity.ts': `${bumpIdentity(nextPatch)}export const APP_VERSION = '9.9.9';\n` }).tier, 'full');
  assert.equal(change({ 'package.json': null }).tier, 'full', 'a removed package.json');
  assert.equal(versionOnly('package.json', pkg, bumpJson(pkg, nextPatch)), true);
  assert.equal(versionOnly('package.json', pkg, '{'), false);
});

test('a quick change stands on its base: a base without a passed gate needs the full run', () => {
  assert.equal(change({ 'docs/usage.md': 'x' }, false).tier, 'full');
  assert.match(change({ 'docs/usage.md': 'x' }, false).reasons.join(), /base commit has not passed/);
  assert.equal(change({ 'client/App.tsx': 'x' }, false).tier, 'related', 'related does not lean on its base');
});

test('only a completed successful newest gate run passes; pending, skipped, failed and absent do not', () => {
  const run = (id: number, status: string, conclusion: string | null, name = GATE) => ({ id, name, status, conclusion, app: { slug: 'github-actions' } });
  assert.equal(gatePassed([run(1, 'completed', 'success')]).passed, true);
  assert.equal(gatePassed([]).passed, false, '[skip ci] starts no workflow, so no gate');
  for (const [status, conclusion] of [['queued', null], ['in_progress', null], ['completed', 'skipped'], ['completed', 'cancelled'],
    ['completed', 'failure'], ['completed', 'neutral'], ['completed', 'timed_out']] as const) {
    assert.equal(gatePassed([run(1, status, conclusion)]).passed, false, `${status}/${conclusion}`);
  }
  assert.equal(gatePassed([run(1, 'completed', 'success'), run(2, 'in_progress', null)]).passed, false, 'a rerun in progress');
  assert.equal(gatePassed([run(1, 'completed', 'failure'), run(2, 'completed', 'success')]).passed, true, 'a rerun that passed');
  assert.equal(gatePassed([run(1, 'completed', 'success', 'checks')]).passed, false, 'another job is not the gate');
  assert.equal(gatePassed([{ ...run(1, 'completed', 'success'), app: { slug: 'other-app' } }]).passed, false);
});

const sha = 'a'.repeat(40), tree = 't'.repeat(40);
function run(tier: string, overrides: Record<string, unknown> = {}) {
  const reuse = tier === 'reused';
  const lanes = plan(), selected = reuse ? [] : lanesFor(tier, lanes);
  const receipts: any[] = selected.map(l => ({ id: l.id, sha, node: l.node, platform: l.os.startsWith('mac') ? 'darwin' : 'linux',
    files: l.files, exit: 0, large: l.large, started: 1000, finished: 2000, sea: l.sea, benchmark: l.benchmark, foundation: l.foundation,
    arch: 'arm64', pathNode: l.node, input: { commit: sha, tree, dirty: false },
    ...(l.large || l.files.some(f => f.endsWith('retention-storage.test.ts')) ? { cap: { canonicalBytes: l.large ? 133_000_000 : 33_000_000, count: l.large ? 6_000_000 : 1_500_000 } } : {}) }));
  receipts.push({ id: 'checks', sha, exit: 0, quick: true, legacyNode: '22.13.0', input: { commit: sha, tree, dirty: false }, started: 1000, finished: 1500 });
  return { needs: { plan: { result: 'success' }, checks: { result: 'success' }, test: { result: selected.length ? 'success' : 'skipped' } },
    planned: { tier: reuse ? 'full' : tier, execution: reuse ? 'reuse' : 'run', head: sha, tree, lanes: selected.map(l => l.id) }, pathTier: reuse ? 'full' : tier,
    baseGate: { passed: true, reason: 'gate success' }, evidence: { reused: true, reason: 'same tree' }, receipts, sha, tree, lanes, ...overrides };
}
const problems = (input: ReturnType<typeof run>) => gateVerdict(input as any).problems;

test('the gate passes each tier with exactly its lanes', () => {
  for (const tier of ['full', 'related', 'quick', 'reused']) assert.deepEqual(problems(run(tier)), [], tier);
  assert.equal(lanesFor('full').length, 17);
  assert.deepEqual(lanesFor('related').map(l => l.id), ['linux-22-0', 'linux-22-1', 'linux-22-2', 'linux-22-3', 'mac-22-0', 'mac-22-1', 'mac-22-2']);
  assert.deepEqual(lanesFor('quick'), []);
  assert.throws(() => lanesFor('none'));
});

test('the gate fails on skipped, failed, cancelled or missing jobs and on missing or extra results', () => {
  const full = run('full');
  for (const result of ['skipped', 'failure', 'cancelled']) {
    assert.ok(problems({ ...full, needs: { ...full.needs, test: { result } } }).length, `test ${result}`);
    assert.ok(problems({ ...full, needs: { ...full.needs, plan: { result } } }).length, `plan ${result}`);
    assert.ok(problems({ ...full, needs: { ...full.needs, checks: { result } } }).length, `checks ${result}`);
  }
  assert.ok(problems({ ...full, needs: { plan: full.needs.plan, checks: full.needs.checks } as any }).length, 'test job missing');
  const quick = run('quick');
  assert.ok(problems({ ...quick, needs: { ...quick.needs, test: { result: 'success' } } }).length, 'a quick tier never runs lanes');
  assert.ok(problems({ ...quick, needs: { ...quick.needs, test: { result: 'failure' } } }).length);
  assert.ok(problems({ ...full, receipts: full.receipts.slice(1) }).length, 'a lane result missing');
  assert.ok(problems({ ...quick, receipts: [...run('related').receipts.slice(0, 1), ...quick.receipts] }).length, 'an extra lane result');
  assert.ok(problems({ ...full, receipts: full.receipts.filter(r => r.id !== 'checks') }).length, 'checks result missing');
  assert.ok(problems({ ...full, receipts: full.receipts.map(r => r.id === 'checks' ? { ...r, quick: false } : r) }).length, 'quick suite not run');
  assert.ok(problems({ ...full, receipts: full.receipts.map((r, i) => i === 0 ? { ...r, exit: 1 } : r) }).length, 'a failed lane');
  assert.ok(problems({ ...full, receipts: full.receipts.map((r, i) => i === 0 ? { ...r, input: { ...r.input, tree: 'other' } } : r) }).length);
  assert.ok(problems({ ...full, planned: undefined } as any).length, 'no plan record');
  assert.ok(problems({ ...full, planned: { ...full.planned, head: 'b'.repeat(40) } }).length, 'a plan record of another commit');
});

test('the gate refuses a tier below what the files need and unconfirmed quick or reused claims', () => {
  assert.ok(problems(run('related', { pathTier: 'full' })).length, 'related where full is needed');
  assert.ok(problems(run('quick', { pathTier: 'related' })).length, 'quick where related is needed');
  assert.deepEqual(problems(run('full', { pathTier: 'quick' })), [], 'more than needed is allowed');
  assert.ok(problems(run('quick', { baseGate: { passed: false, reason: 'gate in_progress' } })).length, 'base still running');
  assert.ok(problems(run('quick', { baseGate: undefined })).length);
  assert.ok(problems(run('reused', { evidence: { reused: false, reason: 'tree differs' } })).length);
  const reused = run('reused');
  assert.ok(problems({ ...reused, pathTier: 'full', planned: { ...reused.planned, tier: 'related' } }).length, 'a reuse keeps the tier the change needs');
  assert.ok(problems({ ...reused, planned: { ...reused.planned, execution: 'skip' } }).length, 'unknown execution');
  assert.deepEqual(problems({ ...reused, pathTier: 'quick' }), [], 'a quick change raised to full by its base reuses the full result');
  const asked: unknown[] = [];
  const path = { base: 'b'.repeat(40), head: sha, tree };
  const claims = rereadClaims({ planned: { tier: 'full', execution: 'reuse' }, path, repo: 'o/r',
    gate: () => { throw new Error('a reuse does not read the base gate'); }, reuse: input => { asked.push(input.needed); return { reused: true, reason: 'ok' }; } });
  assert.deepEqual(asked, ['full'], 'the reused result is checked at the tier the plan ran, not the quick tier of the files');
  assert.equal(claims.baseGate, undefined);
  assert.equal(rereadClaims({ planned: { tier: 'quick', execution: 'run' }, path, gate: sha => ({ passed: sha === path.base, reason: 'x' }),
    reuse: () => { throw new Error('quick does not reuse'); } }).baseGate?.passed, true);
  const related = run('related');
  assert.ok(problems({ ...related, planned: { ...related.planned, lanes: lanesFor('full').map(l => l.id) } }).length, 'lanes differ from the tier');
});

test('main reuses a pull request result only for the same tree at a tier that covers the change', () => {
  const head = 'm'.repeat(40), prHead = 'p'.repeat(40);
  const api = (record: Record<string, unknown>, runs = [{ id: 7, run_number: 3, run_attempt: 1, status: 'completed', conclusion: 'success' }]) => ({
    api: (path: string) => path.endsWith('/pulls') ? [{ number: 5, merged_at: 'now', merge_commit_sha: head, head: { sha: prHead } }]
      : path.includes('/workflows/ci.yml/runs') ? { workflow_runs: runs } : { artifacts: [{ id: 9, created_at: '1', expired: false }] },
    artifact: () => record,
  });
  const evidence = (record: Record<string, unknown>, needed: any = 'related', runs?: any[]) =>
    reuseEvidence({ head, tree, needed, repo: 'o/r', ...api(record, runs) });
  assert.equal(evidence({ verdict: 'pass', tree, tier: 'full' }, 'full').reused, true);
  assert.equal(evidence({ verdict: 'pass', tree, tier: 'related' }).reused, true);
  assert.equal(evidence({ verdict: 'pass', tree, tier: 'related' }, 'full').reused, false, 'related does not cover full');
  assert.equal(evidence({ verdict: 'pass', tree, tier: 'quick' }, 'quick').reused, false, 'a quick result is not reused');
  assert.equal(evidence({ verdict: 'pass', tree: 'x'.repeat(40), tier: 'full' }).reused, false, 'another tree');
  assert.equal(evidence({ verdict: 'fail', tree, tier: 'full' }).reused, false);
  assert.equal(evidence({ verdict: 'pass', tree, tier: 'full' }, 'related', [
    { id: 7, run_number: 3, run_attempt: 1, status: 'completed', conclusion: 'success' },
    { id: 8, run_number: 4, run_attempt: 1, status: 'completed', conclusion: 'failure' }]).reused, false, 'the newest run failed');
  assert.equal(reuseEvidence({ head, tree, needed: 'full', repo: 'o/r', api: () => { throw new Error('offline'); }, artifact: () => ({}) }).reused, false);
  const scope = { event: 'push', tier: 'full', head, tree, reasons: [] };
  assert.equal(planCi({ scope, repo: 'o/r', ...api({ verdict: 'pass', tree, tier: 'full' }) }).execution, 'reuse');
  assert.equal(planCi({ scope: { ...scope, event: 'pull_request' }, repo: 'o/r', ...api({ verdict: 'pass', tree, tier: 'full' }) }).execution, 'run');
  assert.equal(planCi({ scope, repo: 'o/r', ...api({ verdict: 'pass', tree: 'x', tier: 'full' }) }).execution, 'run');
  assert.equal(planCi({ scope: { ...scope, tier: 'quick' }, repo: 'o/r', ...api({ verdict: 'pass', tree, tier: 'full' }) }).execution, 'run', 'quick runs its own checks');
});

test('CI compares a commit with its first parent and treats a push of several commits as full', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-ci-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const put = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  git('init', '-q');
  for (const [path, text] of Object.entries({ 'package.json': pkg, 'package-lock.json': lock, 'shared/app-identity.ts': identity, 'CHANGELOG.md': '' })) await put(path, text);
  git('add', '.'); git('commit', '-qm', 'base');
  const first = git('rev-parse', 'HEAD');
  for (const [path, text] of Object.entries(release(nextPatch))) await put(path, text);
  git('add', '.'); git('commit', '-qm', 'Release [skip ci]');
  const green = () => ({ passed: true, reason: 'gate success' });
  assert.equal(ciScope({ cwd: root, event: 'pull_request', gate: green }).tier, 'quick');
  assert.equal(ciScope({ cwd: root, event: 'push', before: first, gate: green }).tier, 'quick');
  assert.equal(ciScope({ cwd: root, event: 'pull_request', gate: () => ({ passed: false, reason: 'gate in_progress' }) }).tier, 'full');
  await put('client/App.tsx', 'x'); git('add', '.'); git('commit', '-qm', 'code');
  assert.equal(ciScope({ cwd: root, event: 'push', before: first, gate: green }).tier, 'full', 'two commits pushed at once');
  assert.equal(ciScope({ cwd: root, event: 'pull_request', gate: green }).tier, 'related');
});
