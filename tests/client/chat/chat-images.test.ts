import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Message } from '../../../client/src/chat/Message.js';
import { ChatTranscript } from '../../../client/src/chat/ChatTranscript.js';
import { scopeDetail } from '../../../client/src/remote/scope.js';
import type { ChatMessage, SessionDetail } from '../../../shared/types.js';
const image = { source: '/project/icon.png', name: 'icon.png', url: '/api/chat-images/signed' };
const message: ChatMessage = { id: 'm', role: 'assistant', text: `![Icon](${image.source})`, timestamp: '', images: [image] };
test('Markdown images render inline once with lazy loading and a full-size link', () => {
  const html = renderToStaticMarkup(createElement(Message, { message }));
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /src="\/api\/chat-images\/signed"/);
  assert.match(html, /loading="lazy"/); assert.match(html, /alt="Icon"/);
  assert.doesNotMatch(html, /src="\/project/);
});
test('plain image file links get previews and generated tool previews are visible while collapsed', () => {
  const linked = renderToStaticMarkup(createElement(Message, { message: { ...message, text: `[Icon](${image.source})` } }));
  assert.match(linked, /<img /);
  const html = renderToStaticMarkup(createElement(ChatTranscript, { messages: [{ ...message, role: 'tool', text: 'Generated image saved', toolName: 'result' }] }));
  assert.match(html, /<img /); assert.doesNotMatch(html, /<details[^>]* open/);
});
test('joined computer image requests are scoped to that computer', () => {
  const node = 'a'.repeat(32);
  const result = scopeDetail(node, { session: { id: 's', cwd: '/project' }, messages: [message], hasMore: false } as SessionDetail);
  assert.equal(result.messages[0].images![0].url, `/api/nodes/${node}/chat-images/signed`);
});

test('refreshed capabilities replace stale image URLs after a web restart', async () => {
  const { mergeLatestPage } = await import('../../../client/src/chat/chat-history.js');
  const page = { session: { id: 's', messageCount: 1 }, messages: [message], hasMore: false } as SessionDetail;
  const next = { ...page, messages: [{ ...message, images: [{ ...image, url: '/api/chat-images/renewed' }] }] };
  assert.equal(mergeLatestPage(page, next).messages[0].images![0].url, '/api/chat-images/renewed');
});
