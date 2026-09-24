import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Message } from '../../../client/src/chat/Message.js';
import { pinnedMessageId } from '../../../client/src/chat/PinnedPrompt.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';
import type { ChatMessage } from '../../../shared/types.js';

/** A chat whose messages sit at given offsets below its top while it is scrolled by `scroll`. */
function chat(messages: Array<{ id: string; top: number; height: number }>, scroll: number) {
  const box = (top: number, height: number) => ({ top: top - scroll, bottom: top - scroll + height });
  return {
    getBoundingClientRect: () => box(scroll, 600),
    querySelectorAll: () => messages.map(message => ({ dataset: { userMessage: message.id }, getBoundingClientRect: () => box(message.top, message.height) })),
  } as unknown as HTMLElement;
}

test('the message pinned at the top is your last one that has gone out of sight above what you are reading', () => {
  const messages = [{ id: 'first', top: 0, height: 80 }, { id: 'second', top: 2000, height: 80 }];
  assert.equal(pinnedMessageId(chat(messages, 0)), undefined, 'nothing is pinned while the message itself shows');
  assert.equal(pinnedMessageId(chat(messages, 30)), undefined, 'a message still readable at the top is not pinned');
  assert.equal(pinnedMessageId(chat(messages, 60)), 'first', 'one showing only a sliver is');
  assert.equal(pinnedMessageId(chat(messages, 500)), 'first');
  assert.equal(pinnedMessageId(chat(messages, 1990)), 'first', 'until the next message reaches the top');
  assert.equal(pinnedMessageId(chat(messages, 2020)), undefined, 'the next message showing replaces it');
  assert.equal(pinnedMessageId(chat(messages, 5000)), 'second');
  assert.equal(pinnedMessageId(chat([], 5000)), undefined);
});

test('your messages are marked for pinning, and a background task notice is labelled as one', () => {
  const language = getLanguage();
  try {
    setLanguage('ko');
    const user: ChatMessage = { id: 'u1', role: 'user', text: 'Fix the build', timestamp: '2026-09-24T00:00:00.000Z' };
    assert.match(renderToStaticMarkup(createElement(Message, { message: user })), /data-user-message="u1"/);
    const agent: ChatMessage = { ...user, id: 'a1', role: 'assistant' };
    assert.doesNotMatch(renderToStaticMarkup(createElement(Message, { message: agent })), /data-user-message/);
    const notice: ChatMessage = { id: 'n1', role: 'system', toolName: 'Background task', text: '**completed** · Checks finished', timestamp: user.timestamp };
    assert.match(renderToStaticMarkup(createElement(Message, { message: notice })), /백그라운드 작업/);
  } finally { setLanguage(language); }
});
