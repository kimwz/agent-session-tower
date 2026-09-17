import test from 'node:test';
import assert from 'node:assert/strict';
import { groupConsecutiveTools, type ToolGroup } from '../client/src/chat/chat-tool-groups.js';
import type { ChatMessage } from '../shared/types.js';

function message(id: string, role: ChatMessage['role'] = 'tool', extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text: `Original ${id}`, timestamp: '2026-09-15T00:00:00.000Z', toolName: role === 'tool' ? 'exec_command' : undefined, ...extra };
}
function result(id: string, extra: Partial<ChatMessage> = {}) {
  return message(`${id}:result`, 'tool', { toolName: 'result', ...extra });
}
function onlyGroup(messages: readonly ChatMessage[]): ToolGroup {
  const entries = groupConsecutiveTools(messages);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'tools');
  return entries[0] as ToolGroup;
}

test('tools stay grouped across session metadata and only conversation prose breaks the group', () => {
  const messages = [message('user', 'user'), message('a'), result('a'), message('assistant', 'assistant'), message('b'), result('b'), message('metadata', 'system'), message('c'), result('c'), message('end', 'user'), message('single')];
  const entries = groupConsecutiveTools(messages);
  assert.deepEqual(entries.map(entry => entry.kind === 'tools' ? entry.messages.map(item => item.id) : entry.message.id), ['user', ['a', 'a:result'], 'assistant', ['b', 'b:result', 'metadata', 'c', 'c:result'], 'end', ['single']]);
  const flattened = entries.flatMap(entry => entry.kind === 'tools' ? [...entry.messages] : [entry.message]);
  flattened.forEach((item, index) => assert.equal(item, messages[index]));
});

test('session records neither inflate work counts nor consume call/result matches', () => {
  const group = onlyGroup([
    message('leading-metadata', 'system'), message('exact'),
    message('between', 'system', { toolName: 'result', isError: true }),
    message('fallback-item'), message('metadata-call', 'system', { toolName: 'exec_command' }),
    result('different-id'), message('before-exact', 'system'), result('exact', { isError: true }),
    message('trailing-metadata', 'system'),
  ]);
  assert.equal(group.workCount, 2);
  assert.equal(group.errorCount, 1);
  assert.equal(group.id, 'leading-metadata');
  assert.equal(group.messages.length, 9);
});

test('single tools and chunks containing only session records are compact groups too', () => {
  const single = onlyGroup([message('single')]);
  assert.equal(single.workCount, 1);
  assert.equal(single.messages.length, 1);
  const oneSystem = onlyGroup([message('metadata', 'system')]);
  assert.equal(oneSystem.workCount, 0);
  assert.equal(oneSystem.errorCount, 0);
  const systems = onlyGroup([message('first', 'system'), message('second', 'system')]);
  assert.equal(systems.workCount, 0);
  assert.deepEqual(systems.messages.map(item => item.id), ['first', 'second']);
});

test('five calls and their outputs count as five operations, including parallel results', () => {
  const calls = Array.from({ length: 5 }, (_, index) => message(`call-${index}`));
  const outputs = [...calls].reverse().map(call => result(call.id));
  assert.equal(onlyGroup([...calls, ...outputs]).workCount, 5);
});

test('page boundary outputs and unfinished trailing calls remain counted', () => {
  const group = onlyGroup([result('previous-page'), message('complete'), result('complete'), message('pending')]);
  assert.equal(group.workCount, 3);
  assert.equal(onlyGroup([result('a'), result('b'), result('c')]).workCount, 3);
});

test('different Codex item IDs fall back to preceding calls without consuming exact pairs', () => {
  const group = onlyGroup([message('exact'), message('item-id'), result('call-id'), result('exact')]);
  assert.equal(group.workCount, 2);
  assert.equal(onlyGroup([message('item-id'), result('call-id')]).workCount, 1);
});

test('errors remain visible once per operation even when both call and result mark failure', () => {
  const group = onlyGroup([result('orphan', { isError: true }), message('failed', 'tool', { isError: true }), result('failed', { isError: true }), message('ok'), result('ok')]);
  assert.equal(group.workCount, 3);
  assert.equal(group.errorCount, 2);
});

test('grouping accepts frozen history and retains the original message objects and text', () => {
  const first = Object.freeze(message('a', 'tool', { text: '**original**\n\n```js\nconst a = 1;\n```' }));
  const metadata = Object.freeze(message('metadata', 'system', { text: '**Session metadata**\n\nComplete original context.' }));
  const second = Object.freeze(result('a'));
  const messages = Object.freeze([first, metadata, second]);
  const group = onlyGroup(messages);
  assert.equal(group.messages[0], first);
  assert.equal(group.messages[1], metadata);
  assert.equal(group.messages[2], second);
  assert.equal(group.messages[0].text, first.text);
  assert.equal(group.messages[1].text, metadata.text);
  assert.notEqual(group.messages, messages);
});

test('appending to an existing group retains the identity used for its expanded state', () => {
  const messages = [message('a')];
  const before = onlyGroup(messages);
  const after = onlyGroup([...messages, message('metadata', 'system'), result('a'), message('b'), result('b')]);
  assert.equal(after.id, before.id);
  assert.equal(after.workCount, 2);
  assert.equal(after.messages[0], before.messages[0]);
  assert.deepEqual(groupConsecutiveTools([]), []);
});
