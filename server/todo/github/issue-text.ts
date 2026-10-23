import { createHash } from 'node:crypto';
import { labelName } from '../../../shared/todo/ops.js';
import type { TodoPriority } from '../../../shared/todo/types.js';

/**
 * What a todo and its comments look like on GitHub, and back. Tower's own lines go below `SEPARATOR` in an issue or a
 * comment, so what someone writes on GitHub is everything above it; an agent's comment starts with `AGENT_HEADER`.
 */

export const SEPARATOR = '<!-- tower -->';
export const AGENT_HEADER = '**🤖 via an agent**';
/** Headers agent comments carried before, still taken off what comes back from GitHub. */
const OLD_AGENT_HEADERS = ['**🤖 Agent** · via Tower'];
const AGENT_TODO = '— 🤖 Agent가 Tower에서 만든 할 일';
const TITLE_MAX = 256;

/** Files GitHub shows in a body when gh uploads them (`gh issue edit --attach`), and the extension each is saved under. */
export const UPLOADABLE: Record<string, { ext: string; video: boolean; maxBytes: number }> = {
  'image/png': { ext: 'png', video: false, maxBytes: 10 * 1024 * 1024 },
  'image/jpeg': { ext: 'jpg', video: false, maxBytes: 10 * 1024 * 1024 },
  'image/gif': { ext: 'gif', video: false, maxBytes: 10 * 1024 * 1024 },
  'image/webp': { ext: 'webp', video: false, maxBytes: 10 * 1024 * 1024 },
  'image/svg+xml': { ext: 'svg', video: false, maxBytes: 10 * 1024 * 1024 },
  'video/mp4': { ext: 'mp4', video: true, maxBytes: 100 * 1024 * 1024 },
  'video/quicktime': { ext: 'mov', video: true, maxBytes: 100 * 1024 * 1024 },
  'video/webm': { ext: 'webm', video: true, maxBytes: 100 * 1024 * 1024 },
};

export const uploadable = (file: { mimeType: string; size: number }) => {
  const kind = UPLOADABLE[file.mimeType];
  return !!kind && file.size <= kind.maxBytes;
};

/** A file as an issue or comment shows it: its uploaded address, or just its name when it is not on GitHub. */
export interface ShownFile { name: string; mimeType: string; url?: string }

function fileLine(file: ShownFile): string {
  if (!file.url) return `📎 ${file.name} (Tower에 있음)`;
  // A video address on a line of its own plays in GitHub; an image needs Markdown.
  return UPLOADABLE[file.mimeType]?.video ? file.url : `![${file.name.replace(/[[\]\n]/g, ' ')}](${file.url})`;
}

const withLines = (text: string, lines: string[]) => lines.length ? `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${SEPARATOR}\n${lines.join('\n\n')}` : text;

export function issueBody(description: string, extra: { files: ShownFile[]; byAgent: boolean; parentNumber: number | null }): string {
  return withLines(description, [...extra.files.map(fileLine), ...(extra.byAgent ? [AGENT_TODO] : []), ...(extra.parentNumber ? [`상위: #${extra.parentNumber}`] : [])]);
}

export function commentBody(body: string, extra: { byAgent: boolean; files: ShownFile[] }): string {
  return withLines(extra.byAgent ? `${AGENT_HEADER}\n\n${body}` : body, extra.files.map(fileLine));
}

/** What someone wrote: a body without Tower's lines below the separator, nor the agent header. */
export function writtenPart(body: string | null | undefined): string {
  let text = (body ?? '').replace(/\r\n/g, '\n');
  const cut = text.indexOf(SEPARATOR);
  if (cut >= 0) text = text.slice(0, cut);
  const header = [AGENT_HEADER, ...OLD_AGENT_HEADERS].find(known => text.startsWith(known));
  if (header) text = text.slice(header.length);
  return text.trim();
}

export const issueTitle = (content: string) => content.length > TITLE_MAX ? `${content.slice(0, TITLE_MAX - 1)}…` : content;

/** The issue a todo makes, as one value: what is sent, and what its hash says GitHub shows. */
export interface IssueContent { title: string; body: string; state: 'open' | 'closed'; reason: 'completed' | 'not_planned' | null; labels: string[] }

export const contentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const issueHash = (issue: IssueContent) => contentHash({ ...issue, labels: issue.labels.map(name => name.toLowerCase()).sort() });

const PRIORITY = /^p([1-3])$/i;
export const priorityLabel = (priority: TodoPriority) => priority < 4 ? `P${priority}` : undefined;

/** A GitHub label list as Tower keeps it: the most urgent `P1`–`P3`, labels Tower can name, and the rest it cannot. */
export function sortLabels(names: readonly string[]): { priority: TodoPriority; tower: string[]; extra: string[] } {
  let priority: TodoPriority = 4;
  const tower: string[] = [], extra: string[] = [];
  for (const name of names) {
    const level = PRIORITY.exec(name);
    if (level) priority = Math.min(priority, Number(level[1])) as TodoPriority;
    else if (labelName.safeParse(name).success) tower.push(name);
    else extra.push(name);
  }
  return { priority, tower, extra };
}

/** The address gh put last in a body: the file it just uploaded. */
export function lastAssetUrl(body: string | null | undefined): string | undefined {
  const found = (body ?? '').match(/https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+/g);
  return found?.at(-1);
}
