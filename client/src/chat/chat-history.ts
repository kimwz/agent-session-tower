import type { ChatMessage, SessionDetail } from '../../../shared/types';

export type ChatHistory = SessionDetail & { resetToLatest?: boolean };

function unchangedMessage(previous: ChatMessage | undefined, next: ChatMessage): boolean {
  return previous !== undefined && previous.id === next.id && previous.role === next.role
    && previous.text === next.text && previous.timestamp === next.timestamp
    && previous.toolName === next.toolName && previous.isError === next.isError
    && JSON.stringify(previous.images) === JSON.stringify(next.images);
}

function stableMessages(previous: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  return previous.length === next.length && previous.every((message, index) => message === next[index]) ? previous : next;
}

/** Keep a contiguous window: disconnected pages must remain reachable by their cursor. */
export function mergeLatestPage(previous: ChatHistory | null, next: SessionDetail): ChatHistory {
  if (!previous || previous.session.id !== next.session.id) return next;
  const messages = new Map(previous.messages.map(message => [message.id, message]));
  const incoming = next.messages.map(message => {
    const existing = messages.get(message.id);
    return unchangedMessage(existing, message) ? existing! : message;
  });
  if (!previous.messages.length) return { ...next, messages: stableMessages(previous.messages, incoming) };
  if (next.session.messageCount < previous.session.messageCount || !next.messages.some(message => messages.has(message.id))) {
    return { ...next, messages: stableMessages(previous.messages, incoming), resetToLatest: true };
  }
  incoming.forEach(message => messages.set(message.id, message));
  const nextBefore = previous.nextBefore === undefined ? undefined : Math.min(previous.nextBefore, next.nextBefore ?? previous.nextBefore);
  // The message before the window is the one before its earliest page.
  const previousUser = nextBefore === undefined ? undefined : nextBefore === previous.nextBefore ? previous.previousUser : next.previousUser;
  return {
    ...next,
    messages: stableMessages(previous.messages, [...messages.values()]),
    hasMore: previous.hasMore && next.hasMore,
    nextBefore,
    previousUser,
    resetToLatest: previous.resetToLatest,
  };
}

export function prependOlderPage(previous: ChatHistory | null, older: SessionDetail, requestedBefore: number): ChatHistory | null {
  // A reconnect may have replaced the visible window while this request was in flight.
  if (!previous || previous.session.id !== older.session.id || previous.nextBefore !== requestedBefore) return previous;
  const seen = new Set(older.messages.map(message => message.id));
  const existing = new Map(previous.messages.map(message => [message.id, message]));
  const incoming = older.messages.map(message => {
    const loaded = existing.get(message.id);
    return unchangedMessage(loaded, message) ? loaded! : message;
  });
  return {
    ...previous,
    messages: stableMessages(previous.messages, [...incoming, ...previous.messages.filter(message => !seen.has(message.id))]),
    hasMore: older.hasMore,
    nextBefore: older.nextBefore,
    previousUser: older.previousUser,
    resetToLatest: previous.resetToLatest && older.hasMore,
  };
}
