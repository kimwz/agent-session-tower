import type { ChatMessage } from './types.js';

/**
 * A slash command is recorded in the conversation as its name and its output (`<command-name>…`,
 * `<local-command-stdout>…`). One Claude Code runs itself (`/model`, `/effort`) asks Claude nothing; one that prompts
 * Claude (`/goal …`, a skill) is followed by Claude's answer. So a command's record is a request only once Claude
 * answers after it, before the next thing the person types.
 */
export function isLocalCommand(text: string): boolean {
  return /^<(?:command-name|command-message|command-args|local-command-(?:stdout|stderr|caveat))>/.test(text.trimStart());
}

/** Whether the user message at `index` asked Claude something: plain text does; a command's record does when Claude answers it. */
export function asksClaude(messages: readonly ChatMessage[], index: number): boolean {
  const message = messages[index];
  if (message?.role !== 'user' || !message.text.trim()) return false;
  if (!isLocalCommand(message.text)) return true;
  // A command's output and Claude Code's caveat are never what the person asked.
  if (/^<local-command-/.test(message.text.trimStart())) return false;
  for (const next of messages.slice(index + 1)) {
    if (next.role === 'assistant') return true;
    if (next.role === 'user' && !isLocalCommand(next.text)) return false;
  }
  return false;
}

/** The person's latest request in a page of messages, by the rule above. */
export function latestRequest(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) if (asksClaude(messages, index)) return messages[index];
  return undefined;
}
