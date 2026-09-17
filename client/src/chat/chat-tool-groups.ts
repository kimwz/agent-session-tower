import type { ChatMessage } from '../../../shared/types';

export interface ToolGroup {
  kind: 'tools';
  id: string;
  messages: readonly ChatMessage[];
  workCount: number;
  errorCount: number;
}

export type ChatEntry = { kind: 'message'; message: ChatMessage } | ToolGroup;

function countWork(messages: readonly ChatMessage[]): Pick<ToolGroup, 'workCount' | 'errorCount'> {
  const tools = messages.filter(message => message.role === 'tool');
  const calls = new Map(tools.filter(message => message.toolName !== 'result').map(message => [message.id, message]));
  const resultCallId = (message: ChatMessage) => message.id.endsWith(':result') ? message.id.slice(0, -7) : '';
  const matchedCallIds = new Set(tools.filter(message => message.toolName === 'result').map(resultCallId));
  const pending: ChatMessage[] = [];
  let nextPending = 0;
  const work = new Set<ChatMessage>();
  const errors = new Set<ChatMessage>();

  for (const message of tools) {
    let operation = message;
    if (message.toolName === 'result') {
      const exactCall = calls.get(resultCallId(message));
      if (exactCall) operation = exactCall;
      // Codex can give a call and its result different IDs. Pair unmatched
      // outputs with preceding calls, while keeping leading page outputs.
      else if (nextPending < pending.length) operation = pending[nextPending++];
    } else if (!matchedCallIds.has(message.id)) pending.push(message);
    work.add(operation);
    if (message.isError) errors.add(operation);
  }
  return { workCount: work.size, errorCount: errors.size };
}

/** Only user and assistant prose separate adjacent tool and session records. */
export function groupConsecutiveTools(messages: readonly ChatMessage[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  for (let index = 0; index < messages.length;) {
    const first = messages[index++];
    if (first.role !== 'tool' && first.role !== 'system') {
      entries.push({ kind: 'message', message: first });
      continue;
    }
    const start = index - 1;
    while (index < messages.length && (messages[index].role === 'tool' || messages[index].role === 'system')) index++;
    const records = messages.slice(start, index);
    entries.push({ kind: 'tools', id: first.id, messages: records, ...countWork(records) });
  }
  return entries;
}
