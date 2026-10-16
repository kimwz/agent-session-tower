/**
 * The schema of `<state>/todos.sqlite`, which the web process owns apart from the worker's `state.sqlite`.
 *
 * `PRAGMA user_version` counts the steps applied; a build applies the steps it knows and never edits a released one.
 * `todo_meta.min_writer` is the lowest step whose code may still write: a step that only adds tables or columns with
 * defaults leaves it alone, so an older build keeps working on a newer file (every statement names its columns). A
 * step that changes what existing data means raises it, and older builds then open the file read-only.
 */

export interface TodoSchemaStep { sql: string; minWriter?: number }

export const TODO_SCHEMA: readonly TodoSchemaStep[] = [
  { sql: `
    CREATE TABLE todo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE todo_projects (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES todo_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'charcoal', favorite INTEGER NOT NULL DEFAULT 0, inbox INTEGER NOT NULL DEFAULT 0,
      layout TEXT NOT NULL DEFAULT 'board', archived_at TEXT, sort_key TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX todo_projects_inbox ON todo_projects(inbox) WHERE inbox = 1;
    CREATE TABLE todo_sections (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES todo_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, collapsed INTEGER NOT NULL DEFAULT 0, archived_at TEXT, sort_key TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    ) STRICT;
    CREATE TABLE todo_labels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL DEFAULT 'charcoal', favorite INTEGER NOT NULL DEFAULT 0,
      sort_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX todo_labels_name ON todo_labels(name) WHERE deleted_at IS NULL;
    CREATE TABLE todo_tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES todo_projects(id) ON DELETE CASCADE,
      section_id TEXT REFERENCES todo_sections(id) ON DELETE SET NULL, parent_id TEXT REFERENCES todo_tasks(id) ON DELETE CASCADE,
      content TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 4,
      due_date TEXT, due_time TEXT, recurrence TEXT, duration_min INTEGER, deadline_date TEXT,
      sort_key TEXT NOT NULL, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    ) STRICT;
    CREATE INDEX todo_tasks_open ON todo_tasks(project_id, section_id, parent_id) WHERE completed_at IS NULL AND deleted_at IS NULL;
    CREATE INDEX todo_tasks_parent ON todo_tasks(parent_id);
    CREATE TABLE todo_task_labels (
      task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE, label_id TEXT NOT NULL REFERENCES todo_labels(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, label_id)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE todo_links (
      id TEXT PRIMARY KEY, from_task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
      to_task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (from_task_id, to_task_id, kind)
    ) STRICT;
    CREATE INDEX todo_links_to ON todo_links(to_task_id);
    CREATE TABLE todo_comments (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE, body TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    ) STRICT;
    CREATE INDEX todo_comments_task ON todo_comments(task_id);
    CREATE TABLE todo_completions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE, occurrence_date TEXT,
      completed_at TEXT NOT NULL, cause_id TEXT, undone_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX todo_completions_occurrence ON todo_completions(task_id, occurrence_date) WHERE undone_at IS NULL AND occurrence_date IS NOT NULL;
    CREATE INDEX todo_completions_recent ON todo_completions(completed_at) WHERE undone_at IS NULL;
    CREATE INDEX todo_completions_cause ON todo_completions(cause_id) WHERE cause_id IS NOT NULL;
    CREATE TABLE todo_events (
      id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX todo_events_task ON todo_events(task_id, id);
    CREATE TABLE todo_requests (id TEXT PRIMARY KEY, result TEXT NOT NULL, at TEXT NOT NULL) STRICT;
  ` },
];

export const TODO_SCHEMA_STEP = TODO_SCHEMA.length;

/** The lowest step whose code may write a file at `step` applied steps. */
export const minWriterAt = (step: number) => TODO_SCHEMA.slice(0, step).reduce((min, item) => Math.max(min, item.minWriter ?? 1), 1);
