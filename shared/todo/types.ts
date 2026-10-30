/**
 * The owner's todo list: projects, sections, labels and tasks, kept apart from agent sessions. Dates are floating
 * local dates (`YYYY-MM-DD`) and times (`HH:mm`); `*At` fields are ISO instants. Priority 1 is the most urgent and 4
 * means none, as in Todoist's P1–P4.
 */

export type TodoPriority = 1 | 2 | 3 | 4;
export type TodoLayout = 'board' | 'calendar';

export interface TodoRecurrence {
  freq: 'day' | 'week' | 'month' | 'year';
  /** Every `interval` days, weeks, months or years. */
  interval: number;
  /** `day`: count Monday–Friday only. */
  workdays?: boolean;
  /** `week`: the weekdays (0 = Sunday). Filled in from the date when a rule is saved. */
  weekdays?: number[];
  /** `month`: days of the month, -1 for the last day; a day the month lacks becomes its last day. */
  monthDays?: number[];
  /** `month`: the nth (or last, -1) weekday instead of `monthDays`. */
  nth?: { n: 1 | 2 | 3 | 4 | 5 | -1; weekday: number };
  /** `year`: month and day, filled in from the date when a rule is saved. */
  yearDate?: [number, number];
  /** The next date counts from the day the task was completed (`every!`). */
  fromCompletion?: boolean;
  /** No occurrence after this date; completing the last one completes the task. */
  until?: string;
}

interface Stamped { createdAt: string; updatedAt: string; deletedAt: string | null }

export interface TodoProject extends Stamped {
  id: string;
  parentId: string | null;
  name: string;
  color: string;
  favorite: boolean;
  inbox: boolean;
  layout: TodoLayout;
  archivedAt: string | null;
  sortKey: string;
}

export interface TodoSection extends Stamped {
  id: string;
  projectId: string;
  name: string;
  collapsed: boolean;
  archivedAt: string | null;
  sortKey: string;
}

export interface TodoLabel extends Stamped {
  id: string;
  name: string;
  color: string;
  favorite: boolean;
  sortKey: string;
}

export interface TodoTask extends Stamped {
  id: string;
  projectId: string;
  sectionId: string | null;
  parentId: string | null;
  content: string;
  description: string;
  priority: TodoPriority;
  dueDate: string | null;
  dueTime: string | null;
  recurrence: TodoRecurrence | null;
  durationMin: number | null;
  deadlineDate: string | null;
  labelIds: string[];
  sortKey: string;
  /**
   * Its place among the tasks of its date, set by hand in the date lists: `<YYYY-MM-DD>|<sortKey>`. It counts only while
   * the date is the task's date (see shared/todo/day-order.ts), so moving or repeating a task needs no reset.
   */
  dayOrder: string | null;
  completedAt: string | null;
  /** The GitHub issue it is synced with (`owner/name#number`, server/todo/github/): its text may come from outside. */
  github?: string;
  /** The Slack thread it came from (shared/todo/slack-thread.ts); absent when none. */
  slackThread?: TodoSlackThread;
}

/** A Slack thread by its ids: the thread's first message `threadTs` in `channel` of workspace `teamId`. */
export interface TodoSlackThread { teamId: string; channel: string; threadTs: string }

/** A task's direct sub-tasks that are not deleted, and how many of them are completed. */
export interface TodoSubtaskCount { done: number; total: number }

/** One task follows another (`next`): an order only, never a condition on either task. */
export interface TodoLink {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  kind: 'next';
  createdAt: string;
}

/** Who wrote a comment: the owner on their own page, or an agent (the todo tools, the master, a local agent). */
export type TodoCommentAuthor = 'owner' | 'agent';

export interface TodoComment extends Stamped {
  id: string;
  taskId: string;
  body: string;
  /** Decided by the server from how the comment arrived; null where it was not recorded (before 1.162.0, or an older build). */
  author: TodoCommentAuthor | null;
  /** Written on GitHub and brought in by the GitHub sync (author null): outside content, read-only here. */
  external?: { source: 'github'; login: string; url: string };
}

export interface TodoCompletion {
  id: string;
  taskId: string;
  /** The date that was done: a repeating task's occurrence, or the task's date. */
  occurrenceDate: string | null;
  completedAt: string;
  /** The completion that closed it with its own (a parent completed with its open sub-tasks), when one did. */
  causeId?: string;
}

export type TodoEventKind = 'created' | 'updated' | 'moved' | 'completed' | 'uncompleted' | 'deleted' | 'restored' | 'linked' | 'unlinked' | 'commented' | 'attached';

/** A file is at most this large; it is sent in pieces of `UPLOAD_CHUNK_BYTES` (shared/attachments.ts). */
export const TODO_FILE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * A file attached to a task's description (`commentId` null) or to one of its comments. It shows while it is not
 * deleted, its task is not deleted, and its comment (if any) is not deleted: deleting and restoring a task or comment
 * never changes the file itself, so the page works out what shows from those three.
 */
export interface TodoFile {
  id: string;
  taskId: string;
  commentId: string | null;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  deletedAt: string | null;
  /** Its contents are not on this computer (a restore could not bring them back). Only in a task's detail. */
  missing?: true;
}

/** Bringing back the attachments of a restored backup, which goes on after the restore has answered. */
export interface TodoRestoreProgress {
  state: 'downloading' | 'done' | 'partial';
  /** Files to bring back. */
  total: number;
  /** Files that could not be brought back so far. */
  missing: number;
}

export interface TodoEvent {
  id: string;
  taskId: string;
  kind: TodoEventKind;
  /** The fields an update changed, or the other task of a link. */
  detail: Record<string, unknown>;
  at: string;
}

/** Whether this Tower can show and change its todos. */
export type TodoAvailability =
  | { state: 'ready' }
  | { state: 'read-only'; reason: string }
  | { state: 'unavailable'; reason: string };

/**
 * A todo's issue master (see shared/master.ts): `starting` until its session is known, `active` while the todo is
 * open, `closing` once the todo is closed (completed for good or deleted) until its sessions are handed to retention
 * (which moves them to compressed storage once their work is over; nothing is hidden or stopped), then `closed`. Reopening the todo makes it `active` again.
 */
export type TodoAgentState = 'starting' | 'active' | 'closing' | 'closed';
export interface TodoAgent {
  taskId: string;
  sessionId?: string;
  provider: 'claude' | 'codex';
  state: TodoAgentState;
  createdAt: string;
  updatedAt: string;
}

/** A GitHub repository linked to a project or a section: todos made there after `createdAt` become its issues. */
export interface TodoGitHubBinding {
  id: string;
  scope: { kind: 'project' | 'section'; id: string };
  /** `owner/name`. */
  repo: string;
  /** The gh login the owner linked with; nothing is sent while gh is signed in as another account. */
  account: string;
  /** The last sync's problem with this link, if any. */
  error: string | null;
  createdAt: string;
}

/** The GitHub issue a todo is synced with. */
export interface TodoGitHubIssue { repo: string; number: number; url: string; error: string | null }

/**
 * What adding a todo whose title is an issue's address did: the todo it made (`changes` says what changed), or the one
 * already synced with that issue (`existing`). `moved` when it went to the project or section linked to the issue's
 * repository instead of the one asked for.
 */
export interface TodoGitHubImport { taskId: string; existing: boolean; moved?: boolean; changes?: TodoChanges }

/** Everything open, for the Todo page. Archived projects are included; deleted things are not. */
export interface TodoOverview {
  availability: TodoAvailability;
  revision: number;
  projects: TodoProject[];
  sections: TodoSection[];
  labels: TodoLabel[];
  /** Tasks not completed. */
  tasks: TodoTask[];
  /** Links whose both tasks exist and at least one is open. */
  links: TodoLink[];
  /** Comments per open task that has any. */
  commentCounts: Record<string, number>;
  /** Attachments that show, per open task that has any (its description's and its comments' together). */
  fileCounts: Record<string, number>;
  /**
   * Per open task, the id of its newest comment the owner did not write (an agent's, GitHub's, or one not recorded): what
   * the page's read marks compare with (client/src/todo/todo-read-state.ts). Absent from older servers.
   */
  outside?: Record<string, string>;
  /** Sub-tasks per open task that has any. */
  subtaskCounts: Record<string, TodoSubtaskCount>;
  /** Completed direct sub-tasks of open tasks, so a card can show where its sub-tasks stand. Absent from older servers. */
  doneSubtasks?: TodoTask[];
  /** Issue masters of todos that are not `closed`, by todo id. Absent from older servers. */
  agents?: Record<string, TodoAgent>;
  /** Present after a backup was restored here, while and after its attachments are brought back. */
  restore?: TodoRestoreProgress;
  /** The empty issue chat's first-message buttons, once the owner saved a list (shared/todo/chat-presets.ts). */
  chatPresets?: string[];
  /** GitHub links and the issues of open todos, by todo id. Absent from older servers. */
  github?: { bindings: TodoGitHubBinding[]; issues: Record<string, TodoGitHubIssue> };
}

/** What one request changed, including what it deleted (with `deletedAt`) or completed (with `completedAt`). */
export interface TodoChanges {
  revision: number;
  projects: TodoProject[];
  sections: TodoSection[];
  labels: TodoLabel[];
  tasks: TodoTask[];
  links: TodoLink[];
  /** Ids of links removed for good (`link.delete`). */
  removedLinks: string[];
  comments: TodoComment[];
  /** Files added, deleted (with `deletedAt`) or restored. */
  files: TodoFile[];
  /** The sub-task counts now of every task whose sub-tasks the request changed; `total` 0 when none is left. */
  subtaskCounts?: Record<string, TodoSubtaskCount>;
  /** Issue masters that changed, by todo id; null once one is `closed` or gone. */
  agents?: Record<string, TodoAgent | null>;
}

export interface TodoTaskDetail {
  task: TodoTask;
  /** Every task below it, completed ones included. */
  subtasks: TodoTask[];
  comments: TodoComment[];
  /** Attachments that show: the description's and the comments' (by `commentId`), oldest first. */
  files: TodoFile[];
  completions: TodoCompletion[];
  events: TodoEvent[];
  /** Tasks this one follows, and tasks that follow it, completed ones included. */
  previous: { link: TodoLink; task: TodoTask }[];
  next: { link: TodoLink; task: TodoTask }[];
  /** The GitHub issue it is or was synced with (server/todo/github/): what is in it may come from outside. */
  github?: { repo: string; number: number; url: string };
}

export interface TodoCompletedPage {
  items: { completion: TodoCompletion; task: TodoTask }[];
  /** Pass as `before` for the next page (an opaque cursor); absent on the last. */
  before?: string;
}
