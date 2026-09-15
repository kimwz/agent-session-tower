import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { matchChatRuns } from '../client/src/chat-runs.js';
import { ChatTranscript, RunControl } from '../client/src/ChatPanel.js';
import type { Attachment, ChatMessage, Run } from '../shared/types.js';

const at = (milliseconds: number) => new Date(Date.UTC(2026, 8, 15) + milliseconds).toISOString();
const file: Attachment = { id: 'text-id', name: '읽을 파일.txt', mimeType: 'text/plain', size: 12 };
const image: Attachment = { id: 'image-id', name: '화면.png', mimeType: 'image/png', size: 1024 };
const row = (id: string, text: string, milliseconds = 10_000, role: ChatMessage['role'] = 'user'): ChatMessage => ({ id, role, text, timestamp: at(milliseconds) });
const run = (id: string, extra: Partial<Run> = {}): Run => ({ id, sessionId: 'session', prompt: '확인해 주세요', status: 'completed', createdAt: at(9000), startedAt: at(10_000), finishedAt: at(20_000), output: 'RUN_OUTPUT_MUST_NOT_RENDER', ...extra });
const path = (attachment: Attachment) => `/private/tmp/state/attachments/${attachment.id}/content/${attachment.name}`;
function wrapped(request: Run) {
  return `${request.prompt || '첨부한 파일을 확인하고 내용을 설명해 주세요.'}\n\n첨부 파일 (사용자가 이번 메시지에 첨부한 로컬 파일):\n${request.attachments!.map(attachment => `- ${JSON.stringify(attachment.name)} (${attachment.mimeType}, ${attachment.size} bytes): ${JSON.stringify(path(attachment))}`).join('\n')}`;
}

test('only exact normalized user prompts in the requested session match; original messages and order are untouched', () => {
  const messages = Object.freeze([
    Object.freeze(row('system', '확인해 주세요', 10_000, 'system')),
    Object.freeze(row('substring', '추가: 확인해 주세요', 10_001)),
    Object.freeze(row('user', '  확인해 주세요\r\n', 10_002)),
    Object.freeze(row('assistant', '확인해 주세요', 10_003, 'assistant')),
  ]);
  const projection = matchChatRuns(messages, [run('foreign', { sessionId: 'other' }), run('right')], 'session');
  assert.deepEqual([...projection.matches.keys()], ['user']);
  assert.deepEqual([...projection.matchedRunIds], ['right']);
  assert.equal(projection.matches.get('user')!.text, '확인해 주세요');
  assert.equal(messages[2].text, '  확인해 주세요\r\n');
  assert.deepEqual(messages.map(message => message.id), ['system', 'substring', 'user', 'assistant']);
});

test('repeated identical prompts match chronologically one-to-one even when runs arrive newest first', () => {
  const first = run('first', { startedAt: at(10_000), finishedAt: at(11_000) });
  const second = run('second', { createdAt: at(19_000), startedAt: at(20_000), finishedAt: at(21_000) });
  const messages = [row('one', first.prompt, 10_010), row('two', second.prompt, 20_010), row('extra', second.prompt, 20_020)];
  const projection = matchChatRuns(messages, [second, first], 'session');
  assert.equal(projection.matches.get('one')?.runId, 'first');
  assert.equal(projection.matches.get('two')?.runId, 'second');
  assert.equal(projection.matches.has('extra'), false);
});

test('a previous run never consumes the next repeated prompt when its own native row is outside the loaded page', () => {
  const first = run('first', { startedAt: at(10_000), finishedAt: at(11_000) });
  const second = run('second', { createdAt: at(11_200), startedAt: at(11_500), finishedAt: at(12_000) });
  const projection = matchChatRuns([row('later-page', second.prompt, 11_499)], [first, second], 'session');
  assert.equal(projection.matches.get('later-page')?.runId, 'second');
  assert.equal(projection.matchedRunIds.has('first'), false);
});

test('a rapid distinct request never removes the earlier native attachment association', () => {
  const first = run('first', { attachments: [file], startedAt: at(10_000), finishedAt: at(10_200) });
  const message = row('first-user', wrapped(first), 10_010);
  const alone = matchChatRuns([message], [first], 'session').matches.get(message.id);
  assert.equal(alone?.runId, 'first');
  for (const second of [
    run('different-prompt', { prompt: '다른 요청', attachments: [file], startedAt: at(10_500), finishedAt: at(10_700) }),
    run('different-file', { attachments: [{ ...file, id: 'different-file-id' }], startedAt: at(10_500), finishedAt: at(10_700) }),
  ]) {
    const together = matchChatRuns([message], [second, first], 'session').matches.get(message.id);
    assert.deepEqual(together, alone);
  }
});

test('rapid repeated attachment requests stay one-to-one and tolerate the later bridge timestamp preceding start', () => {
  const first = run('first', { attachments: [file], startedAt: at(10_000), finishedAt: at(10_200) });
  const second = run('second', { attachments: [file], createdAt: at(10_400), startedAt: at(10_500), finishedAt: at(10_700) });
  const messages = [row('first-user', wrapped(first), 10_010), row('second-user', wrapped(second), 10_499)];
  const projection = matchChatRuns(messages, [second, first], 'session');
  assert.equal(projection.matches.get('first-user')?.runId, 'first');
  assert.equal(projection.matches.get('second-user')?.runId, 'second');
  const laterPage = matchChatRuns([messages[1]], [first, second], 'session');
  assert.equal(laterPage.matches.get('second-user')?.runId, 'second');
  assert.equal(laterPage.matchedRunIds.has('first'), false);
});

test('a repeated request boundary preserves a preceding native row recorded late in its execution', () => {
  const first = run('first', { startedAt: at(10_000), finishedAt: at(10_490) });
  const second = run('second', { createdAt: at(10_495), startedAt: at(10_500), finishedAt: at(10_700) });
  const messages = [row('first-user', first.prompt, 10_480), row('second-user', second.prompt, 10_499)];
  const projection = matchChatRuns(messages, [first, second], 'session');
  assert.equal(projection.matches.get('first-user')?.runId, 'first');
  assert.equal(projection.matches.get('second-user')?.runId, 'second');
});

test('a queued repeat starting at the previous finish timestamp cannot claim that previous native row', () => {
  const first = run('first', { attachments: [file], startedAt: at(10_000), finishedAt: at(10_500) });
  const second = run('second', { attachments: [file], startedAt: at(10_500), finishedAt: at(10_700) });
  const messages = [row('first-user', wrapped(first), 10_480), row('second-user', wrapped(second), 10_501)];
  const projection = matchChatRuns(messages, [first, second], 'session');
  assert.equal(projection.matches.get('first-user')?.runId, 'first');
  assert.equal(projection.matches.get('first-user')?.attachments, first.attachments);
  assert.equal(projection.matches.get('second-user')?.runId, 'second');
});

test('matching tolerates the native timestamp preceding bridge start by milliseconds, but rejects old, late and invalid timestamps', () => {
  const request = run('bridge');
  assert.equal(matchChatRuns([row('bridge-user', request.prompt, 9999)], [request], 'session').matches.size, 1);
  const messages = [row('old', request.prompt, 8000), row('after-finish', request.prompt, 22_000), { ...row('invalid', request.prompt), timestamp: 'invalid' }];
  assert.equal(matchChatRuns(messages, [request], 'session').matches.size, 0);
  assert.equal(matchChatRuns([row('much-later', request.prompt, 200_000)], [run('unfinished', { status: 'running', finishedAt: undefined })], 'session').matches.size, 0);
  assert.equal(matchChatRuns([row('queued-user', request.prompt)], [run('queued', { status: 'queued' })], 'session').matches.size, 0);
  assert.equal(matchChatRuns([row('bad-date', request.prompt)], [run('bad-date', { startedAt: 'invalid' })], 'session').matches.size, 0);
});

test('known Claude and direct Codex image suffixes attach all files and hide only the generated wrapper', () => {
  const request = run('attachments', { attachments: [file, image] });
  for (const suffix of ['', '\n[Image attachment]']) {
    const message = row('native', wrapped(request) + suffix);
    const projection = matchChatRuns([message], [request], 'session');
    assert.equal(projection.matches.get('native')?.text, request.prompt);
    assert.equal(projection.matches.get('native')?.attachments, request.attachments);
    assert.equal(message.text, wrapped(request) + suffix);
  }
});

test('Codex CLI image wrappers are removed only with exactly matching attachment paths and metadata', () => {
  const request = run('cli', { attachments: [file, image] });
  const prefix = `<image name=[Image #1] path="${path(image)}">\n[Image attachment]\n</image>\n`;
  const projection = matchChatRuns([row('cli-user', prefix + wrapped(request))], [request], 'session');
  assert.equal(projection.matches.get('cli-user')?.attachments?.length, 2);
  assert.equal(matchChatRuns([row('bad-path', prefix.replace('/image-id/', '/another-id/') + wrapped(request))], [request], 'session').matches.size, 0);
});

test('unknown native prefixes, suffixes, truncated wrappers and wrong IDs or metadata preserve their original contents without inferred attachments', () => {
  const request = run('attachments', { attachments: [file, image] });
  const original = wrapped(request);
  for (const text of [request.prompt, `unrelated\n${original}`, `${original}\n사용자가 추가한 문장`, `${original}\n[Image attachment]\n[Image attachment]`, original.slice(0, -10), original.replace('/text-id/', '/wrong-id/'), original.replace('text/plain, 12 bytes', 'text/plain, 13 bytes')]) {
    const message = Object.freeze(row('unknown', text));
    assert.equal(matchChatRuns([message], [request], 'session').matches.size, 0, text);
    assert.equal(message.text, text);
  }
});

test('the main native message renders attached links once while completed output has no second transcript', () => {
  const request = run('attached', { attachments: [file, image], prompt: 'UNIQUE_NATIVE_REQUEST' });
  const messages = [row('native-user', wrapped(request) + '\n[Image attachment]'), row('native-assistant', 'UNIQUE_NATIVE_RESPONSE', 15_000, 'assistant')];
  const projection = matchChatRuns(messages, [request], 'session');
  const html = renderToStaticMarkup(createElement(Fragment, null,
    createElement(ChatTranscript, { messages, runMatches: projection.matches }),
    createElement(RunControl, { run: request, onCancel() {}, onRetry() {}, cancelling: false }),
  ));
  assert.equal((html.match(/UNIQUE_NATIVE_REQUEST/g) || []).length, 1);
  assert.equal((html.match(/UNIQUE_NATIVE_RESPONSE/g) || []).length, 1);
  assert.equal((html.match(/href="\/api\/attachments\/text-id"/g) || []).length, 1);
  assert.equal((html.match(/href="\/api\/attachments\/image-id"/g) || []).length, 1);
  assert.doesNotMatch(html, /RUN_OUTPUT_MUST_NOT_RENDER|Monitor에서 보낸 작업|run-card|첨부 파일 \(사용자가|Image attachment/);
});

test('unmatched errors retain a request preview, complete failure reason, retry and dismiss actions', () => {
  const request = run('failed', { status: 'error', error: 'ACTIONABLE_FAILURE_REASON' });
  const props = { run: request, onCancel() {}, onRetry() {}, onDismiss() {}, cancelling: false };
  const html = renderToStaticMarkup(createElement(RunControl, props));
  assert.match(html, /확인해 주세요/);
  assert.match(html, /ACTIONABLE_FAILURE_REASON/);
  assert.match(html, /aria-label="요청 다시 작성"/);
  assert.match(html, /aria-label="실패 내역 지우기"/);
  assert.doesNotMatch(html, /RUN_OUTPUT_MUST_NOT_RENDER|<img /);
  const offline = renderToStaticMarkup(createElement(RunControl, { ...props, disabled: true }));
  assert.equal((offline.match(/disabled=""/g) || []).length, 2);
});

test('matched running requests show only status and stop; pending actions disable while unavailable', () => {
  const props = { run: run('running', { status: 'running' }), onCancel() {}, onRetry() {}, cancelling: false, showPrompt: false };
  const html = renderToStaticMarkup(createElement(RunControl, props));
  assert.match(html, /작업 중/);
  assert.match(html, /중지/);
  assert.doesNotMatch(html, /확인해 주세요|RUN_OUTPUT_MUST_NOT_RENDER/);
  assert.match(renderToStaticMarkup(createElement(RunControl, { ...props, disabled: true })), /disabled=""/);
});
