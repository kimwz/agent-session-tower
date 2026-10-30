import test from 'node:test';
import assert from 'node:assert/strict';
import { githubIssueAddress } from '../../../shared/todo/github-issue.js';

test('a title that is only a GitHub issue address names the issue; anything else is an ordinary title', () => {
  const issue = { repo: 'planetarium/verse8-orchestrator', number: 30 };
  for (const text of ['https://github.com/planetarium/verse8-orchestrator/issues/30', '  http://www.github.com/planetarium/verse8-orchestrator/issues/30/  ',
    'github.com/planetarium/verse8-orchestrator/issues/30#issuecomment-1', 'https://github.com/planetarium/verse8-orchestrator/issues/30?q=1']) assert.deepEqual(githubIssueAddress(text), issue, text);
  for (const text of ['Review https://github.com/a/b/issues/3', 'https://github.com/a/b/issues/3 later', 'https://github.com/a/b/pull/3', 'https://github.com/a/b/issues',
    'https://github.com/a/b/issues/0', 'https://gitlab.com/a/b/issues/3', 'https://github.com/a/b/c/issues/3', 'https://github.com.evil.io/a/b/issues/3']) assert.equal(githubIssueAddress(text), undefined, text);
});
