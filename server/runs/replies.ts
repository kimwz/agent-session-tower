import type { Run, RunReply } from '../../shared/types.js';

/** At most this many replies and characters are kept on a run; the oldest whole replies go first. */
export const MAX_REPLIES = 60;
export const MAX_REPLY_CHARS = 24_000;

/**
 * Keeps a master turn's replies (`Run.replies`) as the agent writes them. A reply's text only grows, and is never cut
 * at its start: one that gets too long stops growing (`cut`), and past the run's bounds the oldest whole replies are
 * dropped. Either marks the run `repliesTrimmed`, so its replies are not taken for every word of the turn.
 */
export class ReplyLog {
  constructor(private readonly run: Run, private readonly clock?: () => number) {}

  /** Adds text to a reply, opening it first if it is new. False when nothing changed. */
  add(id: string, text: string, done = false): boolean {
    const replies = this.run.replies ??= [];
    let reply = replies.find(item => item.id === id);
    let changed = false;
    if (!reply) { reply = { id, text: '' }; replies.push(reply); changed = true; }
    if (reply.done) return false;
    const firstText = Boolean(text) && reply.firstAt === undefined;
    const observedAt = this.clock && (firstText || done) ? this.clock() : undefined;
    if (firstText && observedAt !== undefined) reply.firstAt = observedAt;
    if (text && !reply.cut) {
      const room = MAX_REPLY_CHARS - reply.text.length;
      if (text.length > room) { reply.text += text.slice(0, Math.max(0, room)); reply.cut = true; this.run.repliesTrimmed = true; }
      else reply.text += text;
      changed = true;
    }
    if (done) {
      reply.done = true;
      if (observedAt !== undefined) reply.completedAt = observedAt;
      changed = true;
    }
    this.bound();
    return changed;
  }

  /** A reply is complete. */
  finish(id: string): boolean {
    const reply = this.run.replies?.find(item => item.id === id);
    if (!reply || reply.done) return false;
    reply.done = true;
    if (this.clock) reply.completedAt = this.clock();
    return true;
  }

  /** Whether a reply is known, whatever its text. */
  has(id: string): boolean { return Boolean(this.run.replies?.some(item => item.id === id)); }

  private bound(): void {
    const replies = this.run.replies!;
    const total = () => replies.reduce((sum, reply: RunReply) => sum + reply.text.length, 0);
    // The newest reply always stays.
    while (replies.length > 1 && (replies.length > MAX_REPLIES || total() > MAX_REPLY_CHARS)) { replies.shift(); this.run.repliesTrimmed = true; }
  }
}
