import test from 'node:test';
import assert from 'node:assert/strict';
import type { SlackWorkflow } from '../../../shared/slack.js';
import { slackChatSelection, slackCoordinatorSessionIds } from '../../../client/src/slack/slack-chat-selection.js';

function workflow(id: string, sessionId?: string, mode?: 'conversation'): SlackWorkflow {
  return { id, sessionId, mode, status: 'running', createdAt: '', updatedAt: '', rules: [], mention: { id, teamId: '', channel: '', user: '', ts: '', threadTs: '', text: '' } };
}
const events = [workflow('chat', 'coordinator', 'conversation'), workflow('pending', undefined, 'conversation'), workflow('legacy', 'work-session')];

test('Slack conversation selection opens writable native chat while pending and legacy use details', () => {
  assert.deepEqual(slackChatSelection(events, 'chat', null), { mentionId: 'chat', chatId: 'coordinator' });
  for (const mentionId of ['pending', 'legacy', 'missing', null]) assert.deepEqual(slackChatSelection(events, mentionId, null), { mentionId, chatId: null });
  assert.deepEqual(slackChatSelection(events, undefined, 'ordinary'), { mentionId: undefined, chatId: 'ordinary' });
});

test('direct native session navigation resolves coordinator highlight without capturing legacy work sessions', () => {
  assert.deepEqual(slackChatSelection(events, undefined, 'coordinator'), { mentionId: 'chat', chatId: 'coordinator' });
  assert.deepEqual(slackChatSelection(events, undefined, 'work-session'), { mentionId: undefined, chatId: 'work-session' });
  assert.deepEqual(slackChatSelection(events, null, 'coordinator'), { mentionId: null, chatId: null });
  assert.deepEqual([...slackCoordinatorSessionIds(events)], ['coordinator']);
});
