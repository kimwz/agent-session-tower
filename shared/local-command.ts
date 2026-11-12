import type { ChatMessage } from './types.js';

/**
 * A slash command is recorded in the conversation as its name and its output (`<command-name>…`,
 * `<local-command-stdout>…`). One Claude Code runs itself (`/model`, `/effort`) asks Claude nothing; one that prompts
 * Claude (`/goal …`, a skill) is followed by Claude's answer. So a command's record is a request only once Claude
 * answers after it (text or a tool call), before the next thing the person types; its output never is.
 */
export function isLocalCommand(text: string): boolean {
  return /^<(?:command-name|command-message|command-args|local-command-(?:stdout|stderr|caveat))>/.test(text.trimStart());
}

/** A command's output or Claude Code's caveat about it. */
export function isCommandOutput(text: string): boolean {
  return /^<local-command-/.test(text.trimStart());
}

/** Claude answering: what it wrote or a tool it called. */
export function isAnswer(message: Pick<ChatMessage, 'role'>): boolean {
  return message.role === 'assistant' || message.role === 'tool';
}

/** Whether the user message at `index` asked Claude something; `answeredLater` says Claude answered after the last message given. */
export function asksClaude(messages: readonly ChatMessage[], index: number, answeredLater = false): boolean {
  const message = messages[index];
  if (message?.role !== 'user' || !message.text.trim()) return false;
  if (!isLocalCommand(message.text)) return true;
  if (isCommandOutput(message.text)) return false;
  for (const next of messages.slice(index + 1)) {
    if (isAnswer(next)) return true;
    if (next.role === 'user' && !isLocalCommand(next.text)) return false;
  }
  return answeredLater;
}

/** The person's latest request in a page of messages, by the rule above. */
export function latestRequest(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) if (asksClaude(messages, index)) return messages[index];
  return undefined;
}
