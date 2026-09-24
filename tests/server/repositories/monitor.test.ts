import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryMonitor, watchedRepositoryPaths } from '../../../server/repositories/monitor.js';
import { gitRunner, parseStatus } from '../../../server/repositories/git.js';
import type { RepositoryStatus } from '../../../shared/repositories.js';
import type { ProjectGroup, Session } from '../../../shared/types.js';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
const commit = async (cwd: string, file: string, text: string) => { await writeFile(join(cwd, file), text); git(cwd, 'add', file); git(cwd, 'commit', '-qm', text); };

/** A remote, the monitored clone, and another clone that publishes new commits. */
async function repositories(t: test.TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'tower-repositories-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = join(dir, 'origin.git'); const work = join(dir, 'work'); const other = join(dir, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });
  execFileSync('git', ['clone', '-q', remote, other], { env, stdio: 'pipe' });
  git(other, 'checkout', '-qb', 'main');
  await commit(other, 'a.txt', 'first');
  git(other, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, work], { env });
  return { dir, remote, work, other };
}

function monitor(work: string, options: { busy?: boolean } = {}) {
  let changes = 0;
  const repositories = new RepositoryMonitor({ watched: () => [work], busy: () => options.busy ?? false, onChange: () => { changes++; }, git: gitRunner(env) });
  return { repositories, changes: () => changes };
}

test('git status output yields branch, upstream, ahead/behind and tracked changes only', () => {
  assert.deepEqual(parseStatus('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -5\n1 .M N... 100644 100644 100644 a b file\nu UU N... x\n? new.txt\n'),
    { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 5, changes: 2 });
  assert.deepEqual(parseStatus('# branch.oid abc\n# branch.head (detached)\n'), { ahead: 0, behind: 0, changes: 0 });
});

test('before work starts, a branch that is only behind is fast-forwarded and the badge records it', async t => {
  const { work, other } = await repositories(t);
  await commit(other, 'b.txt', 'second'); await commit(other, 'c.txt', 'third');
  git(other, 'push', '-q');
  const { repositories: monitored, changes } = monitor(work);
  await monitored.prepareRun(work);
  assert.equal(git(work, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
  const [status] = monitored.list();
  assert.equal(status.behind, 0);
  assert.equal(status.lastAction?.kind, 'auto-pull');
  assert.equal(status.lastAction?.commits, 2);
  assert.ok(status.fetchedAt);
  assert.ok(changes() > 0);
  assert.equal(existsSync(join(work, '.git', 'FETCH_HEAD')), false, 'an agent’s own pull never sees Tower’s fetch in FETCH_HEAD');
});

test('nothing moves when the branch has its own commits, uncommitted edits, or an agent at work', async t => {
  for (const setup of ['diverged', 'changes', 'busy'] as const) {
    const { work, other } = await repositories(t);
    await commit(other, 'b.txt', 'remote');
    git(other, 'push', '-q');
    if (setup === 'diverged') await commit(work, 'local.txt', 'local');
    if (setup === 'changes') await writeFile(join(work, 'a.txt'), 'edited');
    const before = git(work, 'rev-parse', 'HEAD');
    const { repositories: monitored } = monitor(work, { busy: setup === 'busy' });
    await monitored.prepareRun(work);
    assert.equal(git(work, 'rev-parse', 'HEAD'), before, setup);
    const [status] = monitored.list();
    assert.equal(status.behind, 1, setup);
    assert.equal(status.lastAction, undefined, setup);
    await assert.rejects(monitored.act(work, 'pull'), (error: Error & { statusCode?: number }) => error.statusCode === 409, setup);
  }
});

test('the owner pushes local commits to the tracked branch without forcing, and a behind branch is refused', async t => {
  const { work, other, remote } = await repositories(t);
  await commit(work, 'mine.txt', 'mine');
  const { repositories: monitored } = monitor(work);
  const pushed: RepositoryStatus = await monitored.act(work, 'push');
  assert.equal(pushed.ahead, 0);
  assert.deepEqual({ kind: pushed.lastAction?.kind, ok: pushed.lastAction?.ok, commits: pushed.lastAction?.commits }, { kind: 'push', ok: true, commits: 1 });
  assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { env, encoding: 'utf8' }), git(work, 'rev-parse', 'HEAD'));

  await commit(work, 'more.txt', 'more');
  git(other, 'pull', '-q'); await commit(other, 'theirs.txt', 'theirs'); git(other, 'push', '-q');
  await monitored.act(work, 'refresh');
  await assert.rejects(monitored.act(work, 'push'), (error: Error & { statusCode?: number }) => error.statusCode === 409);
});

test('folders outside git and folders Tower does not track are left alone', async t => {
  const { dir } = await repositories(t);
  const plain = join(dir, 'plain');
  execFileSync('mkdir', [plain]);
  const { repositories: monitored } = monitor(plain);
  await monitored.prepareRun(plain);
  await monitored.tick();
  assert.deepEqual(monitored.list(), []);
  await assert.rejects(monitored.act(join(dir, 'unknown'), 'refresh'), (error: Error & { statusCode?: number }) => error.statusCode === 404);
});

test('pinned folders and folders with a session from the last week are watched, but not hidden, temporary or agent-launched ones', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const session = (cwd: string, updatedAt: string, patch: Partial<Session> = {}) => ({ cwd, updatedAt, ...patch }) as Session;
  const groups: ProjectGroup[] = [{ cwd: '/work/pinned', title: '', pinned: true }, { cwd: '/work/hidden', title: '', pinned: false, hidden: true }];
  assert.deepEqual(watchedRepositoryPaths([
    session('/work/recent', '2026-09-24T11:00:00Z'), session('/work/older', '2026-09-20T11:00:00Z'), session('/work/stale', '2026-09-01T00:00:00Z'),
    session('/work/hidden', '2026-09-24T11:00:00Z'), session('/tmp/scratch', '2026-09-24T11:00:00Z'), session('/work/exec', '2026-09-24T11:00:00Z', { launchedByAgent: true }),
  ], groups, now), ['/work/pinned', '/work/recent', '/work/older']);
});
