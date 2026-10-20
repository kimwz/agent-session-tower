import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachmentList } from '../../../client/src/todo/attachments/Attachments.js';
import type { TodoFile } from '../../../shared/todo/types.js';

const file = (id: string, name: string, mimeType: string): TodoFile => ({ id, taskId: 't', commentId: 'c', name, mimeType, size: 10, sha256: '0'.repeat(64), createdAt: '2026-10-20T00:00:00.000Z', deletedAt: null });

test('a picture in a comment opens in the viewer over the page, not in a new window', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentList, { files: [file('a', 'before.png', 'image/png'), file('b', 'after.png', 'image/png'), file('n', 'notes.txt', 'text/plain')] }));
  assert.equal((markup.match(/<button type="button" class="todo-file-thumb"/g) ?? []).length, 2);
  assert.ok(markup.includes('src="/api/todos/files/a?inline=1"'));
  assert.ok(markup.includes('aria-label="“before.png” 크게 보기"'));
  assert.equal(markup.includes('target="_blank"'), false);
  // Downloads stay downloads.
  assert.ok(markup.includes('href="/api/todos/files/a" download="before.png"'));
  assert.ok(markup.includes('href="/api/todos/files/n" download="notes.txt"'));
});
