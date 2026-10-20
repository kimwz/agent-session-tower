/**
 * The schema of `<state>/todos.sqlite`, which the web process owns apart from the worker's `state.sqlite`.
 *
 * `PRAGMA user_version` counts the steps applied; a build applies the steps it knows and never edits a released one.
 * `todo_meta.min_writer` is the lowest step whose code may still write: a step that only adds tables or columns with
 * defaults leaves it alone, so an older build keeps working on a newer file (every statement names its columns). A
 * step that changes what existing data means raises it, and older builds then open the file read-only.
 *
 * Every column a foreign key points from has an index, so removing deleted rows for good never scans a table.
 * `deleted_with` names the operation that deleted a row, so restoring brings back exactly what went with it.
 */

export interface TodoSchemaStep { sql: string; minWriter?: number }

export const TODO_SCHEMA: readonly TodoSchemaStep[] = [
  { sql: `
    CREATE TABLE todo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE todo_projects (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES todo_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'charcoal', favorite INTEGER NOT NULL DEFAULT 0, inbox INTEGER NOT NULL DEFAULT 0,
      layout TEXT NOT NULL DEFAULT 'board', archived_at TEXT, sort_key TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, deleted_with TEXT
    ) STRICT;
    CREATE UNIQUE INDEX todo_projects_inbox ON todo_projects(inbox) WHERE inbox = 1;
    CREATE INDEX todo_projects_parent ON todo_projects(parent_id);
    CREATE TABLE todo_sections (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES todo_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, collapsed INTEGER NOT NULL DEFAULT 0, archived_at TEXT, sort_key TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, deleted_with TEXT
    ) STRICT;
    CREATE INDEX todo_sections_project ON todo_sections(project_id);
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
      sort_key TEXT NOT NULL, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, deleted_with TEXT
    ) STRICT;
    CREATE INDEX todo_tasks_project ON todo_tasks(project_id, section_id, parent_id);
    CREATE INDEX todo_tasks_section ON todo_tasks(section_id);
    CREATE INDEX todo_tasks_parent ON todo_tasks(parent_id);
    CREATE TABLE todo_task_labels (
      task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE, label_id TEXT NOT NULL REFERENCES todo_labels(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, label_id)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX todo_task_labels_label ON todo_task_labels(label_id);
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
    CREATE INDEX todo_completions_task ON todo_completions(task_id, completed_at);
    CREATE INDEX todo_completions_recent ON todo_completions(completed_at) WHERE undone_at IS NULL;
    CREATE INDEX todo_completions_cause ON todo_completions(cause_id) WHERE cause_id IS NOT NULL;
    CREATE TABLE todo_events (
      id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX todo_events_task ON todo_events(task_id, id);
    CREATE TABLE todo_requests (id TEXT PRIMARY KEY, result TEXT NOT NULL, at TEXT NOT NULL) STRICT;
  ` },
  // Attachments. Their contents live in `<state>/todo-files/<sha256>`; deleting a task or comment leaves the row alone
  // (what shows is worked out from the three), so builds that know only step 1 keep the rule when they delete things.
  { sql: `
    CREATE TABLE todo_files (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
      comment_id TEXT REFERENCES todo_comments(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
    ) STRICT;
    CREATE INDEX todo_files_task ON todo_files(task_id);
    CREATE INDEX todo_files_comment ON todo_files(comment_id);
    CREATE INDEX todo_files_sha256 ON todo_files(sha256);
  ` },
  // A task's place among the tasks of its date (shared/todo/day-order.ts). It names the date it belongs to, so an
  // older build that changes a date without knowing it leaves nothing wrong behind.
  { sql: 'ALTER TABLE todo_tasks ADD COLUMN day_order TEXT;' },
  // Issue masters (server/todo/agents.ts): one per todo the owner started a chat on, and the sessions each started
  // (its family). Session ids belong to this computer, so neither table is in backups, and neither points at a task:
  // a task removed for good takes its closed issue master with it (purge), whatever an older build did meanwhile.
  { sql: `
    CREATE TABLE todo_agents (
      task_id TEXT PRIMARY KEY, session_id TEXT, provider TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'closing', 'closed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE todo_agent_sessions (session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE INDEX todo_agent_sessions_task ON todo_agent_sessions(task_id);
    -- The masters a pass looks at: closed ones (one per todo ever worked on) are never scanned.
    CREATE INDEX todo_agents_open ON todo_agents(state) WHERE state != 'closed';
  ` },
  // Auto Prompt jobs an issue master sent with the master's calls, until the session each makes joins its todo's family
  // (server/todo/agents.ts `adoptJobs`): kept across restarts, gone once the job is no longer listed.
  { sql: 'CREATE TABLE todo_agent_jobs (job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;' },
  // Who wrote a comment (TodoCommentAuthor). An older build's comments, and every earlier one, leave it NULL: not recorded.
  { sql: "ALTER TABLE todo_comments ADD COLUMN author TEXT CHECK (author IN ('owner', 'agent'));" },
];

export const TODO_SCHEMA_STEP = TODO_SCHEMA.length;

/**
 * The tables a backup holds, parents before children: everything but the file's own bookkeeping (`todo_meta`), request
 * answers (`todo_requests`) and issue masters (`todo_agents`, `todo_agent_sessions`), which stay with the file they
 * belong to.
 */
export const TODO_DATA_TABLES = ['todo_projects', 'todo_sections', 'todo_labels', 'todo_tasks', 'todo_task_labels', 'todo_links', 'todo_comments',
  'todo_completions', 'todo_events', 'todo_files'] as const;

/** The lowest step whose code may write a file at `step` applied steps. */
export const minWriterAt = (step: number) => TODO_SCHEMA.slice(0, step).reduce((min, item) => Math.max(min, item.minWriter ?? 1), 1);
