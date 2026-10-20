import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GitHubCallError, type TodoGitHub } from '../../server/todo/github/client.js';

/**
 * GitHub's issues, comments, labels and sub-issues as the todo sync calls them, in memory. Times are whole seconds as
 * GitHub writes them; each change moves the clock a second, so `updated_at` tells changes apart as it does there.
 */

export interface FakeIssue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed'; state_reason: string | null;
  labels: string[]; updated_at: string; parent?: number; html_url: string;
}
export interface FakeComment { id: number; issue: number; body: string; login: string; created_at: string; updated_at: string; html_url: string }
interface Repo { issues: FakeIssue[]; comments: FakeComment[]; labels: Set<string> }

export class FakeGitHub implements TodoGitHub {
  account = 'kimwz';
  readonly repos = new Map<string, Repo>();
  /** Every call as `METHOD path` (query left out), in order. */
  readonly calls: string[] = [];
  /** What each upload sent: the file's bytes, by the issue it went to. */
  readonly uploads: { repo: string; issue: number; bytes: Buffer }[] = [];
  private clock = Date.parse('2026-10-20T00:00:00Z');
  private ids = 1000;

  constructor(repos: string[]) { for (const repo of repos) this.repos.set(repo, { issues: [], comments: [], labels: new Set() }); }

  /** GitHub's clock, which the tests' store and sync share. */
  readonly now = () => new Date(this.clock);
  /** Time passing without a change. */
  wait(ms: number): void { this.clock += ms; }
  private tick(): string { this.clock += 1000; return new Date(this.clock).toISOString().replace('.000Z', 'Z'); }
  private repo(name: string): Repo {
    const repo = this.repos.get(name);
    if (!repo) throw new GitHubCallError(404, `GitHub: ${name} Not Found`);
    return repo;
  }
  private issueOf(repo: Repo, number: number): FakeIssue {
    const issue = repo.issues.find(item => item.number === number);
    if (!issue) throw new GitHubCallError(404, 'Not Found');
    return issue;
  }
  private view(issue: FakeIssue) { return { ...issue, labels: issue.labels.map(name => ({ name })) }; }
  private commentView(comment: FakeComment, repo: string) {
    return { id: comment.id, html_url: comment.html_url, issue_url: `https://api.github.com/repos/${repo}/issues/${comment.issue}`, body: comment.body, user: { login: comment.login }, created_at: comment.created_at, updated_at: comment.updated_at };
  }

  issue(repo: string, number: number): FakeIssue { return this.issueOf(this.repo(repo), number); }
  issuesOf(repo: string): FakeIssue[] { return this.repo(repo).issues; }
  commentsOf(repo: string, number: number): FakeComment[] { return this.repo(repo).comments.filter(comment => comment.issue === number); }

  /** Someone changes an issue on GitHub. */
  edit(repo: string, number: number, patch: Partial<Pick<FakeIssue, 'title' | 'body' | 'state' | 'labels'>>): void {
    const issue = this.issue(repo, number);
    Object.assign(issue, patch);
    if (patch.state === 'closed') issue.state_reason = 'completed';
    if (patch.state === 'open') issue.state_reason = 'reopened';
    issue.updated_at = this.tick();
  }

  /** Someone comments on GitHub. */
  comment(repo: string, number: number, login: string, body: string): FakeComment {
    const at = this.tick(), id = ++this.ids;
    const comment = { id, issue: number, body, login, created_at: at, updated_at: at, html_url: `https://github.com/${repo}/issues/${number}#issuecomment-${id}` };
    this.repo(repo).comments.push(comment);
    return comment;
  }

  /** Someone edits a comment on GitHub. */
  editComment(repo: string, id: number, body: string): void {
    const comment = this.repo(repo).comments.find(item => item.id === id)!;
    comment.body = body;
    comment.updated_at = this.tick();
  }

  async login(): Promise<string> { return this.account; }

  async call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const [route, query = ''] = path.split('?');
    this.calls.push(`${method} ${route}`);
    const params = new URLSearchParams(query);
    const input = (body ?? {}) as Record<string, unknown>;
    let found: RegExpExecArray | null;
    if ((found = /^\/repos\/([^/]+\/[^/]+)$/.exec(route)) && method === 'GET') {
      this.repo(found[1]);
      return { full_name: found[1], private: true, permissions: { push: true } } as T;
    }
    if ((found = /^\/repos\/([^/]+\/[^/]+)\/labels$/.exec(route)) && method === 'POST') {
      const repo = this.repo(found[1]), name = String(input.name).toLowerCase();
      if (repo.labels.has(name)) throw new GitHubCallError(422, 'Validation Failed');
      repo.labels.add(name);
      return { name: input.name } as T;
    }
    if ((found = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(route))) {
      const repo = this.repo(found[1]);
      if (method === 'POST') {
        const number = repo.issues.length + 1, id = ++this.ids;
        const issue: FakeIssue = { id, number, title: String(input.title), body: String(input.body ?? ''), state: 'open', state_reason: null,
          labels: (input.labels as string[] | undefined) ?? [], updated_at: this.tick(), html_url: `https://github.com/${found[1]}/issues/${number}` };
        repo.issues.push(issue);
        return this.view(issue) as T;
      }
      const since = params.get('since') ?? '', page = Number(params.get('page') ?? 1), size = Number(params.get('per_page') ?? 30);
      const listed = repo.issues.filter(issue => issue.updated_at >= since.replace('.000Z', 'Z')).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return listed.slice((page - 1) * size, page * size).map(issue => this.view(issue)) as T;
    }
    if ((found = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments$/.exec(route)) && method === 'GET') {
      const since = params.get('since') ?? '', page = Number(params.get('page') ?? 1), size = Number(params.get('per_page') ?? 30);
      const listed = this.repo(found[1]).comments.filter(comment => comment.updated_at >= since.replace('.000Z', 'Z')).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return listed.slice((page - 1) * size, page * size).map(comment => this.commentView(comment, found![1])) as T;
    }
    if ((found = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(route))) {
      const repo = this.repo(found[1]), id = Number(found[2]);
      const comment = repo.comments.find(item => item.id === id);
      if (!comment) throw new GitHubCallError(404, 'Not Found');
      if (method === 'DELETE') { repo.comments.splice(repo.comments.indexOf(comment), 1); return undefined as T; }
      comment.body = String(input.body);
      comment.updated_at = this.tick();
      return this.commentView(comment, found[1]) as T;
    }
    if ((found = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(route)) && method === 'POST') {
      const comment = this.comment(found[1], Number(found[2]), this.account, String(input.body));
      return this.commentView(comment, found[1]) as T;
    }
    if ((found = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/sub_issues?$/.exec(route))) {
      const repo = this.repo(found[1]);
      const child = repo.issues.find(issue => issue.id === input.sub_issue_id);
      if (!child) throw new GitHubCallError(422, 'Validation Failed');
      child.parent = method === 'DELETE' ? undefined : Number(found[2]);
      return {} as T;
    }
    if ((found = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(route))) {
      const issue = this.issueOf(this.repo(found[1]), Number(found[2]));
      if (method === 'GET') return this.view(issue) as T;
      const wasState = issue.state;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (Array.isArray(input.labels)) issue.labels = input.labels as string[];
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      // As GitHub does: a reason counts only when the state changes.
      if (issue.state !== wasState) issue.state_reason = issue.state === 'closed' ? String(input.state_reason ?? 'completed') : 'reopened';
      issue.updated_at = this.tick();
      return this.view(issue) as T;
    }
    throw new Error(`FakeGitHub: no route for ${method} ${path}`);
  }

  async attach(repo: string, number: number, path: string): Promise<void> {
    this.calls.push(`gh issue edit ${number} --attach`);
    const issue = this.issue(repo, number);
    this.uploads.push({ repo, issue: number, bytes: await readFile(path) });
    issue.body = `${issue.body}\n\n![${path.split('/').at(-1)}](https://github.com/user-attachments/assets/${randomUUID()})`;
    issue.updated_at = this.tick();
  }
}
