// Background work an agent starts in a turn (a Bash command run in the background, a Monitor, a background
// agent) lives inside Claude's process, and only that process hands Claude its completion notice. Tower follows the
// tasks from the stream and keeps the process's input open while they run. Work a run waits for keeps that run open
// until it has ended and Claude has taken its notice; the rest is detached and only keeps the process.

type Message = Record<string, any>;
export interface FinishedTask { status: string; summary?: string; outputFile?: string }

/** Longer than a model request takes to start answering. */
const UNSURE_MS = 15_000;
const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped']);
/** Teammates idle between assignments and never finish on their own. */
const OPEN_ENDED_TYPES = new Set(['in_process_teammate']);
/**
 * Processes left running: a command run in the background or a monitor's feed. They may be services (a dev server, a
 * watcher) that never end, unlike a background agent. Claude Code groups the same task types as processes.
 */
const PROCESS_TYPES = new Set(['local_bash', 'monitor_mcp', 'monitor_ws']);
type Kind = 'process' | 'work';
const kindOf = (event: Message): Kind => PROCESS_TYPES.has(event.task_type) ? 'process' : 'work';
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
  private readonly running = new Map<string, Kind>();
  /** Started in the foreground; followed only in case they move to the background. */
  private readonly foreground = new Map<string, Kind>();
  /** Still running, but no run waits for them any more (see detach). */
  private readonly detached = new Set<string>();
  /**
   * Ended, but Claude has not yet taken the notice. `reply` numbers the model reply under way when it ended (or when
   * that reply was found too close to tell); `unsure` marks a notice only such a close reply may have taken.
   */
  private readonly unread = new Map<string, { task: FinishedTask; endedAt: number; reply: number; unsure?: true; detached?: true }>();
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
        || this.running.has(id) || this.foreground.has(id) || this.detached.has(id)) return undefined;
      if (event.is_backgrounded === false) { this.foreground.set(id, kindOf(event)); return undefined; }
      this.running.set(id, kindOf(event));
      return 'started';
    }
    let moved = false;
    const kind = this.foreground.get(id);
    if (event.subtype === 'task_updated' && event.patch?.is_backgrounded === true && kind) { this.foreground.delete(id); this.running.set(id, kind); moved = true; }
    const status = event.subtype === 'task_notification' ? event.status : event.subtype === 'task_updated' ? event.patch?.status : undefined;
    if (!TERMINAL.has(status)) return moved ? 'started' : undefined;
    this.foreground.delete(id);
    const summary = text(event.summary, 300), outputFile = text(event.output_file, 1000);
    const finished: FinishedTask = { status, ...(summary ? { summary } : {}), ...(outputFile ? { outputFile } : {}) };
    // Nobody waits for it: Claude takes its notice by itself, which only keeps its process a moment longer.
    if (this.detached.delete(id)) { this.unread.set(id, { task: finished, endedAt: this.now(), reply: this.replies, detached: true }); return 'ended'; }
    // An update carrying only the status usually comes first; its notification adds the summary and output file.
    if (!this.running.delete(id)) {
      const entry = this.unread.get(id);
      if (event.subtype === 'task_notification' && entry) this.unread.set(id, { ...entry, task: finished, endedAt: this.now(), reply: this.replies });
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
  /** Running tasks a run waits for: background work, and processes too when `processes` (see PROCESS_TYPES). */
  holding(processes: boolean): number { return processes ? this.running.size : [...this.running.values()].filter(kind => kind === 'work').length; }
  /** Tasks still running, or ended without Claude having taken the notice, that a run waits for. */
  get outstanding(): number { return this.running.size + this.unreadCount; }
  get unreadCount(): number { return [...this.unread.values()].filter(entry => !entry.detached).length; }
  /** Detached tasks still running, or ended without Claude having taken the notice yet: they keep the process. */
  get detachedCount(): number { return this.detached.size + this.unread.size - this.unreadCount; }

  /** No run waits for what runs now: it only keeps the process (a run that ends before its background work). */
  detach(): void {
    for (const id of this.running.keys()) this.detached.add(id);
    this.running.clear();
    for (const [id, entry] of this.unread) this.unread.set(id, { ...entry, detached: true });
  }

  /**
   * Ended tasks whose notice Claude has not taken; Tower hands them over itself, which counts as taken. A notice a
   * reply may have taken is not handed over again: Claude would have started a turn for it by now if it had not.
   */
  takeUnread(): FinishedTask[] {
    const unread = [...this.unread.values()].filter(entry => !entry.unsure && !entry.detached).map(entry => entry.task);
    this.unread.clear();
    return unread;
  }

  /** Forgets notices of detached tasks Claude did not take: nothing waits for them. */
  dropDetachedUnread(): void { for (const [id, entry] of this.unread) if (entry.detached) this.unread.delete(id); }
}
