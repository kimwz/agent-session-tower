import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlackReplyProposals } from '../../../client/src/slack/SlackReplyProposals.js';
import type { SlackWorkflow } from '../../../shared/slack.js';

const render = (replies: SlackWorkflow['replies']) => renderToStaticMarkup(createElement(SlackReplyProposals, { token: 'test-token', workflow: { id: 'mention', mode: 'conversation', replies } as SlackWorkflow }));

test('reply candidates are numbered and each requires explicit approval of visible escaped text', () => {
  const html = render(['First <script>', 'Second', 'Third'].map((text, index) => ({ requestKey: String(index), text, status: 'proposed' })));
  assert.match(html, /<ol>/);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.equal((html.match(/이 내용으로 Slack에 전송/g) || []).length, 3);
  assert.match(html, /First &lt;script&gt;/);
  assert.match(html, /수정은 아래 채팅에서 요청/);
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
