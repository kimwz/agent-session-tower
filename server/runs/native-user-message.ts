import type { ChatMessage } from '../../shared/types.js';
import { latestRequest } from '../../shared/local-command.js';

/** Reads the provider history through Tower's synthetic-to-native mapping, including newly created sessions. */
export async function latestNativeUserMessage(
  mapper: { nativeSessionId(id: string): string }, sessionId: string,
  detail: (nativeId: string) => Promise<{ messages: ChatMessage[]; previousUser?: ChatMessage; skipped?: number } | undefined>,
): Promise<ChatMessage | undefined> {
  const history = await detail(mapper.nativeSessionId(sessionId));
  if (!history || (history.skipped ?? 0) > 0) throw new Error('Native user history could not be read completely.');
  const latest = latestRequest(history.messages);
  const users = [...(history.previousUser ? [history.previousUser] : []), ...(latest ? [latest] : [])];
  return users.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
}
