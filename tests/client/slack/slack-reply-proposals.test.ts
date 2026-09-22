import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlackReplyProposals } from '../../../client/src/slack/SlackReplyProposals.js';
import { slackChatSelection } from '../../../client/src/slack/slack-chat-selection.js';
import type { SlackWorkflow } from '../../../shared/slack.js';

const render = (replies: SlackWorkflow['replies']) => renderToStaticMarkup(createElement(SlackReplyProposals, { token: 'test-token', workflow: { id: 'mention', mode: 'conversation', replies } as SlackWorkflow }));

test('reply candidates are numbered and each requires explicit approval of visible escaped text', () => {
  const html = render(['First <script>', 'Second', 'Third'].map((text, index) => ({ requestKey: String(index), text, status: 'proposed' })));
  assert.match(html, /<ol>/);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.equal((html.match(/이 내용으로 Slack에 전송/g) || []).length, 3);
  assert.match(html, /First &lt;script&gt;/);
  assert.match(html, /3번 답변을 Slack에 보내주세요/);
  assert.match(html, /답변 수정도 채팅에서 요청/);
  assert.equal(render(undefined), '');
});

test('sending, sent and uncertain replies cannot be submitted again from the proposal panel', () => {
  for (const status of ['sending', 'sent', 'uncertain'] as const) {
    const html = render([{ requestKey: 'one', text: 'Reply', status }]);
    assert.doesNotMatch(html, /<button/);
    assert.match(html, /role="status"/);
    if (status === 'uncertain') {
      assert.match(html, /원본 Slack 스레드를 확인/);
      assert.doesNotMatch(html, /Slack에 전송됨/);
    }
  }
});


test('direct coordinator navigation renders persisted reply approval controls after Slack data arrives', () => {
  const sessionId = 'claude:coordinator';
  assert.equal(slackChatSelection([], undefined, sessionId).chatId, sessionId);
  const workflow = { id: 'mention', mode: 'conversation', sessionId, replies: [{ requestKey: 'option-1', text: 'Approved candidate', status: 'proposed' }] } as SlackWorkflow;
  const events = [workflow];
  const selection = slackChatSelection(events, undefined, sessionId);
  const html = renderToStaticMarkup(createElement(SlackReplyProposals, { token: 'test-token', workflow: events.find(event => event.id === selection.mentionId) }));
  assert.equal(selection.chatId, sessionId);
  assert.match(html, /Approved candidate/);
  assert.match(html, /이 내용으로 Slack에 전송/);
});
