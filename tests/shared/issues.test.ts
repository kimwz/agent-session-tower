import test from 'node:test';
import assert from 'node:assert/strict';
import { ISSUE_SKILL, issueRequest } from '../../shared/issues.js';
import { masterGuide } from '../../server/master/guide.js';

test('an issue request names the shared skill, defers to the project’s own way, and carries the owner’s words last', () => {
  const request = issueRequest('  로그인 버튼이\n모바일에서 안 눌린다  ');
  assert.match(request, new RegExp(`following the ${ISSUE_SKILL} skill`));
  assert.match(request, /its own issue skill or instructions/);
  assert.match(request, /Without the skill:/, 'still workable on a computer without the skill');
  assert.match(request, /Do not change, commit or push code/);
  assert.ok(request.endsWith('Issue:\n로그인 버튼이\n모바일에서 안 눌린다'));
});

test('the master may register issues without confirming, with the same request the folder button sends', () => {
  const guide = masterGuide();
  assert.match(guide, /You may register issues whenever the owner asks, without confirming/);
  assert.ok(guide.includes(issueRequest('<the issue as the owner described it>')));
});
