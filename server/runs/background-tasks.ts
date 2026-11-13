// Background work an agent starts in a turn (a Bash command run in the background, a Monitor, a background
// agent) lives inside Claude's process, and only that process hands Claude its completion notice. Tower follows the
// tasks from the stream and keeps the process's input open while they run. Work a run waits for keeps that run open
// until it has ended and Claude has taken its notice; the rest is detached and only keeps the process.
//
// A background agent can end its own task while background work it started still runs: Claude Code then reports the
// agent as completed ("waiting on its own background work"), and registers it again under the same task id once that
// work reports. The work it started is followed like the main conversation's own; its notice goes to the agent.

type Message = Record<string, any>;
export interface FinishedTask { status: string; summary?: string; outputFile?: string }

/** Longer than a model request takes to start answering. */
const UNSURE_MS = 15_000;
const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped']);
/** Teammates idle between assignments and never finish on their own. */
const OPEN_ENDED_TYPES = new Set(['in_process_teammate']);
/**
 * `service`: a long-lived service run in the background (a dev server, a watcher), which never ends by itself. Only an
 * owner's run ends before those (see claudeProcess). Everything else is `work` a run waits for: background agents,
 * monitors (bounded by their timeout) and any other command, such as an agent CLI, a build or tests.
 */
type Kind = 'service' | 'work';
/** Bash calls kept per conversation (main, subagents) to classify the tasks they start; the most recent ones are enough. */
const MAX_COMMANDS = 200;
const AGENT_CLI = /(?:^|[\s;&|(`/])(?:codex|claude|gemini|opencode|aider)(?=\s|$)/;
/** Longer commands (a heredoc prompt, a script) are not a service started on its own: work. */
const MAX_SERVICE_COMMAND = 2000;
/** A service is what a command runs last: its program first, after prefixes like `nohup` or `VAR=1`. */
const SERVICES = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)(?=\s|$)/,
  /^(?:(?:npx|bunx)\s+|pnpm\s+(?:dlx|exec)\s+)?(?:vite(?!.*\s(?:build|optimize)(?=\s|$))|http-server|live-server|serve|webpack-dev-server|nodemon|watchexec|ngrok)(?=\s|$)/,
  /^(?:(?:npx|bunx)\s+)?(?:next\s+(?:dev|start)|nuxt\s+dev|astro\s+dev|ng\s+serve|webpack\s+serve|hugo\s+server|jekyll\s+serve|tsx\s+watch)(?=\s|$)|^cargo\s+watch(?=\s|$)/,
  /^(?:python[\d.]*\s+(?:-\S+\s+)*-m\s+)?(?:http\.server|uvicorn|gunicorn|hypercorn|flask\s+run)(?=\s|$)|^(?:bundle\s+exec\s+)?rails\s+s(?:erver)?(?=\s|$)|^php\s+-S(?=\s|$)/,
  // An interpreter running a script named for serving, with nothing after it but options.
  /^(?:python[\d.]*|node|bun|tsx|ts-node|deno\s+run|ruby|bash|sh)\s+(?:-\S+\s+)*(?:\S*\/)?(?:(?:dev[-_]?)?server?\.(?:py|js|mjs|cjs|ts|rb|sh)|manage\.py\s+runserver)(?:\s+-\S+)*\s*$/,
  // A Tower of its own, as agents start one to look at a change.
  /^node\s+(?:\S*\/)?agent-session-tower(?:\.mjs)?\s+run(?=\s|$)/,
  /^docker(?:-compose|\s+compose)\s+up(?=\s|$)(?!.*\s(?:-d|--detach|--wait|--no-start|--exit-code-from|--abort-on-container-exit|--abort-on-container-failure)(?=\s|=|$))/,
  /^kubectl\s+port-forward(?=\s|$)/,
  /^tail\s+(?!(?:.*\s)?--pid(?=[=\s]))(?:-\S+\s+)*-[fF](?=\s|$)/,
  // A watch mode of a tool known to keep watching.
  /^(?:(?:npx|bunx)\s+)?(?:tsc|node|deno|bun|vitest|jest|webpack|esbuild|rollup|sass|tailwindcss|postcss)\s.*--watch(?!=(?:false|0)\b)(?=\s|=|$)/,
];
/** What may come after the command that runs, without deciding how long it runs. */
const TRAILING = /^(?:(?:cd|pushd|export|set|ulimit|umask|echo|printf|mkdir|sleep|tee|nvm\s+use)(?=\s|$)|true$|:$|$)/;
const PREFIXES = /^(?:(?:nohup|exec|env|sudo|time)\s+|\w+=\S*\s+)+/;
/** Stands for a quoted string while a command is read. */
const QUOTED = '\u0001';
/** A segment as its program runs it: no redirections, prefixes and program directory dropped, nothing after `--`. */
const program = (segment: string) => segment.replace(/\s>\s*[^\s>]*/g, ' ').trim().replace(PREFIXES, '').replace(/^\w+=\S*$/, '').replace(/^\S*\//, '').replace(/\s--(?=\s|$)[\s\S]*$/, '');
/**
 * Whether a background command is clearly a long-lived service. Commands run one after another, so the last one that
 * is not a trailing `echo`, `sleep`, `tee`… decides how long the whole runs. Anything uncertain, including any shell
 * form this does not read, is work, which a run waits for.
 */
export function longLivedService(command: string): boolean {
  if (command.length > MAX_SERVICE_COMMAND || AGENT_CLI.test(command)) return false;
  // Only plain commands are read. Comments, line continuations, escaped quotes, `||` (the service may never run),
  // command and process substitution and heredocs change what runs in ways a pattern cannot follow: work.
  if (/#|\\\n|\\['"]|\|\||\$\(|<\(|`|<</.test(command)) return false;
  // What is quoted becomes one opaque token (QUOTED): it splits nothing but still stands where it was. A
  // redirection's `&` (`2>&1`, `&>`) separates nothing.
  const runs = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, QUOTED);
  if (/['"]/.test(runs)) return false;
  const last = runs.replace(/(^|\s)\d+(?=[<>])/g, '$1').replace(/>>?&\d*-?|&>>?|>>?|</g, ' > ')
    .split(/&&|[;|\n&]/).map(program).filter(segment => !TRAILING.test(segment)).at(-1);
  // A quoted word in the command that decides can be any name or option (`dev"-check"`, `"--exit-code-from"`): work.
  return last !== undefined && !last.includes(QUOTED) && SERVICES.some(pattern => pattern.test(last));
}
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
  /**
   * What each Bash call runs, by tool use id, classified from its whole command: the main conversation's calls, and
   * subagents' calls apart, so that each decides only what a task of its own conversation is.
   */
  private readonly commands = { main: new Map<string, Kind>(), subagent: new Map<string, Kind>() };
  /**
   * Started by a subagent: Claude hands their notice to that subagent, never to the main conversation, so no notice
   * follows their end for Tower to wait for or hand over.
   */
  private readonly subagentOwned = new Set<string>();
  /** Model replies of the main conversation seen so far, and the one under way. */
  private replies = 0;
  private reply?: string;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  private kindOf(event: Message): Kind {
    if (event.task_type !== 'local_bash') return 'work';
    const commands = event.owned_by_subagent === true ? this.commands.subagent : this.commands.main;
    return (validId(event.tool_use_id) && commands.get(event.tool_use_id)) || 'work';
  }

  /** A Bash call, the main conversation's or a subagent's, names the command its task runs: a task starts after its tool use. */
  private observeToolUses(event: Message): void {
    const commands = event.parent_tool_use_id == null ? this.commands.main : this.commands.subagent;
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block?.type !== 'tool_use' || !validId(block.id)) continue;
      // A monitor ends at its timeout unless it was made persistent.
      const kind: Kind | undefined = block.name === 'Bash' && typeof block.input?.command === 'string' ? longLivedService(block.input.command) ? 'service' : 'work'
        : block.name === 'Monitor' && block.input?.persistent === true ? 'service' : undefined;
      if (!kind) continue;
      commands.delete(block.id); commands.set(block.id, kind);
      if (commands.size > MAX_COMMANDS) commands.delete(commands.keys().next().value!);
    }
  }

  observe(event: Message): TaskChange {
    if (event?.type === 'assistant') { this.observeToolUses(event); return undefined; }
    if (event?.type !== 'system') return undefined;
    const id = event.task_id;
    if (!validId(id)) return undefined;
    if (event.subtype === 'task_started') {
      // Ambient tasks (such as a live monitor feed) are not work of this turn and may never end.
      if (event.ambient === true || event.skip_transcript === true || OPEN_ENDED_TYPES.has(event.task_type)
        || this.running.has(id) || this.foreground.has(id) || this.detached.has(id)) return undefined;
      if (event.owned_by_subagent === true) this.subagentOwned.add(id); else this.subagentOwned.delete(id);
      if (event.is_backgrounded === false) { this.foreground.set(id, this.kindOf(event)); return undefined; }
      this.running.set(id, this.kindOf(event));
      return 'started';
    }
    let moved = false;
    const kind = this.foreground.get(id);
    if (event.subtype === 'task_updated' && event.patch?.is_backgrounded === true && kind) { this.foreground.delete(id); this.running.set(id, kind); moved = true; }
    const status = event.subtype === 'task_notification' ? event.status : event.subtype === 'task_updated' ? event.patch?.status : undefined;
    if (!TERMINAL.has(status)) return moved ? 'started' : undefined;
    this.foreground.delete(id);
    // Its notice goes to the subagent that started it, which Claude then resumes as a task of its own. A notification
    // after its status update finds it gone and changes nothing.
    if (this.subagentOwned.delete(id)) return this.running.delete(id) || this.detached.delete(id) ? 'ended' : undefined;
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
  /** Running tasks a run waits for: its work, and services too when `services` (see Kind). */
  holding(services: boolean): number { return services ? this.running.size : [...this.running.values()].filter(kind => kind === 'work').length; }
  /** Tasks still running, or ended without Claude having taken the notice, that a run waits for. */
  get outstanding(): number { return this.running.size + this.unreadCount; }
  get unreadCount(): number { return [...this.unread.values()].filter(entry => !entry.detached).length; }
  /** Detached tasks still running, or ended without Claude having taken the notice yet: they keep the process. */
  get detachedCount(): number { return this.detached.size + this.unread.size - this.unreadCount; }
  /** Detached tasks that ended and whose notice Claude has not taken yet. */
  get detachedUnreadCount(): number { return this.unread.size - this.unreadCount; }

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
