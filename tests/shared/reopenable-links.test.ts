import test from 'node:test';
import assert from 'node:assert/strict';
import { isChatImageLink, isReopenableLink, linkToOpen, loginThenOpen } from '../../shared/reopenable-links.js';

test('only links exactly as Tower hands them out open again or after signing in', () => {
  const image = `/api/chat-images/${'a'.repeat(20)}.${'b'.repeat(43)}`;
  for (const link of [image, `/api/nodes/${'c'.repeat(32)}${image.slice(4)}`, '/api/todos/files/0b6c2f6e-1d2a-4e1b-9a55-3c1f8b7e2d10', '/api/todos/files/0b6c2f6e-1d2a-4e1b-9a55-3c1f8b7e2d10?inline=1']) {
    assert.ok(isReopenableLink(link), link);
  }
  assert.ok(isChatImageLink(image));
  assert.equal(isChatImageLink('/api/todos/files/x'), false);
  for (const link of ['https://example.com/api/todos/files/x', '//example.com/api/todos/files/x', '/api/todos/files/x?inline=1&y', '/api/todos/files/x?inline=0',
    '/api/todos/files/%2e%2e', '/api/todos/files/a/b', '/api/todos', '/api/todos/uploads/x', `/api/todos/files/${'x'.repeat(65)}`, '/api/attachments/x', `${image}?x`, 'javascript:alert(1)']) {
    assert.equal(isReopenableLink(link), false, link);
  }
});

test('the sign-in page opens the link it was sent with, and drops it from its address', () => {
  const link = '/api/todos/files/0b6c2f6e-1d2a-4e1b-9a55-3c1f8b7e2d10?inline=1';
  const address = loginThenOpen(link);
  assert.equal(address, `/?open=${encodeURIComponent(link)}`);
  assert.deepEqual(linkToOpen(address.slice(1)), { link, rest: '' });
  assert.deepEqual(linkToOpen(`?view=todo&open=${encodeURIComponent(link)}`), { link, rest: '?view=todo' });
  for (const search of ['', '?view=todo', `?open=${encodeURIComponent('https://example.com/x')}`, `?open=${encodeURIComponent('//example.com/api/todos/files/x')}`, '?open=javascript%3Aalert(1)']) {
    assert.equal(linkToOpen(search), null, search);
  }
});
