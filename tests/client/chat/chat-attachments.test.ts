import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addDraftFiles, attachmentUrl, isPreviewableAttachment, prepareDraftAttachments, savedAttachmentDraft } from '../../../client/src/chat/chat-attachments.js';
import { finishComposerSend, getComposerState, markComposerSending, setComposerDraft, startComposerSend, subscribeComposer } from '../../../client/src/chat/chat-drafts.js';
import { SavedAttachments } from '../../../client/src/chat/ChatAttachments.js';
import { ChatTranscript } from '../../../client/src/chat/ChatTranscript.js';
import { matchChatRuns } from '../../../client/src/chat/chat-runs.js';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BYTES, UPLOAD_CHUNK_BYTES } from '../../../shared/attachments.js';
import type { Attachment, Run } from '../../../shared/types.js';

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

test('selection enforces only count and retains large originals including images', () => {
  const previous = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => savedAttachmentDraft({ ...saved, id: `saved-${index}` }));
  assert.throws(() => addDraftFiles(previous, [new File(['x'], 'extra.txt')]), /최대 10개/);
  const file = { size: 1024 * 1024 * 1024, type: 'image/png', name: 'large.png' } as File;
  assert.equal(addDraftFiles([savedAttachmentDraft({ ...saved, size: 1024 * 1024 * 1024 })], [file])[1].file, file);
  assert.equal(previous.length, MAX_ATTACHMENTS);
});

test('preparation streams bounded original slices and sends only scoped references', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const bytes = Buffer.alloc(21 * 1024 * 1024 + 17, 173);
  const original = new File([bytes], 'binary.dat', { type: 'application/octet-stream' });
  original.arrayBuffer = async () => { throw new Error('whole file reads forbidden'); };
  const node = 'a'.repeat(32);
  const received: Buffer[] = []; let offset = 0; let starts = 0;
  globalThis.fetch = (async (path, init) => {
    assert.match(String(path), new RegExp(`^/api/nodes/${node}/`));
    let result: unknown;
    if (String(path).endsWith('/attachment-uploads')) { starts++; assert.deepEqual(JSON.parse(init!.body as string), { name: 'binary.dat', mimeType: 'application/octet-stream', size: bytes.length }); result = { id: 'upload' }; }
    else if (String(path).includes('?offset=')) {
      const chunk = Buffer.from(await (init!.body as Blob).arrayBuffer()); assert.ok(chunk.length <= UPLOAD_CHUNK_BYTES);
      assert.ok(String(path).endsWith(`?offset=${offset}`)); received.push(chunk); offset += chunk.length; result = { offset };
    } else if (String(path).endsWith('/complete')) result = { attachment: { ...saved, id: 'uploaded', size: bytes.length } };
    else result = { offset };
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const files = addDraftFiles([savedAttachmentDraft({ ...saved, id: `@${node}/${saved.id}` })], [original]);
  const context = { kind: 'chat' as const, sessionId: `@${node}/canonical-session`, token: 'token' };
  const prepared = await prepareDraftAttachments(files, context);
  assert.deepEqual(prepared, { attachmentIds: [saved.id, 'uploaded'] });
  assert.deepEqual(Buffer.concat(received), bytes);
  assert.deepEqual(await prepareDraftAttachments(files, context), prepared); assert.equal(starts, 1);
  assert.deepEqual(await prepareDraftAttachments([]), {});
});

test('failed upload retains draft and resumes from server offset with the same upload ID', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const original = new File([Buffer.alloc(UPLOAD_CHUNK_BYTES + 100, 7)], 'retry.bin');
  const files = addDraftFiles([], [original]); let starts = 0; let offset = 0; let failed = false; const sentOffsets: number[] = [];
  globalThis.fetch = (async (path, init) => {
    let result: unknown;
    if (String(path).endsWith('/attachment-uploads')) { starts++; result = { id: 'stable-upload' }; }
    else if (String(path).includes('?offset=')) {
      sentOffsets.push(Number(String(path).split('=')[1]));
      offset += (init!.body as Blob).size;
      if (!failed) { failed = true; throw new Error('connection lost after chunk accepted'); }
      result = { offset };
    } else if (String(path).endsWith('/complete')) result = { attachment: { ...saved, id: 'finished' } };
    else result = { offset };
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const context = { kind: 'auto' as const, sessionId: 'stable-request', token: 'token' };
  await assert.rejects(prepareDraftAttachments(files, context), /connection lost/);
  assert.equal(files[0].file, original);
  assert.deepEqual(await prepareDraftAttachments(files, context), { attachmentIds: ['finished'] });
  assert.equal(starts, 1); assert.deepEqual(sentOffsets, [0, UPLOAD_CHUNK_BYTES]);
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

for (const kind of ['chat', 'auto'] as const) for (const remote of [false, true]) for (const status of [404, 503]) {
  test(`${kind} preserves bounded attachments on ${remote ? 'old joined computer' : 'old worker'} (${status})`, async t => {
    const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
    const node = 'b'.repeat(32);
    const sessionId = remote ? `@${node}/session` : 'session';
    const reference = savedAttachmentDraft({ ...saved, id: remote ? `@${node}/saved` : 'saved' });
    const bytes = Buffer.from('bounded original bytes');
    const files = addDraftFiles([reference], [new File([bytes], 'notes.txt', { type: 'text/plain' })]);
    let calls = 0;
    globalThis.fetch = (async (path, init) => {
      calls++; assert.equal(init?.method, 'POST'); assert.ok(String(path).endsWith('/attachment-uploads'));
      assert.equal(String(path).startsWith('/api/nodes/'), remote);
      return new Response(JSON.stringify({ error: 'not supported', ...(status === 503 ? { disposition: 'not-admitted' } : {}) }), { status });
    }) as typeof fetch;
    assert.deepEqual(await prepareDraftAttachments(files, { kind, sessionId, token: 'token' }), {
      attachments: [{ name: 'notes.txt', mimeType: 'text/plain', data: bytes.toString('base64') }], attachmentIds: ['saved'],
    });
    assert.equal(calls, 1);
  });
}

test('unsupported upload never reads files exceeding the legacy file, image or aggregate budget', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'update pending', disposition: 'not-admitted' }), { status: 503 })) as typeof fetch;
  const file = (size: number, type = 'application/octet-stream') => {
    const original = new File([new Uint8Array(size)], 'file', { type });
    original.arrayBuffer = async () => { throw new Error('whole-file read forbidden'); };
    return original;
  };
  for (const originals of [[file(MAX_ATTACHMENT_BYTES + 1)], [file(MAX_IMAGE_ATTACHMENT_BYTES + 1, 'image/png')], [file(8 * 1024 * 1024), file(8 * 1024 * 1024), file(8 * 1024 * 1024)]]) {
    const draft = addDraftFiles([], originals);
    draft.forEach(item => { item.size = 0; }); // The actual File size owns the memory bound.
    await assert.rejects(prepareDraftAttachments(draft, { kind: 'chat', sessionId: 'session', token: 'token' }), /update pending/);
  }
});

test('permission denials and uncertain failures do not fall back to a second attachment transport', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  for (const failure of [403, 503, 'network'] as const) {
    const file = new File(['private'], 'notes.txt'); file.arrayBuffer = async () => { throw new Error('fallback forbidden'); };
    globalThis.fetch = (async () => {
      if (failure === 'network') throw new Error('network failure');
      return new Response(JSON.stringify({ error: 'request refused' }), { status: failure });
    }) as typeof fetch;
    await assert.rejects(prepareDraftAttachments(addDraftFiles([], [file]), { kind: 'auto', sessionId: 'session', token: 'token' }), /request refused|network failure/);
  }
});
