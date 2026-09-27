/** How a background task's notice is named in a conversation; the page shows it in the reader's language. */
export const TASK_NOTICE = 'Background task';
/** How Tower's own messages to Claude begin. Tower sends one only to hand over finished background work. */
export const TOWER_NOTICE = '[Agent Session Tower]';

const FAILED = /^(failed|killed|error)$/i;

/**
 * Claude Code writes the end of a background task it started into the conversation as a user turn, tagged like this.
 * Tower's own hand-over of finished background work is the same kind of notice.
 */
export function isTaskNotification(text: string): boolean {
  const start = text.trimStart();
  return start.startsWith('<task-notification>') || start.startsWith(TOWER_NOTICE);
}

/**
 * What a background task's notice says, for reading: its status and summary, and what the task reported. File paths,
 * ids and the instruction meant for the agent are left out; a notice without those tags reads as written.
 */
export function taskNotice(raw: string): { text: string; failed: boolean } {
  if (raw.trimStart().startsWith(TOWER_NOTICE)) return towerNotice(raw);
  const tag = (name: string) => raw.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '';
  const [status, summary] = [tag('status'), tag('summary')];
  const parts = [status && summary ? `**${status}** · ${summary}` : status || summary, tag('event'), tag('result')].filter(Boolean);
  return { text: parts.length ? parts.join('\n\n') : raw.replace(/<\/?task-notification>/g, '').trim(), failed: FAILED.test(status) };
}

/** Tower lists each finished task as `- status: summary (output: path)` and ends with an instruction to Claude. */
function towerNotice(raw: string): { text: string; failed: boolean } {
  let failed = false;
  const tasks = raw.split('\n').flatMap(line => {
    const task = line.match(/^- (\w+)(?:: (.*?))?(?: \(output: [^)]*\))?\s*$/);
    if (!task) return [];
    if (FAILED.test(task[1]!)) failed = true;
    return [task[2] ? `**${task[1]}** · ${task[2]}` : `**${task[1]}**`];
  });
  return { text: tasks.length ? tasks.join('\n\n') : raw.trim().slice(TOWER_NOTICE.length).split('\n')[0]!.trim(), failed };
}
