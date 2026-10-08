/**
 * A conversation as the compaction model reads it: lines oldest first, cut into parts that each fit one call. What the
 * person and the agent said is kept whole (a long message becomes consecutive segments); tool calls and output, the
 * intermediate work, keep their start and end with a marker for what was left out.
 */
import type { ChatMessage } from '../../../shared/types.js';
import { TOWER_INSTRUCTIONS } from '../parser.js';
import { carriedSummary } from './summary.js';

/** The most one part may hold, in UTF-8 bytes; the native call accepts prompts up to 512 KB. */
export const PART_BYTES = 300_000;
/** One segment of a long message, in characters: small enough that a part always holds several. */
const SEGMENT = 60_000;
const CALL = 2_000;
const RESULT = { head: 1_200, tail: 1_200 };
const ERROR = { head: 2_000, tail: 1_000 };

const omitted = (count: number) => `…[${count.toLocaleString('en-US')} characters omitted]…`;
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
/** The start and the end of a text, with the middle marked as omitted. */
export function excerpt(text: string, keep: { head: number; tail: number }): string {
  if (text.length <= keep.head + keep.tail) return text;
  // `slice(-0)` would be the whole text.
  const tail = keep.tail ? ` ${text.slice(-keep.tail)}` : '';
  return `${text.slice(0, keep.head)} ${omitted(text.length - keep.head - keep.tail)}${tail}`;
}

/**
 * One message as lines: several when it is long, none when it says nothing. Of Tower's hidden instructions only the
 * summary a compacted session started with is read: the earlier session's state this conversation carries on.
 */
export function transcriptLines(message: ChatMessage): string[] {
  const text = message.text.trim();
  if (!text) return [];
  const at = `[${message.timestamp.slice(0, 16).replace('T', ' ')}]`;
  if (message.toolName === TOWER_INSTRUCTIONS) {
    const carried = carriedSummary(text);
    return carried ? [`${at} Summary carried from the session this conversation continues (what that session had established):\n${carried}`] : [];
  }
  if (message.role === 'tool') {
    if (message.toolName === 'result') return [`${at} Tool result${message.isError ? ' (error)' : ''}: ${excerpt(flat(text), message.isError ? ERROR : RESULT)}`];
    return [`${at} Tool ${message.toolName || 'call'}: ${excerpt(flat(text), { head: CALL, tail: 0 })}`];
  }
  const who = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Agent' : 'Notice';
  const segments: string[] = [];
  for (let start = 0; start < text.length; start += SEGMENT) segments.push(text.slice(start, start + SEGMENT));
  return segments.map((segment, index) => `${at} ${who}${segments.length > 1 ? ` (message part ${index + 1}/${segments.length})` : ''}: ${segment}`);
}

/** Lines in order, cut between lines into parts of at most `maxBytes`. */
export function packParts(lines: readonly string[], maxBytes = PART_BYTES): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line) + 2;
    if (current.length && size + bytes > maxBytes) { parts.push(current.join('\n\n')); current = []; size = 0; }
    current.push(line);
    size += bytes;
  }
  if (current.length) parts.push(current.join('\n\n'));
  return parts;
}

/** The messages' lines in order, cut into parts (see `packParts`). */
export function transcriptParts(messages: readonly ChatMessage[], maxBytes = PART_BYTES): string[] {
  return packParts(messages.flatMap(transcriptLines), maxBytes);
}
