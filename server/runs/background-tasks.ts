// Background work an agent starts in a turn (a Bash command run in the background, a Monitor, a background
// agent) lives inside Claude's process. Closing Claude's input at the turn's result ends that process, which kills
// the work or drops its completion notice. Tower follows the tasks from the stream instead and keeps the input
// open until each has ended and Claude has taken its notice, so the results reach a follow-up turn of the same run.

type Message = Record<string, any>;
export interface FinishedTask { status: string; summary?: string; outputFile?: string }

/** Longer than a model request takes to start answering. */
const UNSURE_MS = 15_000;
const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped']);
/** Teammates idle between assignments and never finish on their own. */
const OPEN_ENDED_TYPES = new Set(['in_process_teammate']);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type TaskChange = 'started' | 'ended' | undefined;

/** Text of a user message as Claude replays it: a string or text blocks. */
export function messageText(event: Message): string {
  const content = event.message?.content;
  return typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(block => block && typeof block.text === 'string' ? block.text : '').join('\n') : '';
}

export class BackgroundTaskTracker {
  /** Started in the background (or moved there) by the main conversation. */
  private readonly running = new Set<string>();
  /** Started in the foreground; followed only in case they move to the background. */
  private readonly foreground = new Set<string>();
  /**
   * Ended, but Claude has not yet taken the notice. `reply` numbers the model reply under way when it ended (or when
   * that reply was found too close to tell); `unsure` marks a notice only such a close reply may have taken.
   */
  private readonly unread = new Map<string, { task: FinishedTask; endedAt: number; reply: number; unsure?: true }>();
  /** Model replies of the main conversation seen so far, and the one under way. */
  private replies = 0;
  private reply?: string;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  observe(event: Message): TaskChange {
    if (event?.type !== 'system') return undefined;
    const id = event.task_id;
    if (!validId(id)) return undefined;
    if (event.subtype === 'task_started') {
      // Ambient tasks (such as a live monitor feed) are not work of this turn and may never end. A subagent's own
      // tasks report to that subagent; the background agent itself stands for them.
      if (event.ambient === true || event.skip_transcript === true || event.owned_by_subagent === true || OPEN_ENDED_TYPES.has(event.task_type)
        || this.running.has(id) || this.foreground.has(id)) return undefined;
      if (event.is_backgrounded === false) { this.foreground.add(id); return undefined; }
      this.running.add(id);
      return 'started';
    }
    let moved = false;
    if (event.subtype === 'task_updated' && event.patch?.is_backgrounded === true && this.foreground.delete(id)) { this.running.add(id); moved = true; }
    const status = event.subtype === 'task_notification' ? event.status : event.subtype === 'task_updated' ? event.patch?.status : undefined;
    if (!TERMINAL.has(status)) return moved ? 'started' : undefined;
    this.foreground.delete(id);
    const summary = text(event.summary, 300), outputFile = text(event.output_file, 1000);
    const finished: FinishedTask = { status, ...(summary ? { summary } : {}), ...(outputFile ? { outputFile } : {}) };
    // An update carrying only the status usually comes first; its notification adds the summary and output file.
    if (!this.running.delete(id)) {
      if (event.subtype === 'task_notification' && this.unread.has(id)) this.unread.set(id, { task: finished, endedAt: this.now(), reply: this.replies });
      return undefined;
    }
    this.unread.set(id, { task: finished, endedAt: this.now(), reply: this.replies });
    return 'ended';
  }

  /**
   * Claude Code queues a finished task's notice and hands it to the next model request: one inside the turn under
   * way, or a turn of its own. It may also drop a notice whose agent already reported by message. None of that is
   * replayed, so Claude has had a notice once a main-conversation reply starts after the task ended. A reply that
   * starts within `UNSURE_MS` of the end may have been requested before the notice was queued; the next one settles it.
   */
  observeReply(messageId: unknown): void {
    if (typeof messageId === 'string' && messageId && messageId === this.reply) return;
    this.reply = typeof messageId === 'string' ? messageId : undefined;
    this.replies++;
    const now = this.now();
    for (const [id, entry] of this.unread) {
      if (entry.reply >= this.replies) continue;
      if (entry.unsure || now - entry.endedAt >= UNSURE_MS) this.unread.delete(id);
      else this.unread.set(id, { ...entry, reply: this.replies, unsure: true });
    }
  }

  /** Claude starting a turn by itself after its last one ended takes every notice queued by then. */
  observeTurnStart(): void { this.unread.clear(); }

  /** A notice Claude replays names its task. */
  observeReplay(event: Message): void {
    if (!this.unread.size) return;
    const replayed = messageText(event);
    if (!replayed.includes('<task-notification>')) return;
    for (const id of this.unread.keys()) if (new RegExp(`<task-id>\\s*${escape(id)}\\s*</task-id>`).test(replayed)) this.unread.delete(id);
  }

  get runningCount(): number { return this.running.size; }
  /** Tasks still running, or ended without Claude having taken the notice. */
  get outstanding(): number { return this.running.size + this.unread.size; }
  get unreadCount(): number { return this.unread.size; }

  /**
   * Ended tasks whose notice Claude has not taken; Tower hands them over itself, which counts as taken. A notice a
   * reply may have taken is not handed over again: Claude would have started a turn for it by now if it had not.
   */
  takeUnread(): FinishedTask[] {
    const unread = [...this.unread.values()].filter(entry => !entry.unsure).map(entry => entry.task);
    this.unread.clear();
    return unread;
  }
}
