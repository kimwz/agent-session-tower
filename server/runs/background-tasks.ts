// Background work an agent starts in a turn (a Bash command run in the background, a Monitor, a background
// agent) lives inside Claude's process. Closing Claude's input at the turn's result ends that process, which kills
// the work or drops its completion notice. Tower follows the tasks from the stream instead and keeps the input
// open until each has ended and Claude has taken its notice, so the results reach a follow-up turn of the same run.

type Message = Record<string, any>;
export interface FinishedTask { status: string; summary?: string; outputFile?: string }

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
  /** Ended, but Claude has not yet taken the notice. */
  private readonly unread = new Map<string, FinishedTask>();

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
      if (event.subtype === 'task_notification' && this.unread.has(id)) this.unread.set(id, finished);
      return undefined;
    }
    this.unread.set(id, finished);
    return 'ended';
  }

  /** Claude replays each notice it takes into the conversation as a user message naming the task. */
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

  /** Ended tasks whose notice Claude has not taken; Tower hands them over itself, which counts as taken. */
  takeUnread(): FinishedTask[] { const unread = [...this.unread.values()]; this.unread.clear(); return unread; }
}
