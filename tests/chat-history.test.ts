import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLatestPage, prependOlderPage } from '../client/src/chat-history.js';
import type { ChatMessage, Session, SessionDetail } from '../shared/types.js';

const session: Session = {
  id: 'codex:chat', nativeId: 'chat', provider: 'codex', title: 'Task', cwd: '/work', project: 'work',
  status: 'working', statusReason: 'Active task', createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z', lastMessage: 'Running', messageCount: 0, isSubagent: false, resumable: true,
};
function page(start: number, end: number): SessionDetail {
  return {
    session: { ...session, messageCount: end },
    messages: Array.from({ length: end - start }, (_, index) => ({ id: String(start + index), role: 'assistant' as const, text: `Message ${start + index}`, timestamp: session.updatedAt })),
    hasMore: start > 0, nextBefore: start || undefined,
  };
}

test('a reconnect after more than one page of new messages keeps the omitted history reachable', () => {
  const reconnected = mergeLatestPage(page(0, 20), page(80, 180));
  assert.equal(reconnected.hasMore, true);
  assert.equal(reconnected.nextBefore, 80);
  assert.equal(reconnected.resetToLatest, true);
  assert.deepEqual(reconnected.messages.map(message => message.id), page(80, 180).messages.map(message => message.id));
  const recovered = prependOlderPage(reconnected, page(0, 80), 80)!;
  assert.deepEqual(recovered.messages.map(message => message.id), page(0, 180).messages.map(message => message.id));
  assert.equal(recovered.hasMore, false);
  assert.equal(recovered.resetToLatest, false);
});

test('overlapping live updates preserve loaded history and its earliest pagination cursor', () => {
  const previous = page(20, 160);
  const next = page(70, 170);
  next.messages[0].text = 'Updated native message';
  const merged = mergeLatestPage(previous, next);
  assert.deepEqual(merged.messages.map(message => message.id), page(20, 170).messages.map(message => message.id));
  assert.equal(merged.messages.find(message => message.id === '70')?.text, 'Updated native message');
  assert.equal(merged.nextBefore, 20);
  assert.equal(merged.hasMore, true);
  assert.equal(mergeLatestPage(page(0, 160), next).hasMore, false);
});

test('an old pagination response cannot splice a gap into a newly refreshed window', () => {
  const previous = page(100, 200);
  const reconnected = mergeLatestPage(previous, page(350, 450));
  const staleResponse = prependOlderPage(reconnected, page(0, 100), 100);
  assert.equal(staleResponse, reconnected);
  assert.equal(staleResponse?.nextBefore, 350);
});

test('a replaced transcript or different session removes stale visible messages', () => {
  const replaced = mergeLatestPage(page(0, 180), page(0, 10));
  assert.deepEqual(replaced.messages, page(0, 10).messages);
  assert.equal(replaced.hasMore, false);
  const another = { ...page(0, 20), session: { ...session, id: 'claude:other' } };
  assert.equal(mergeLatestPage(page(0, 50), another), another);
});

test('unchanged live history retains its array and message identities while session metadata advances', () => {
  const previous = page(20, 160);
  const next = page(60, 160);
  next.session = { ...next.session, status: 'completed', statusReason: 'Done', updatedAt: '2026-09-15T00:05:00.000Z' };
  const merged = mergeLatestPage(previous, next);
  assert.equal(merged.messages, previous.messages);
  assert.equal(merged.session, next.session);
  assert.equal(merged.session.status, 'completed');
  assert.equal(merged.nextBefore, 20);
  assert.equal(merged.hasMore, true);
  const empty = page(0, 0);
  assert.equal(mergeLatestPage(empty, page(0, 0)).messages, empty.messages);
});

test('each changed message field replaces only that message reference', () => {
  const changes: Partial<ChatMessage>[] = [
    { role: 'tool' }, { text: 'Updated answer' }, { timestamp: '2026-09-15T00:06:00.000Z' },
    { toolName: 'exec_command' }, { isError: true },
  ];
  for (const change of changes) {
    const previous = page(0, 3);
    const next = page(0, 3);
    next.messages[1] = { ...next.messages[1], ...change };
    const merged = mergeLatestPage(previous, next);
    assert.notEqual(merged.messages, previous.messages);
    assert.equal(merged.messages[0], previous.messages[0]);
    assert.equal(merged.messages[1], next.messages[1]);
    assert.equal(merged.messages[2], previous.messages[2]);
  }
});

test('appending fresh messages preserves all previously loaded message references', () => {
  const previous = page(0, 100);
  const next = page(50, 110);
  const merged = mergeLatestPage(previous, next);
  assert.notEqual(merged.messages, previous.messages);
  previous.messages.forEach((message, index) => assert.equal(merged.messages[index], message));
  assert.equal(merged.messages[100], next.messages[50]);
  assert.equal(merged.messages.length, 110);
  assert.equal(merged.session, next.session);
  assert.equal(merged.hasMore, false);
  assert.equal(merged.nextBefore, undefined);
});

test('older page overlap reuses unchanged objects and retains the new pagination metadata', () => {
  const previous = page(20, 60);
  const older = page(0, 30);
  older.messages[25].text = 'Corrected historical message';
  const merged = prependOlderPage(previous, older, 20)!;
  assert.equal(merged.messages[20], previous.messages[0]);
  assert.equal(merged.messages[25], older.messages[25]);
  assert.equal(merged.messages[30], previous.messages[10]);
  assert.equal(merged.messages[0], older.messages[0]);
  assert.equal(merged.session, previous.session);
  assert.equal(merged.hasMore, false);
  assert.equal(merged.nextBefore, undefined);
});

test('an older response with the same ordered messages retains the array while updating the cursor', () => {
  const previous = page(20, 40);
  const older = page(20, 40);
  older.hasMore = false;
  older.nextBefore = undefined;
  const merged = prependOlderPage(previous, older, 20)!;
  assert.equal(merged.messages, previous.messages);
  assert.equal(merged.hasMore, false);
  assert.equal(merged.nextBefore, undefined);
});
