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
  completedAt: string | null;
}

/** One task follows another (`next`): an order only, never a condition on either task. */
export interface TodoLink {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  kind: 'next';
  createdAt: string;
}

export interface TodoComment extends Stamped {
  id: string;
  taskId: string;
  body: string;
}

export interface TodoCompletion {
  id: string;
  taskId: string;
  /** The date that was done: a repeating task's occurrence, or the task's date. */
  occurrenceDate: string | null;
  completedAt: string;
}

export type TodoEventKind = 'created' | 'updated' | 'moved' | 'completed' | 'uncompleted' | 'deleted' | 'restored' | 'linked' | 'unlinked' | 'commented';

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
}

export interface TodoTaskDetail {
  task: TodoTask;
  /** Every task below it, completed ones included. */
  subtasks: TodoTask[];
  comments: TodoComment[];
  completions: TodoCompletion[];
  events: TodoEvent[];
  /** Tasks this one follows, and tasks that follow it, completed ones included. */
  previous: { link: TodoLink; task: TodoTask }[];
  next: { link: TodoLink; task: TodoTask }[];
}

export interface TodoCompletedPage {
  items: { completion: TodoCompletion; task: TodoTask }[];
  /** Pass as `before` for the next page; absent on the last. */
  before?: string;
}
