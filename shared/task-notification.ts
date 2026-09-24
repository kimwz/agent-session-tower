/** How a background task's notice is named in a conversation; the page shows it in the reader's language. */
export const TASK_NOTICE = 'Background task';

/** Claude Code writes the end of a background task it started into the conversation as a user turn, tagged like this. */
export function isTaskNotification(text: string): boolean { return text.trimStart().startsWith('<task-notification>'); }

/**
 * What a background task's notice says, for reading: its status and summary, and what the task reported. File paths,
 * ids and the instruction meant for the agent are left out; a notice without those tags reads as written.
 */
export function taskNotice(raw: string): { text: string; failed: boolean } {
  const tag = (name: string) => raw.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '';
  const [status, summary] = [tag('status'), tag('summary')];
  const parts = [status && summary ? `**${status}** · ${summary}` : status || summary, tag('event'), tag('result')].filter(Boolean);
  return { text: parts.length ? parts.join('\n\n') : raw.replace(/<\/?task-notification>/g, '').trim(), failed: /^(failed|killed|error)$/i.test(status) };
}
