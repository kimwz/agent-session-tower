import { randomUUID } from 'node:crypto';
import { TowerError } from '../../../shared/errors.js';
import { formatDate } from '../../../shared/todo/dates.js';
import { githubIssueAddress, type GitHubIssueAddress } from '../../../shared/todo/github-issue.js';
import type { TodoOpOf, TodoRequest } from '../../../shared/todo/ops.js';
import type { TodoChanges, TodoCommentAuthor, TodoGitHubBinding, TodoGitHubImport, TodoPriority } from '../../../shared/todo/types.js';
import { GitHubError } from '../../triggers/github.js';
import type { TodoContext } from '../context.js';
import { todoFilePath } from '../files.js';
import { createLabel } from '../ops/projects.js';
import { completeTask, shelved, uncompleteTask, updateTask } from '../ops/tasks.js';
import { VISIBLE_FILE } from '../rows.js';
import { applyOps, INBOX_ID, type TodoStore } from '../store.js';
import { bindingOfPlace, bindingOfTask, liveBindings, linkScope, REPO, unlink, type BindingRow } from './bindings.js';
import { GitHubCallError, withUploadCopy, type TodoGitHub } from './client.js';
import { commentBody, contentHash, issueBody, issueHash, issueTitle, lastAssetUrl, priorityLabel, sortLabels, UPLOADABLE, uploadable, writtenPart, type IssueContent, type ShownFile } from './issue-text.js';

/**
 * Keeps linked todos and their GitHub issues alike, the normal way only: Tower's changes go up first (Tower wins), then
 * what changed on GitHub since comes down. A call that fails leaves its error to show and is tried again next pass;
 * restarts, lost answers and duplicates are not handled (the owner's choice). `synced_hash` is what Tower last knew
 * GitHub to show, so a value that came down is not sent back up, and one sent up is not taken down again.
 */

const PASS_MS = 60_000;
const NUDGE_MS = 3_000;
/** Polls look this much before the last one began, so an edit at its edge is not missed (seen twice is harmless). */
const POLL_OVERLAP_MS = 10_000;
const MAX_CONTENT = 500, MAX_DESCRIPTION = 16_383, MAX_COMMENT = 15_000;

export interface TodoGitHubSyncOptions {
  store: TodoStore;
  stateDir: string;
  github: TodoGitHub;
  /** What a change that came down from GitHub changed, for the pages and issue masters (as the page's own changes). */
  changed(changes: TodoChanges): void;
  now?: () => Date;
}

interface IssueMap { task_id: string; repo: string; number: number; issue_id: number; url: string; synced_hash: string | null; gh_updated_at: string; extra_labels: string; parent_number: number | null; error: string | null }
interface CommentMap { comment_id: string; task_id: string; github_id: number; url: string; origin: 'tower' | 'github'; login: string | null; synced_hash: string | null; gh_updated_at: string; error: string | null }
interface FileRow { id: string; comment_id: string | null; name: string; mime: string; size: number; sha256: string; gh_url: string | null }
interface GitHubIssue { id: number; number: number; html_url: string; state: 'open' | 'closed'; state_reason: string | null; title: string; body: string | null; labels: ({ name: string } | string)[]; updated_at: string; pull_request?: unknown }
interface GitHubComment { id: number; html_url: string; issue_url: string; body: string | null; user: { login: string } | null; created_at: string; updated_at: string }

/** A task as its issue shows it. */
interface TaskView {
  id: string; createdAt: string; deleted: boolean; completed: boolean; recurring: boolean; dueDate: string | null;
  content: string; description: string; priority: TodoPriority; labelIds: string[]; labels: string[]; byAgent: boolean;
  files: FileRow[]; parentNumber: number | null;
}

const issueMap = (ctx: TodoContext, taskId: string) => ctx.get<IssueMap>('SELECT * FROM todo_github_issues WHERE task_id = ?', taskId);

function taskView(ctx: TodoContext, taskId: string, repo: string): TaskView | undefined {
  const row = ctx.get<Record<string, string | number | null>>('SELECT * FROM todo_tasks WHERE id = ?', taskId);
  if (!row) return undefined;
  const labels = ctx.all<{ id: string; name: string }>('SELECT l.id, l.name FROM todo_task_labels tl JOIN todo_labels l ON l.id = tl.label_id AND l.deleted_at IS NULL WHERE tl.task_id = ? ORDER BY l.sort_key', taskId);
  const created = ctx.get<{ detail: string }>("SELECT detail FROM todo_events WHERE task_id = ? AND kind = 'created' ORDER BY id LIMIT 1", taskId);
  const files = ctx.all<FileRow>(`SELECT f.id, f.comment_id, f.name, f.mime, f.size, f.sha256, (SELECT g.url FROM todo_github_files g WHERE g.file_id = f.id AND g.repo = ?) AS gh_url
    FROM todo_files f LEFT JOIN todo_comments c ON c.id = f.comment_id WHERE f.task_id = ? AND ${VISIBLE_FILE} ORDER BY f.created_at, f.rowid`, repo, taskId);
  const parent = row.parent_id ? ctx.get<{ number: number }>('SELECT number FROM todo_github_issues WHERE task_id = ? AND repo = ?', row.parent_id, repo) : undefined;
  return {
    id: taskId, createdAt: String(row.created_at), deleted: !!row.deleted_at, completed: !!row.completed_at, recurring: !!row.recurrence, dueDate: row.due_date as string | null,
    content: String(row.content), description: String(row.description), priority: Number(row.priority) as TodoPriority,
    labelIds: labels.map(label => label.id).sort(), labels: labels.map(label => label.name),
    byAgent: created ? (JSON.parse(created.detail) as { by?: TodoCommentAuthor }).by === 'agent' : false,
    files, parentNumber: parent ? Number(parent.number) : null,
  };
}

const shown = (file: FileRow): ShownFile => ({ name: file.name, mimeType: file.mime, ...(file.gh_url ? { url: file.gh_url } : {}) });

function issueContent(view: TaskView, extraLabels: readonly string[]): IssueContent {
  const priority = priorityLabel(view.priority);
  return {
    title: issueTitle(view.content),
    body: issueBody(view.description, { files: view.files.filter(file => !file.comment_id).map(shown), byAgent: view.byAgent, parentNumber: view.parentNumber }),
    state: view.deleted || view.completed ? 'closed' : 'open',
    reason: view.deleted ? 'not_planned' : view.completed ? 'completed' : null,
    labels: [...view.labels, ...(priority ? [priority] : []), ...extraLabels],
  };
}

const commentText = (body: string, author: string | null, files: FileRow[]) => commentBody(body, { byAgent: author === 'agent', files: files.map(shown) });
const labelNames = (issue: GitHubIssue) => issue.labels.map(label => typeof label === 'string' ? label : label.name);
const iso = (value: string) => new Date(value).toISOString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * An issue as GitHub has it brought into its todo: title, body, labels, priority, and a real change of state. After it,
 * `synced_hash` says GitHub shows the todo, unless Tower's state could not follow.
 */
function bringIssue(ctx: TodoContext, map: IssueMap, issue: GitHubIssue, view: TaskView, today: string): void {
  const labels = sortLabels(labelNames(issue));
  if (!view.deleted) {
    const patch: { content?: string; description?: string; priority?: TodoPriority; labelIds?: string[] } = {};
    const title = issue.title.trim().slice(0, MAX_CONTENT);
    if (title && title !== issueTitle(view.content)) patch.content = title;
    const description = writtenPart(issue.body).slice(0, MAX_DESCRIPTION);
    if (description !== view.description.trim()) patch.description = description;
    if (labels.priority !== view.priority) patch.priority = labels.priority;
    const labelIds = labels.tower.map(name => {
      const found = ctx.get<{ id: string }>('SELECT id FROM todo_labels WHERE name = ? AND deleted_at IS NULL', name);
      if (found) return found.id;
      const id = randomUUID();
      createLabel(ctx, { op: 'label.create', id, name });
      return id;
    }).sort();
    if (JSON.stringify([...new Set(labelIds)]) !== JSON.stringify(view.labelIds)) patch.labelIds = [...new Set(labelIds)];
    if (Object.keys(patch).length) updateTask(ctx, { op: 'task.update', id: view.id, patch });
    // Only a real change of state completes or reopens it; a repeating todo is completed only in Tower.
    if (issue.state === 'closed' && !view.completed && !view.recurring) completeTask(ctx, { op: 'task.complete', id: view.id, completionId: randomUUID(), occurrence: view.dueDate, today });
    if (issue.state === 'open' && view.completed) {
      const latest = ctx.get<{ id: string }>('SELECT id FROM todo_completions WHERE task_id = ? AND undone_at IS NULL ORDER BY completed_at DESC, rowid DESC LIMIT 1', view.id);
      if (latest) uncompleteTask(ctx, { op: 'task.uncomplete', id: view.id, completionId: latest.id });
    }
  }
  const after = issueContent(taskView(ctx, map.task_id, map.repo)!, labels.extra);
  // Where Tower's state could not follow (a repeating or deleted todo), the next push sends Tower's back.
  const same = (issue.state === 'closed') === (after.state === 'closed');
  ctx.run('UPDATE todo_github_issues SET synced_hash = ?, gh_updated_at = ?, extra_labels = ? WHERE task_id = ?',
    same ? issueHash(after) : null, issue.updated_at, JSON.stringify(labels.extra), map.task_id);
}

/** A comment written on GitHub, new to Tower, as GitHub's comment on the todo. */
function addGitHubComment(ctx: TodoContext, taskId: string, comment: GitHubComment): void {
  const id = randomUUID();
  // Written when it was written on GitHub, and not since: the page marks a comment edited by its two times.
  const at = iso(comment.created_at);
  ctx.run('INSERT INTO todo_comments (id, task_id, body, author, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)', id, taskId, (comment.body ?? '').slice(0, MAX_COMMENT), at, at);
  ctx.run("INSERT INTO todo_github_comments (comment_id, task_id, github_id, url, origin, login, gh_updated_at) VALUES (?, ?, ?, ?, 'github', ?, ?)",
    id, taskId, comment.id, comment.html_url, comment.user?.login ?? 'unknown', comment.updated_at);
  ctx.touched.comments.add(id);
  ctx.event(taskId, 'commented', { comment: id, via: 'github' });
}

/** The todo already synced with this issue, deleted or completed ones too, as an import answers it. */
function syncedTask(ctx: TodoContext, address: GitHubIssueAddress): TodoGitHubImport | undefined {
  const row = ctx.get<{ id: string; content: string; completed_at: string | null; deleted_at: string | null }>(`SELECT t.id, t.content, t.completed_at, t.deleted_at
    FROM todo_github_issues g JOIN todo_tasks t ON t.id = g.task_id WHERE lower(g.repo) = lower(?) AND g.number = ? LIMIT 1`, address.repo, address.number);
  return row ? { taskId: row.id, existing: { content: row.content, state: row.deleted_at ? 'deleted' : row.completed_at ? 'completed' : 'open' } } : undefined;
}

/**
 * Where an issue brought in goes: a todo syncs only through the link of where it is, so it goes where it was asked to
 * when that syncs with the issue's repository, else to the place first linked to that repository (`place`). A sub-task
 * cannot move away from its parent.
 */
function importPlace(ctx: TodoContext, create: TodoOpOf<'task.create'>, repo: string): { binding: BindingRow; place?: { projectId: string; sectionId: string | null } } {
  const bindings = liveBindings(ctx);
  const ofRepo = (binding: BindingRow | undefined): binding is BindingRow => !!binding && binding.repo.toLowerCase() === repo.toLowerCase();
  if (create.parentId) {
    const binding = bindingOfTask(ctx, create.parentId, bindings);
    if (ofRepo(binding)) return { binding };
    throw new TowerError('invalid', `상위 작업이 ${repo}와 동기화되지 않아 하위 작업으로 가져올 수 없습니다.`);
  }
  const asked = bindingOfPlace(create.projectId ?? INBOX_ID, create.sectionId ?? null, bindings);
  if (ofRepo(asked)) return { binding: asked };
  // Only a place a task can be put in now: neither deleted nor archived (nor under an archived project).
  for (const binding of bindings.filter(ofRepo)) {
    const place = binding.scope.kind === 'project'
      ? ctx.get<{ projectId: string; sectionId: null }>('SELECT id AS projectId, NULL AS sectionId FROM todo_projects WHERE id = ? AND deleted_at IS NULL', binding.scope.id)
      : ctx.get<{ projectId: string; sectionId: string }>(`SELECT s.project_id AS projectId, s.id AS sectionId FROM todo_sections s JOIN todo_projects p ON p.id = s.project_id AND p.deleted_at IS NULL
        WHERE s.id = ? AND s.deleted_at IS NULL`, binding.scope.id);
    if (place && !shelved(ctx, place.projectId, place.sectionId)) return { binding, place };
  }
  throw new TowerError('not-found', `${repo}에 연결된 프로젝트나 섹션이 없습니다. 프로젝트 메뉴의 'GitHub 연결…'로 먼저 연결하세요.`);
}

export class TodoGitHubSync {
  private timer?: ReturnType<typeof setInterval>;
  private soon?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private following?: Promise<void>;
  /** Labels known to exist in each repository (lower case), so each is created at most once. */
  private readonly labels = new Map<string, Set<string>>();
  /** Files whose upload failed in this process: shown by name until Tower restarts, rather than tried every pass. */
  private readonly failedUploads = new Set<string>();
  /** Set when an error shown on a page appeared or went away, so the pass moves the revision. */
  private statusChanged = false;

  constructor(private readonly options: TodoGitHubSyncOptions) {}

  private get store() { return this.options.store; }
  private get github() { return this.options.github; }
  private now() { return this.options.now?.() ?? new Date(); }

  start(): void {
    this.timer = setInterval(() => { void this.pass(); }, PASS_MS);
    this.timer.unref();
    void this.pass();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.soon);
    this.timer = this.soon = undefined;
  }

  /** A todo changed: a pass runs shortly, once for a burst of changes. */
  nudge(): void {
    if (this.soon || !this.timer) return;
    this.soon = setTimeout(() => { this.soon = undefined; void this.pass(); }, NUDGE_MS);
    this.soon.unref();
  }

  /** One pass; one asked for while another runs follows it (once, for every ask meanwhile), and answers when it ends. */
  pass(): Promise<void> {
    if (this.running) return this.following ??= this.running.then(() => { this.following = undefined; return this.pass(); });
    this.running = this.run().catch(error => console.error(`GitHub todo sync failed: ${message(error)}`)).finally(() => { this.running = undefined; });
    return this.running;
  }

  // ---- The owner's links ---------------------------------------------------------------------------------------

  /** Who gh is signed in as, and what that account may do in `repo`. */
  async check(repo: string): Promise<{ login: string; repo: string; private: boolean; canPush: boolean }> {
    if (!REPO.test(repo)) throw new TowerError('invalid', 'repo는 owner/name 형식이어야 합니다.');
    const login = await this.github.login();
    const found = await this.github.call<{ full_name: string; private: boolean; permissions?: { push?: boolean } }>('GET', `/repos/${repo}`)
      .catch(error => { throw error instanceof GitHubCallError && error.status === 404 ? new TowerError('not-found', `${login} 계정으로 ${repo} 리포를 볼 수 없습니다.`) : error; });
    return { login, repo: found.full_name, private: !!found.private, canPush: !!found.permissions?.push };
  }

  async link(input: { kind: 'project' | 'section'; id: string; repo: string }): Promise<TodoGitHubBinding> {
    const checked = await this.check(input.repo);
    if (!checked.canPush) throw new TowerError('forbidden', `${checked.login} 계정은 ${checked.repo}에 쓸 수 없습니다.`);
    const { result } = this.store.github(ctx => linkScope(ctx, { kind: input.kind, id: input.id, repo: checked.repo, account: checked.login }));
    this.store.touchRevision();
    void this.pass();
    return result;
  }

  unlink(id: string): void {
    this.store.github(ctx => unlink(ctx, id));
    this.store.touchRevision();
  }

  // ---- An issue brought in -------------------------------------------------------------------------------------

  /**
   * Adds a todo as `request` would, whose title is an issue's address (shared/todo/github-issue.ts), as that issue: its
   * title, body, labels and comments, synced from then on as any linked todo. An issue already synced answers its todo.
   * Anything that stops it (no link to the repository, another gh account, no write access, no such open issue) is
   * refused with the reason, and nothing is made. Who sent it is not recorded: the todo is the issue's, and an agent's
   * would say so in the issue's body.
   */
  async importIssue(request: TodoRequest, taskId: string): Promise<TodoGitHubImport> {
    const create = request.ops.find((op): op is TodoOpOf<'task.create'> => op.op === 'task.create' && op.id === taskId);
    const address = create && githubIssueAddress(create.content);
    if (!create || !address) throw new TowerError('invalid', '가져올 GitHub 이슈 주소가 없습니다.');
    const ref = `${address.repo}#${address.number}`;
    const existing = this.store.githubRead(ctx => syncedTask(ctx, address));
    if (existing) return existing;
    const { binding, place } = this.store.githubRead(ctx => importPlace(ctx, create, address.repo));
    const checked = await this.check(binding.repo);
    if (checked.login.toLowerCase() !== binding.account.toLowerCase()) throw new TowerError('forbidden', `gh가 ${checked.login} 계정으로 로그인되어 있어 가져오지 않았습니다(연결 계정: ${binding.account}).`);
    if (!checked.canPush) throw new TowerError('forbidden', `${checked.login} 계정은 ${binding.repo}에 쓸 수 없어 ${ref}을(를) 가져오지 않았습니다.`);
    const issue = await this.github.call<GitHubIssue>('GET', `/repos/${binding.repo}/issues/${address.number}`).catch(error => {
      throw error instanceof GitHubCallError && (error.status === 404 || error.status === 410) ? new TowerError('not-found', `${ref} 이슈를 찾을 수 없습니다.`) : error;
    });
    if (issue.pull_request) throw new TowerError('invalid', `${ref}은(는) PR입니다. 이슈만 가져올 수 있습니다.`);
    // GitHub answers an issue moved to another repository from there: only this repository's own issue is brought in.
    if (issue.html_url.toLowerCase() !== `https://github.com/${binding.repo}/issues/${address.number}`.toLowerCase()) throw new TowerError('invalid', `${ref} 이슈는 다른 리포로 옮겨졌습니다(${issue.html_url}). 옮겨진 이슈의 주소로 가져오세요.`);
    if (issue.state === 'closed') throw new TowerError('invalid', `${ref}은(는) 닫힌 이슈입니다. GitHub에서 다시 연 뒤 가져오세요.`);
    const comments = await this.pages<GitHubComment>(`/repos/${binding.repo}/issues/${address.number}/comments`);
    const today = this.today();
    const { result, changes } = this.store.github(ctx => {
      const again = syncedTask(ctx, address);
      if (again) return again;
      // The issue's own values first, which GitHub shows: what was set by hand when adding it goes on top, below.
      const { priority: typedPriority, labelIds: typedLabels = [], description: typedDescription = '', ...rest } = create;
      const made: TodoOpOf<'task.create'> = { ...rest, ...(place ? { projectId: place.projectId, sectionId: place.sectionId, afterId: undefined } : {}),
        content: issue.title.trim().slice(0, MAX_CONTENT) || ref, description: writtenPart(issue.body).slice(0, MAX_DESCRIPTION) };
      applyOps(ctx, request.ops.map(op => op === create ? made : op));
      if (bindingOfTask(ctx, taskId)?.id !== binding.id) throw new TowerError('conflict', 'GitHub 연결이 바뀌었습니다. 다시 시도하세요.');
      ctx.run("INSERT INTO todo_github_issues (task_id, repo, number, issue_id, url, synced_hash, gh_updated_at) VALUES (?, ?, ?, ?, ?, NULL, '')", taskId, binding.repo, issue.number, issue.id, issue.html_url);
      bringIssue(ctx, issueMap(ctx, taskId)!, issue, taskView(ctx, taskId, binding.repo)!, today);
      for (const comment of comments) if (!ctx.get('SELECT 1 FROM todo_github_comments WHERE github_id = ?', comment.id)) addGitHubComment(ctx, taskId, comment);
      // Set by hand, so Tower's change: it goes up with the next pass.
      const view = taskView(ctx, taskId, binding.repo)!;
      const patch: { priority?: TodoPriority; labelIds?: string[]; description?: string } = {};
      if (typedPriority && typedPriority < 4 && typedPriority !== view.priority) patch.priority = typedPriority;
      const labelIds = [...new Set([...view.labelIds, ...typedLabels])];
      if (labelIds.length !== view.labelIds.length) patch.labelIds = labelIds;
      if (typedDescription.trim()) patch.description = [view.description.trim(), typedDescription.trim()].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
      if (Object.keys(patch).length) updateTask(ctx, { op: 'task.update', id: taskId, patch });
      return { taskId, ...(place ? { moved: true } : {}) };
    });
    return { ...result, ...(changes ? { changes } : {}) };
  }

  // ---- A pass --------------------------------------------------------------------------------------------------

  private async run(): Promise<void> {
    if (this.store.availability().state !== 'ready') return;
    const bindings = this.store.githubRead(liveBindings);
    if (!bindings.length) return;
    this.statusChanged = false;
    const errors = new Map<string, string | null>(bindings.map(binding => [binding.id, null]));
    try {
      const login = await this.github.login();
      const usable = bindings.filter(binding => {
        if (binding.account.toLowerCase() === login.toLowerCase()) return true;
        errors.set(binding.id, `gh가 ${login} 계정으로 로그인되어 있어 보내지 않았습니다(연결 계정: ${binding.account}).`);
        return false;
      });
      if (usable.length) {
        await this.push(bindings, usable, errors);
        for (const binding of usable) await this.pull(binding, errors);
      }
    } catch (error) {
      // Signed out, or a used-up rate limit: this pass ends here and the next one tries again.
      for (const binding of bindings) if (!errors.get(binding.id)) errors.set(binding.id, message(error));
    }
    this.store.github(ctx => {
      for (const binding of bindings) {
        const error = errors.get(binding.id) ?? null;
        if (error !== binding.error) { ctx.run('UPDATE todo_github_bindings SET error = ? WHERE id = ?', error, binding.id); this.statusChanged = true; }
      }
    });
    if (this.statusChanged) this.store.touchRevision();
  }

  /** Records an item's error (or clears it) where its card shows it. */
  private issueError(taskId: string, error: string | null): void {
    this.store.github(ctx => {
      const before = issueMap(ctx, taskId);
      if (!before || before.error === error) return;
      ctx.run('UPDATE todo_github_issues SET error = ? WHERE task_id = ?', error, taskId);
      this.statusChanged = true;
    });
  }

  /** Only a refusal of one item is kept on it; anything else (signed out, rate limit) ends the pass. */
  private itemFailure(error: unknown): string {
    if (error instanceof GitHubError) throw error;
    return message(error);
  }

  // ---- Tower → GitHub ------------------------------------------------------------------------------------------

  private async push(bindings: BindingRow[], usable: BindingRow[], errors: Map<string, string | null>): Promise<void> {
    const since = usable.map(binding => binding.createdAt).sort()[0];
    // Parents before their sub-tasks, so a sub-task's issue can hang under its parent's.
    const ids = this.store.githubRead(ctx => ctx.all<{ id: string }>(`WITH RECURSIVE tree(id, depth) AS (
        SELECT id, 0 FROM todo_tasks WHERE parent_id IS NULL UNION ALL SELECT t.id, tree.depth + 1 FROM todo_tasks t JOIN tree ON t.parent_id = tree.id WHERE tree.depth < 10)
      SELECT tree.id FROM tree JOIN todo_tasks t ON t.id = tree.id
      WHERE t.created_at >= ? OR EXISTS (SELECT 1 FROM todo_github_issues g WHERE g.task_id = t.id) ORDER BY tree.depth, t.created_at`, since).map(row => row.id));
    for (const id of ids) {
      const binding = this.store.githubRead(ctx => bindingOfTask(ctx, id, bindings));
      if (!binding || !usable.includes(binding)) continue;
      try { await this.pushTask(id, binding); }
      catch (error) {
        const failure = this.itemFailure(error);
        if (this.store.githubRead(ctx => issueMap(ctx, id))) this.issueError(id, failure);
        else errors.set(binding.id, `할 일 이슈를 만들지 못했습니다: ${failure}`);
      }
    }
  }

  private async pushTask(id: string, binding: BindingRow): Promise<void> {
    const { repo } = binding;
    let map = this.store.githubRead(ctx => issueMap(ctx, id));
    const view = this.store.githubRead(ctx => taskView(ctx, id, repo));
    if (!view) return;
    if (map && map.repo !== repo) {
      // Moved to a section or project of another repository: the old issue is closed, a new one made.
      await this.closeAs(map.repo, map.number, 'not_planned').catch(error => { this.itemFailure(error); });
      this.store.github(ctx => {
        ctx.run('DELETE FROM todo_github_issues WHERE task_id = ?', id);
        ctx.run("DELETE FROM todo_github_comments WHERE task_id = ? AND origin = 'tower'", id);
      });
      map = await this.createIssue(view, repo);
    } else if (!map) {
      if (view.deleted || view.createdAt < binding.createdAt) return;
      map = await this.createIssue(view, repo);
    }
    if (view.deleted) { await this.updateIssue(map, false); return; }
    const uploaded = await this.uploadFiles(map, binding.account);
    await this.updateIssue(map, uploaded);
    await this.linkParent(map);
    await this.pushComments(map);
    this.issueError(id, null);
  }

  private async createIssue(view: TaskView, repo: string): Promise<IssueMap> {
    const content = issueContent(view, []);
    await this.ensureLabels(repo, content.labels);
    let issue = await this.github.call<GitHubIssue>('POST', `/repos/${repo}/issues`, { title: content.title, body: content.body, labels: content.labels });
    // An issue is made open; one for a closed todo is closed right after.
    if (content.state === 'closed') issue = await this.github.call<GitHubIssue>('PATCH', `/repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: content.reason });
    this.store.github(ctx => ctx.run('INSERT INTO todo_github_issues (task_id, repo, number, issue_id, url, synced_hash, gh_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      view.id, repo, issue.number, issue.id, issue.html_url, issueHash(content), issue.updated_at));
    this.statusChanged = true;
    return this.store.githubRead(ctx => issueMap(ctx, view.id))!;
  }

  /** Sends the issue as Tower has it, when it differs from what GitHub was last known to show (or `force`). */
  private async updateIssue(map: IssueMap, force: boolean): Promise<void> {
    const view = this.store.githubRead(ctx => taskView(ctx, map.task_id, map.repo));
    if (!view) return;
    const content = issueContent(view, JSON.parse(map.extra_labels) as string[]);
    const hash = issueHash(content);
    if (!force && hash === map.synced_hash) return;
    await this.ensureLabels(map.repo, content.labels);
    const path = `/repos/${map.repo}/issues/${map.number}`;
    let issue = await this.github.call<GitHubIssue>('PATCH', path, { title: content.title, body: content.body, state: content.state, labels: content.labels,
      ...(content.reason ? { state_reason: content.reason } : {}) });
    if (content.state === 'closed' && issue.state_reason !== content.reason) issue = await this.closeAs(map.repo, map.number, content.reason!, issue);
    this.store.github(ctx => ctx.run('UPDATE todo_github_issues SET synced_hash = ?, gh_updated_at = ? WHERE task_id = ?', hash, issue.updated_at, map.task_id));
  }

  /**
   * Closes an issue with this reason. GitHub keeps the reason of an issue that stays closed, so one closed for another
   * reason is opened and closed again.
   */
  private async closeAs(repo: string, number: number, reason: 'completed' | 'not_planned', answered?: GitHubIssue): Promise<GitHubIssue> {
    const path = `/repos/${repo}/issues/${number}`;
    let issue = answered ?? await this.github.call<GitHubIssue>('PATCH', path, { state: 'closed', state_reason: reason });
    if (issue.state_reason !== reason) {
      await this.github.call('PATCH', path, { state: 'open' });
      issue = await this.github.call<GitHubIssue>('PATCH', path, { state: 'closed', state_reason: reason });
    }
    return issue;
  }

  /** Labels an issue gets are made in the repository first; one already there answers 422, which is fine. */
  private async ensureLabels(repo: string, names: readonly string[]): Promise<void> {
    const known = this.labels.get(repo) ?? new Set<string>();
    this.labels.set(repo, known);
    for (const name of names) {
      if (known.has(name.toLowerCase())) continue;
      try { await this.github.call('POST', `/repos/${repo}/labels`, { name }); }
      catch (error) { if (!(error instanceof GitHubCallError && error.status === 422)) throw error; }
      known.add(name.toLowerCase());
    }
  }

  /**
   * Uploads the task's images and videos not yet in this repository, one at a time: gh adds each to the issue's body,
   * and the address it adds is kept. Answers whether any went up (the body then holds gh's lines until it is sent again).
   */
  private async uploadFiles(map: IssueMap, account: string): Promise<boolean> {
    const files = this.store.githubRead(ctx => taskView(ctx, map.task_id, map.repo))?.files ?? [];
    let uploaded = false;
    for (const file of files) {
      if (file.gh_url || this.failedUploads.has(file.id) || !uploadable({ mimeType: file.mime, size: file.size })) continue;
      try {
        await withUploadCopy(todoFilePath(this.options.stateDir, file.sha256), file.id, UPLOADABLE[file.mime].ext, path => this.github.attach(map.repo, map.number, path, account));
        uploaded = true;
        const issue = await this.github.call<GitHubIssue>('GET', `/repos/${map.repo}/issues/${map.number}`);
        const url = lastAssetUrl(issue.body);
        if (!url) throw new Error('gh가 올린 파일 주소를 이슈 본문에서 찾지 못했습니다.');
        this.store.github(ctx => ctx.run('INSERT OR REPLACE INTO todo_github_files (file_id, repo, url, created_at) VALUES (?, ?, ?, ?)', file.id, map.repo, url, ctx.now));
      } catch (error) {
        const failure = this.itemFailure(error);
        this.failedUploads.add(file.id);
        console.error(`GitHub todo sync could not upload ${file.name}: ${failure}`);
      }
    }
    return uploaded;
  }

  /** Hangs the issue under its parent todo's issue (GitHub sub-issues), or takes it off. A failure only shows. */
  private async linkParent(map: IssueMap): Promise<void> {
    const want = this.store.githubRead(ctx => taskView(ctx, map.task_id, map.repo))?.parentNumber ?? null;
    if (want === (map.parent_number ?? null)) return;
    let error: string | null = null;
    try {
      if (want) await this.github.call('POST', `/repos/${map.repo}/issues/${want}/sub_issues`, { sub_issue_id: map.issue_id, replace_parent: true });
      else await this.github.call('DELETE', `/repos/${map.repo}/issues/${map.parent_number}/sub_issue`, { sub_issue_id: map.issue_id });
    } catch (failure) { error = `하위 이슈로 연결하지 못했습니다: ${this.itemFailure(failure)}`; }
    this.store.github(ctx => ctx.run('UPDATE todo_github_issues SET parent_number = ? WHERE task_id = ?', want, map.task_id));
    if (error) throw new Error(error);
  }

  private async pushComments(map: IssueMap): Promise<void> {
    const rows = this.store.githubRead(ctx => ctx.all<{ id: string; body: string; author: string | null; deleted_at: string | null } & Partial<CommentMap>>(`SELECT c.id, c.body, c.author, c.deleted_at,
      g.github_id, g.origin, g.synced_hash FROM todo_comments c LEFT JOIN todo_github_comments g ON g.comment_id = c.id WHERE c.task_id = ? ORDER BY c.created_at, c.rowid`, map.task_id));
    const files = this.store.githubRead(ctx => taskView(ctx, map.task_id, map.repo))?.files ?? [];
    for (const comment of rows) {
      if (comment.origin === 'github') continue;
      if (comment.deleted_at) {
        if (comment.github_id === undefined || comment.github_id === null) continue;
        await this.github.call('DELETE', `/repos/${map.repo}/issues/comments/${comment.github_id}`).catch(error => { if (!(error instanceof GitHubCallError && error.status === 404)) throw error; });
        this.store.github(ctx => ctx.run('DELETE FROM todo_github_comments WHERE comment_id = ?', comment.id));
        continue;
      }
      const body = commentText(comment.body, comment.author, files.filter(file => file.comment_id === comment.id));
      const hash = contentHash(body);
      if (comment.github_id === undefined || comment.github_id === null) {
        const made = await this.github.call<GitHubComment>('POST', `/repos/${map.repo}/issues/${map.number}/comments`, { body });
        this.store.github(ctx => ctx.run("INSERT INTO todo_github_comments (comment_id, task_id, github_id, url, origin, synced_hash, gh_updated_at) VALUES (?, ?, ?, ?, 'tower', ?, ?)",
          comment.id, map.task_id, made.id, made.html_url, hash, made.updated_at));
      } else if (hash !== comment.synced_hash) {
        const edited = await this.github.call<GitHubComment>('PATCH', `/repos/${map.repo}/issues/comments/${comment.github_id}`, { body });
        this.store.github(ctx => ctx.run('UPDATE todo_github_comments SET synced_hash = ?, gh_updated_at = ? WHERE comment_id = ?', hash, edited.updated_at, comment.id));
      }
    }
  }

  // ---- GitHub → Tower ------------------------------------------------------------------------------------------

  /** Every page, to the end: the poll's time moves only past what was read. */
  private async pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const items = await this.github.call<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      all.push(...items);
      if (items.length < 100) break;
    }
    return all;
  }

  private async pull(binding: BindingRow, errors: Map<string, string | null>): Promise<void> {
    const started = this.now().toISOString();
    const since = new Date(Date.parse(binding.polledAt ?? binding.createdAt) - POLL_OVERLAP_MS).toISOString();
    const issues = await this.pages<GitHubIssue>(`/repos/${binding.repo}/issues?state=all&sort=updated&direction=asc&since=${since}`);
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const map = this.store.githubRead(ctx => ctx.get<IssueMap>('SELECT * FROM todo_github_issues WHERE repo = ? AND number = ?', binding.repo, issue.number));
      if (!map || issue.updated_at <= map.gh_updated_at || !this.stillLinked(map)) continue;
      try { this.takeIssue(map, issue); }
      catch (error) { this.issueError(map.task_id, `GitHub 변경을 반영하지 못했습니다: ${message(error)}`); }
    }
    const comments = await this.pages<GitHubComment>(`/repos/${binding.repo}/issues/comments?sort=updated&direction=asc&since=${since}`);
    for (const comment of comments) {
      const number = Number(/\/issues\/(\d+)$/.exec(comment.issue_url)?.[1]);
      const map = this.store.githubRead(ctx => ctx.get<IssueMap>('SELECT * FROM todo_github_issues WHERE repo = ? AND number = ?', binding.repo, number));
      if (!map || !this.stillLinked(map)) continue;
      try { this.takeComment(map, comment); }
      catch (error) { errors.set(binding.id, `GitHub 댓글을 반영하지 못했습니다: ${message(error)}`); }
    }
    this.store.github(ctx => ctx.run('UPDATE todo_github_bindings SET polled_at = ? WHERE id = ?', started, binding.id));
  }

  /** Whether the todo still syncs with this issue's repository: one moved out of linked scopes, or unlinked, takes nothing. */
  private stillLinked(map: IssueMap): boolean {
    return this.store.githubRead(ctx => bindingOfTask(ctx, map.task_id))?.repo === map.repo;
  }

  /** Brings an issue's change into its todo, unless Tower changed the todo meanwhile (then Tower's goes up instead). */
  private takeIssue(map: IssueMap, issue: GitHubIssue): void {
    const today = this.today();
    const { changes } = this.store.github(ctx => {
      const view = taskView(ctx, map.task_id, map.repo);
      if (!view || issueHash(issueContent(view, JSON.parse(map.extra_labels) as string[])) !== map.synced_hash) return;
      bringIssue(ctx, map, issue, view, today);
    });
    if (changes) this.options.changed(changes);
  }

  private today(): string {
    const now = this.now();
    return formatDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  /** A new comment on the issue comes in as GitHub's; an edit comes in unless Tower changed that comment meanwhile. */
  private takeComment(map: IssueMap, comment: GitHubComment): void {
    const { changes } = this.store.github(ctx => {
      const known = ctx.get<CommentMap>('SELECT * FROM todo_github_comments WHERE github_id = ?', comment.id);
      if (known) {
        if (comment.updated_at <= known.gh_updated_at) return;
        const row = ctx.get<{ body: string; author: string | null; deleted_at: string | null }>('SELECT body, author, deleted_at FROM todo_comments WHERE id = ?', known.comment_id);
        if (!row || row.deleted_at) return;
        let body = row.body, hash: string | null = known.synced_hash;
        if (known.origin === 'github') body = (comment.body ?? '').slice(0, MAX_COMMENT);
        else {
          const files = taskView(ctx, map.task_id, map.repo)?.files.filter(file => file.comment_id === known.comment_id) ?? [];
          if (contentHash(commentText(row.body, row.author, files)) !== known.synced_hash) return;
          body = writtenPart(comment.body).slice(0, MAX_COMMENT) || row.body;
          hash = contentHash(commentText(body, row.author, files));
        }
        if (body !== row.body) {
          ctx.run('UPDATE todo_comments SET body = ?, updated_at = ? WHERE id = ?', body, ctx.now, known.comment_id);
          ctx.touched.comments.add(known.comment_id);
        }
        ctx.run('UPDATE todo_github_comments SET gh_updated_at = ?, synced_hash = ? WHERE comment_id = ?', comment.updated_at, hash, known.comment_id);
        return;
      }
      const task = ctx.get<{ deleted_at: string | null }>('SELECT deleted_at FROM todo_tasks WHERE id = ?', map.task_id);
      if (!task || task.deleted_at) return;
      addGitHubComment(ctx, map.task_id, comment);
    });
    if (changes) this.options.changed(changes);
  }
}
