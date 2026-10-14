import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export function testedInput(cwd = '.', prepared = true) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const status = git(['status', '--porcelain', '--untracked-files=normal', '--ignored']);
  const unexpected = status.split('\n').filter(line => line && !(prepared && /^!! (node_modules|dist|artifacts)\/$/.test(line)));
  assert.deepEqual(unexpected, [], 'uncommitted/untracked/unknown ignored inputs invalidate validation');
  return { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), dirty: false };
}
