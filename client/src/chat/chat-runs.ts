import type { Attachment, ChatMessage, Run } from '../../../shared/types';
import { isImageAttachment } from '../../../shared/attachments';

export interface ChatRunMatch {
  runId: string;
  text: string;
  attachments?: readonly Attachment[];
}

const attachmentMarker = '\n\n첨부 파일 (사용자가 이번 메시지에 첨부한 로컬 파일):\n';
const defaultAttachmentPrompt = '첨부한 파일을 확인하고 내용을 설명해 주세요.';
const clockAllowance = 1000;
const initialMessageWindow = 120_000;
const normalize = (value: string) => value.replace(/\r\n?/g, '\n').trim();

function requestContent(run: Run): string {
  const attachments = run.attachments || [];
  return JSON.stringify([
    normalize(run.prompt || (attachments.length ? defaultAttachmentPrompt : '')),
    attachments.map(({ id, name, mimeType, size }) => [id, name, mimeType, size]),
  ]);
}

function matchesAttachmentPrompt(text: string, run: Run): boolean {
  const attachments = run.attachments;
  if (!attachments?.length) return false;
  const markerAt = text.lastIndexOf(attachmentMarker);
  if (markerAt < 0) return false;
  const lines = text.slice(markerAt + attachmentMarker.length).split('\n');
  const paths: string[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const prefix = `- ${JSON.stringify(attachment.name)} (${attachment.mimeType}, ${attachment.size} bytes): `;
    if (!lines[index]?.startsWith(prefix)) return false;
    try {
      const path: unknown = JSON.parse(lines[index].slice(prefix.length));
      if (typeof path !== 'string' || !path.startsWith('/') || !path.endsWith(`/attachments/${attachment.id}/content/${attachment.name}`)) return false;
      paths.push(path);
    } catch { return false; }
  }
  const instruction = normalize(run.prompt || defaultAttachmentPrompt);
  const images = attachments.flatMap((attachment, index) => isImageAttachment(attachment.mimeType) ? [paths[index]] : []);
  const leadingImages = images.map((path, index) => `<image name=[Image #${index + 1}] path="${path}">\n[Image attachment]\n</image>\n`).join('');
  const before = text.slice(0, markerAt);
  const after = lines.slice(attachments.length).join('\n');
  // Match only the wrapper emitted by Monitor and the known native image forms.
  // An unfamiliar prefix or suffix remains visible as the original user message.
  if (before === instruction) return after === '' || (images.length > 0 && after === images.map(() => '[Image attachment]').join('\n'));
  return images.length > 0 && before === leadingImages + instruction && after === '';
}

/** Associate native user rows without adding, removing or reordering any message. */
export function matchChatRuns(messages: readonly ChatMessage[], runs: readonly Run[], sessionId: string) {
  const matches = new Map<string, ChatRunMatch>();
  const matchedRunIds = new Set<string>();
  const users = messages.filter(message => message.role === 'user').map(message => ({ message, timestamp: Date.parse(message.timestamp), text: normalize(message.text) }));
  const candidates = runs.filter(run => run.sessionId === sessionId && run.status !== 'queued')
    .map(run => ({ run, start: Date.parse(run.startedAt || run.createdAt), content: requestContent(run) }))
    .filter(candidate => Number.isFinite(candidate.start))
    .sort((first, second) => first.start - second.start || Date.parse(first.run.createdAt) - Date.parse(second.run.createdAt));

  for (const [index, { run, start, content }] of candidates.entries()) {
    const finish = run.finishedAt ? Date.parse(run.finishedAt) : undefined;
    if (finish !== undefined && (!Number.isFinite(finish) || finish < start - clockAllowance)) continue;
    let end = Math.min(start + initialMessageWindow, finish === undefined ? Infinity : finish + clockAllowance);
    const nextStart = candidates.slice(index + 1).find(candidate => candidate.start > start && candidate.content === content)?.start;
    // The preceding run must not claim a repeated prompt from the next run,
    // including when the earlier native row lies outside the loaded history page.
    // Only identical requests compete. Split the gap after this run finishes so
    // quick subsequent requests cannot remove a valid row from its own interval.
    if (nextStart !== undefined) {
      const previousBoundary = finish !== undefined && finish <= nextStart ? finish : start;
      const allowance = Math.min(clockAllowance, (nextStart - previousBoundary) / 2);
      end = Math.min(end, nextStart - allowance);
    }
    const prompt = normalize(run.prompt);
    const match = users.find(({ message, timestamp, text }) => !matches.has(message.id)
      && Number.isFinite(timestamp) && timestamp >= start - clockAllowance && timestamp <= end
      && ((!run.attachments?.length && prompt !== '' && text === prompt) || matchesAttachmentPrompt(text, run)));
    if (!match) continue;
    matches.set(match.message.id, { runId: run.id, text: run.prompt, ...(run.attachments?.length ? { attachments: run.attachments } : {}) });
    matchedRunIds.add(run.id);
  }
  return { matches, matchedRunIds };
}
