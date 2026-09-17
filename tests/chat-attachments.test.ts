import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addDraftFiles, attachmentUrl, isPreviewableAttachment, prepareDraftAttachments, savedAttachmentDraft } from '../client/src/chat/chat-attachments.js';
import { finishComposerSend, getComposerState, markComposerSending, setComposerDraft, startComposerSend, subscribeComposer } from '../client/src/chat/chat-drafts.js';
import { SavedAttachments } from '../client/src/chat/ChatAttachments.js';
import { ChatTranscript } from '../client/src/chat/ChatPanel.js';
import { matchChatRuns } from '../client/src/chat/chat-runs.js';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from '../shared/attachments.js';
import type { Attachment, Run } from '../shared/types.js';

const saved: Attachment = { id: 'saved-image', name: '화면.png', mimeType: 'image/png', size: 1024 };

test('selection retains original files and infers raster MIME for pasted or uploaded files without a type', () => {
  const original = new File(['sample'], '화면.PNG');
  const other = new File(['data'], 'data.custom');
  const previous = [savedAttachmentDraft(saved)];
  const next = addDraftFiles(previous, [original, other]);
  assert.equal(previous.length, 1);
  assert.equal(next[0], previous[0]);
  assert.equal(next[1].file, original);
  assert.equal(next[1].name, '화면.PNG');
  assert.equal(next[1].mimeType, 'image/png');
  assert.equal(next[2].mimeType, 'application/octet-stream');
  assert.ok(next[1].key !== next[2].key);
});

test('selection enforces file count, raster size and total size across saved and new attachments without changing the draft', () => {
  const previous = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => savedAttachmentDraft({ ...saved, id: `saved-${index}` }));
  assert.throws(() => addDraftFiles(previous, [new File(['x'], 'extra.txt')]), /최대 10개/);
  const sizedFile = (size: number, type = 'text/plain') => ({ size, type, name: 'large-file' }) as File;
  assert.throws(() => addDraftFiles([], [sizedFile(MAX_ATTACHMENT_BYTES + 1)]), /파일 하나/);
  assert.throws(() => addDraftFiles([], [sizedFile(MAX_IMAGE_ATTACHMENT_BYTES + 1, 'image/png')]), /이미지는/);
  assert.throws(() => addDraftFiles([savedAttachmentDraft({ ...saved, size: MAX_TOTAL_ATTACHMENT_BYTES - 10 })], [sizedFile(11)]), /전체 크기/);
  assert.equal(previous.length, MAX_ATTACHMENTS);
  assert.equal(previous[0].attachmentId, 'saved-0');
});

test('preparation sends exact binary bytes as base64 and reuses saved attachment IDs without reading them again', async () => {
  const bytes = Uint8Array.from({ length: 30_000 }, (_, index) => index % 256);
  const files = addDraftFiles([savedAttachmentDraft(saved)], [new File([bytes], 'binary.dat', { type: 'application/octet-stream' })]);
  const prepared = await prepareDraftAttachments(files);
  assert.deepEqual(prepared.attachmentIds, [saved.id]);
  assert.equal(prepared.attachments?.[0].name, 'binary.dat');
  assert.deepEqual(Buffer.from(prepared.attachments![0].data, 'base64'), Buffer.from(bytes));
  assert.ok(!prepared.attachments![0].data.startsWith('data:'));
  assert.deepEqual(await prepareDraftAttachments([]), {});
});

test('a file read failure does not consume the attachment draft', async () => {
  const original = new File(['x'], 'unreadable.txt');
  original.arrayBuffer = async () => { throw new Error('The file could not be read.'); };
  const files = addDraftFiles([], [original]);
  await assert.rejects(prepareDraftAttachments(files), /could not be read/);
  assert.equal(files[0].file, original);
});

test('sending state survives panel unsubscribe and return, blocks duplicate submits, and leaves a different session intact', () => {
  const first = `first-${crypto.randomUUID()}`;
  const second = `second-${crypto.randomUUID()}`;
  const draft = { prompt: '', attachments: addDraftFiles([], [new File(['a'], 'image.png')]) };
  const other = { prompt: '다른 세션의 요청', attachments: [] };
  setComposerDraft(first, draft); setComposerDraft(second, other);
  const unsubscribe = subscribeComposer(first, () => {});
  const submitted = startComposerSend(first)!;
  assert.equal(submitted, draft);
  assert.equal(getComposerState(first).stage, 'preparing');
  unsubscribe();
  markComposerSending(first);
  assert.equal(startComposerSend(first), undefined);
  let reopenedNotices = 0;
  const unsubscribeAgain = subscribeComposer(first, () => { reopenedNotices++; });
  finishComposerSend(first, submitted);
  assert.equal(reopenedNotices, 1);
  assert.deepEqual(getComposerState(first).draft, { prompt: '', attachments: [] });
  assert.equal(getComposerState(first).stage, undefined);
  assert.equal(getComposerState(second).draft, other);
  unsubscribeAgain();
});

test('failed sends retain both prompt and files and can be resubmitted after navigation', () => {
  const id = `failure-${crypto.randomUUID()}`;
  const draft = { prompt: '검토해 주세요', attachments: [savedAttachmentDraft(saved)] };
  setComposerDraft(id, draft);
  const submitted = startComposerSend(id)!;
  finishComposerSend(id, submitted, '서버에 연결하지 못했습니다.');
  assert.equal(getComposerState(id).draft, draft);
  assert.equal(getComposerState(id).stage, undefined);
  assert.match(getComposerState(id).error, /서버/);
  assert.equal(startComposerSend(id), draft);
  assert.equal(getComposerState(id).error, '');
  finishComposerSend(id, draft);
});

test('a late success never erases a newer draft', () => {
  const id = `revised-${crypto.randomUUID()}`;
  setComposerDraft(id, { prompt: 'first', attachments: [] });
  const submitted = startComposerSend(id)!;
  const newer = { prompt: 'next', attachments: [savedAttachmentDraft(saved)] };
  setComposerDraft(id, newer);
  finishComposerSend(id, submitted);
  assert.equal(getComposerState(id).draft, newer);
});

test('saved attachments render raster previews and download links while SVG and arbitrary files stay file chips', () => {
  const attachments = [saved, { ...saved, id: 'unsafe?file', name: '<script>.svg', mimeType: 'image/svg+xml' }, { ...saved, id: 'notes', name: 'notes.txt', mimeType: 'text/plain' }];
  const html = renderToStaticMarkup(createElement(SavedAttachments, { attachments }));
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /src="\/api\/attachments\/saved-image"/);
  assert.match(html, /href="\/api\/attachments\/unsafe%3Ffile"/);
  assert.match(html, /download="&lt;script&gt;\.svg"/);
  assert.match(html, /notes\.txt/);
  assert.equal(isPreviewableAttachment({ mimeType: 'image/svg+xml' }), false);
  assert.equal(attachmentUrl('one/two'), '/api/attachments/one%2Ftwo');
});

test('attachment-only requests show their files on the native user message', () => {
  const run: Run = { id: 'run', sessionId: 'session', status: 'completed', createdAt: '2026-09-15T00:00:00.000Z', prompt: '', output: '', attachments: [saved] };
  const messages = [{ id: 'native-user', role: 'user' as const, timestamp: '2026-09-15T00:00:01.000Z', text: `첨부한 파일을 확인하고 내용을 설명해 주세요.\n\n첨부 파일 (사용자가 이번 메시지에 첨부한 로컬 파일):\n- "화면.png" (image/png, 1024 bytes): "/state/attachments/saved-image/content/화면.png"\n[Image attachment]` }];
  const projection = matchChatRuns(messages, [run], 'session');
  const html = renderToStaticMarkup(createElement(ChatTranscript, { messages, runMatches: projection.matches }));
  assert.match(html, /보낸 첨부 파일/);
  assert.match(html, /화면\.png/);
  assert.doesNotMatch(html, /첨부한 파일을 확인|첨부 파일 \(사용자가|Image attachment|run-card/);
  assert.equal((html.match(/href="\/api\/attachments\/saved-image"/g) || []).length, 1);
});
