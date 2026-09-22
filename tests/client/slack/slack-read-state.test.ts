import test from 'node:test';
import assert from 'node:assert/strict';
import type { SlackWorkflow } from '../../../shared/slack.js';
import { readSlackState, slackCardState, slackCompletionRevision } from '../../../client/src/slack/slack-read-state.js';
const event: SlackWorkflow = { id: 'm1', status: 'completed', runId: 'r1', createdAt: 'first', updatedAt: 'now', rules: [], mention: { id: 'm1', teamId: 't', channel: 'c', user: 'u', ts: '1', threadTs: '1', text: 'hello' } };
test('completion revision ignores incidental saves but tracks new results', () => {
  const revision = slackCompletionRevision(event);
  assert.ok(revision);
  assert.equal(slackCompletionRevision({ ...event, updatedAt: 'later', ownerReplySelection: { requestKey: 'a', text: 'x' } }), revision);
  assert.notEqual(slackCompletionRevision({ ...event, runId: 'r2' }), revision);
  assert.notEqual(slackCompletionRevision({ ...event, replies: [{ requestKey: 'a', text: 'new', status: 'proposed' }] }), revision);
  assert.equal(slackCompletionRevision({ ...event, status: 'running' }), '');
});
test('sending or approving an existing proposal does not create unread completion', () => {
  const proposal = { requestKey: 'a', text: 'ok', status: 'proposed' as const };
  assert.equal(slackCompletionRevision({ ...event, replies: [proposal] }), slackCompletionRevision({ ...event, reply: proposal.text, replyTs: '2', replies: [{ ...proposal, status: 'sent', ts: '2' }] }));
});
test('busy and new unread result take precedence over an earlier sent response', () => {
  const sent = { ...event, replyTs: '2' };
  assert.equal(slackCardState({ ...sent, status: 'running' }, true), 'working');
  assert.equal(slackCardState(sent, true), 'unread');
  assert.equal(slackCardState(sent, false), 'replied');
  assert.equal(slackCardState(event, false), '');
  assert.equal(slackCardState({ ...event, replies: [{ requestKey: 'a', text: 'x', status: 'uncertain' }] }, false), '');
});
test('read state survives reload and rejects malformed storage', () => {
  const revision = slackCompletionRevision(event);
  assert.equal(readSlackState(JSON.stringify({ m1: revision })).m1, revision);
  assert.deepEqual(readSlackState('{oops'), {});
  assert.deepEqual(readSlackState('["a"]'), {});
  assert.deepEqual(readSlackState('{"m1":true,"m2":"yes"}'), { m2: 'yes' });
});
