import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatTranscript, Message, RunControl } from '../client/src/chat/ChatPanel.js';
import type { ChatMessage, Run } from '../shared/types.js';

for (const role of ['tool', 'system'] as const) {
  test(`closed ${role} messages show their summary without rendering the hidden transcript`, () => {
    const message: ChatMessage = {
      id: role, role, toolName: 'example-tool', timestamp: '2026-09-15T00:00:00.000Z',
      text: `${'Visible summary words. '.repeat(15)}\n\n**HIDDEN_TRANSCRIPT_PAYLOAD**`,
    };
    const html = renderToStaticMarkup(createElement(Message, { message }));
    assert.match(html, /<summary>/);
    assert.match(html, /Visible summary words/);
    assert.match(html, /example-tool/);
    assert.doesNotMatch(html, /HIDDEN_TRANSCRIPT_PAYLOAD/);
    assert.doesNotMatch(html, /class="markdown"/);
  });
}

const noop = () => {};
function renderRun(status: Run['status']) {
  const run: Run = {
    id: 'run', sessionId: 'session', status, createdAt: '2026-09-15T00:00:00.000Z',
    prompt: 'PRIVATE_RUN_PROMPT', output: '**COMPLETE_RUN_OUTPUT**',
    error: status === 'error' ? 'ACTIONABLE_RUN_ERROR' : undefined,
  };
  return renderToStaticMarkup(createElement(RunControl, { run, onCancel: noop, onRetry: noop, cancelling: false }));
}

for (const status of ['completed', 'cancelled'] as const) {
  test(`${status} requests render no separate history or controls`, () => {
    assert.equal(renderRun(status), '');
  });
}

for (const status of ['queued', 'running', 'error'] as const) {
  test(`${status} requests retain compact controls without repeating their output`, () => {
    const html = renderRun(status);
    assert.match(html, /run-control/);
    assert.match(html, /PRIVATE_RUN_PROMPT/);
    assert.doesNotMatch(html, /COMPLETE_RUN_OUTPUT|class="markdown"|run-card|<details/);
    if (status === 'error') {
      assert.match(html, /ACTIONABLE_RUN_ERROR/);
      assert.match(html, /요청 다시 작성/);
    } else assert.match(html, status === 'queued' ? /대기 취소/ : /중지/);
  });
}

test('visible assistant messages keep the complete original Markdown content', () => {
  const message: ChatMessage = {
    id: 'assistant', role: 'assistant', timestamp: '2026-09-15T00:00:00.000Z',
    text: `${'Full visible conversation text. '.repeat(100)}\n\n**ORIGINAL_TEXT_END**`,
  };
  const html = renderToStaticMarkup(createElement(Message, { message }));
  assert.match(html, /<strong>ORIGINAL_TEXT_END<\/strong>/);
});

test('tool groups default to a concise count with errors while all individual rows are unmounted', () => {
  const messages: ChatMessage[] = Array.from({ length: 5 }, (_, index) => [
    { id: `call-${index}`, role: 'tool' as const, toolName: 'PRIVATE_TOOL_NAME', text: 'PRIVATE_CALL_ARGUMENTS', timestamp: '2026-09-15T00:00:00.000Z' },
    { id: `call-${index}:result`, role: 'tool' as const, toolName: 'result', text: '**PRIVATE_TOOL_OUTPUT**', timestamp: '2026-09-15T00:00:00.000Z', isError: index === 2 },
  ]).flat();
  const html = renderToStaticMarkup(createElement(ChatTranscript, { messages }));
  assert.match(html, /5개의 작업/);
  assert.match(html, /오류 1건/);
  assert.match(html, /tool-group-error/);
  assert.doesNotMatch(html, /open=""/);
  assert.doesNotMatch(html, /PRIVATE_TOOL_NAME|PRIVATE_CALL_ARGUMENTS|PRIVATE_TOOL_OUTPUT/);
  assert.doesNotMatch(html, /tool-message|tool-group-content|class="markdown"/);
  assert.equal((html.match(/<summary/g) || []).length, 1);
});

test('conversation prose separates compact groups while session metadata remains inside and hidden', () => {
  const row = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({ id, role, text, timestamp: '2026-09-15T00:00:00.000Z' });
  const html = renderToStaticMarkup(createElement(ChatTranscript, { messages: [
    row('user', 'user', '**USER_TEXT**'), row('a', 'tool', 'HIDDEN_A'), row('b', 'tool', 'HIDDEN_B'),
    row('assistant', 'assistant', '**ASSISTANT_TEXT**'), row('metadata', 'system', 'SESSION_METADATA'),
    row('c', 'tool', 'HIDDEN_C'), row('between', 'system', 'HIDDEN_METADATA_BETWEEN'), row('d', 'tool', 'HIDDEN_D'), row('tail', 'assistant', '**FINAL_TEXT**'),
  ] }));
  const markers = ['<strong>USER_TEXT</strong>', '2개의 작업', '<strong>ASSISTANT_TEXT</strong>', '2개의 작업', '<strong>FINAL_TEXT</strong>'];
  let previous = -1;
  for (const marker of markers) {
    const position = html.indexOf(marker, previous + 1);
    assert.ok(position > previous, `${marker} should follow the previous transcript entry`);
    previous = position;
  }
  assert.doesNotMatch(html, /HIDDEN_A|HIDDEN_B|HIDDEN_C|HIDDEN_D|SESSION_METADATA|HIDDEN_METADATA_BETWEEN/);
  assert.equal((html.match(/<summary/g) || []).length, 2);
});

test('a singleton tool has the same collapsed summary without rendering its original content', () => {
  const message: ChatMessage = { id: 'single', role: 'tool', toolName: 'PRIVATE_TOOL', text: 'PRIVATE_SINGLETON_CONTENT', timestamp: '2026-09-15T00:00:00.000Z' };
  const html = renderToStaticMarkup(createElement(ChatTranscript, { messages: [message] }));
  assert.match(html, /1개의 작업/);
  assert.match(html, /tool-group/);
  assert.doesNotMatch(html, /open=""|tool-message|PRIVATE_TOOL|PRIVATE_SINGLETON_CONTENT/);
  assert.equal((html.match(/<summary/g) || []).length, 1);
});

for (const count of [1, 3]) {
  test(`${count} session-only records share one lazy collapsed session summary`, () => {
    const messages: ChatMessage[] = Array.from({ length: count }, (_, index) => ({ id: `system-${index}`, role: 'system', text: `PRIVATE_SESSION_DATA_${index}`, timestamp: '2026-09-15T00:00:00.000Z' }));
    const html = renderToStaticMarkup(createElement(ChatTranscript, { messages }));
    assert.match(html, /<strong>세션 정보<\/strong>/);
    assert.doesNotMatch(html, /개의 작업|PRIVATE_SESSION_DATA|tool-message|tool-group-content|open=""/);
    assert.equal((html.match(/<summary/g) || []).length, 1);
  });
}
