import { speakable } from './voice-text.js';

/** The first chunk of a turn goes as soon as it has this much to say; later ones wait for this much, or a pause. */
export const FIRST_CHUNK = 10;
export const LATER_CHUNK = 150;
/** Whole sentences waiting this long since the last chunk go even when short. */
export const CHUNK_PAUSE_MS = 1_200;

const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const fenceClose = (fence: string) => new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
/** A sentence's end inside a line: its mark (not right after a digit, so "1. " and "1.70.0. " go on) and the space after. */
const SENTENCE_END = /(?<![0-9])[.!?…。]+["'”’)]*\s+/g;

/**
 * Follows one reply's text as it is written and gives the next chunk to read aloud: only whole text, cut at a line's
 * end or, inside the line still being written, after a sentence. Never inside a code block (one still open waits) or a
 * table row. Offsets are into the reply's text, which only grows, so nothing is read twice or skipped.
 */
export class TextFollower {
  /** How much of the text was given out. */
  at = 0;

  /**
   * The next chunk, or nothing yet. `first` is the turn's first chunk (short is fine); `paused` whether the pause since
   * the last chunk has passed (whole sentences go then even when short); `done` takes all that is left.
   */
  next(text: string, input: { done: boolean; first: boolean; paused: boolean }): string | undefined {
    const pending = text.slice(this.at);
    if (!pending) return undefined;
    const cut = input.done ? pending.length : wholeUpTo(pending);
    if (cut <= 0) return undefined;
    const chunk = pending.slice(0, cut);
    const size = speakable(chunk).length;
    const ready = input.done || (input.first ? size >= FIRST_CHUNK : size >= LATER_CHUNK || (input.paused && size > 0));
    if (!ready) return undefined;
    this.at += cut;
    return chunk;
  }
}

/** Where the whole text of `pending` ends: after its last complete line outside a code block, or its last sentence. */
function wholeUpTo(pending: string): number {
  let fence = '';
  let cut = 0;
  let start = 0;
  for (;;) {
    const end = pending.indexOf('\n', start);
    if (end < 0) break;
    const line = pending.slice(start, end);
    if (fence) { if (fenceClose(fence).test(line)) fence = ''; }
    else { const open = FENCE_OPEN.exec(line); if (open) fence = open[1]; }
    start = end + 1;
    if (!fence) cut = start;
  }
  // The line still being written: after its last sentence, unless it is inside a code block, opens one, or is a table row.
  if (fence) return cut;
  const line = pending.slice(start);
  if (FENCE_OPEN.test(line) || /^\s*\|/.test(line) || /^ {0,3}[`~]{1,2}$/.test(line)) return cut;
  let last = -1;
  for (const match of line.matchAll(SENTENCE_END)) last = match.index + match[0].length;
  return last > 0 ? start + last : cut;
}
