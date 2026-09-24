import test from 'node:test';
import assert from 'node:assert/strict';
import { overlapsRepository, pullBlocker, pushBlocker, type RepositoryStatus } from '../../shared/repositories.js';

const status = (patch: Partial<RepositoryStatus> = {}): RepositoryStatus => ({
  cwd: '/work/app', root: '/work/app', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0, checkedAt: '2026-09-24T00:00:00.000Z', ...patch,
});

test('a branch fast-forwards only when it is behind with nothing of its own and nobody working there', () => {
  assert.equal(pullBlocker(status({ behind: 3 }), false), undefined);
  assert.equal(pullBlocker(status(), false), 'up-to-date');
  assert.equal(pullBlocker(status({ behind: 3, ahead: 1 }), false), 'diverged');
  assert.equal(pullBlocker(status({ behind: 3, changes: 2 }), false), 'changes');
  assert.equal(pullBlocker(status({ behind: 3 }), true), 'busy');
  assert.equal(pullBlocker(status({ behind: 3, branch: undefined }), false), 'detached');
  assert.equal(pullBlocker(status({ behind: 3, upstream: undefined }), false), 'no-upstream');
});

test('pushing is offered only for local commits on a branch that is not behind', () => {
  assert.equal(pushBlocker(status({ ahead: 2 })), undefined);
  assert.equal(pushBlocker(status({ ahead: 2, changes: 4 })), undefined);
  assert.equal(pushBlocker(status()), 'nothing');
  assert.equal(pushBlocker(status({ ahead: 2, behind: 1 })), 'behind');
  assert.equal(pushBlocker(status({ ahead: 2, upstream: undefined })), 'no-upstream');
});

test('work in the folder, below it, anywhere in its working tree or above it counts as touching the repository', () => {
  const repository = { cwd: '/work/app/web', root: '/work/app' };
  assert.equal(overlapsRepository(repository, '/work/app/web'), true);
  assert.equal(overlapsRepository(repository, '/work/app/server'), true);
  assert.equal(overlapsRepository(repository, '/work'), true);
  assert.equal(overlapsRepository(repository, '/work/app-worktree'), false);
  assert.equal(overlapsRepository(repository, '/elsewhere'), false);
});
