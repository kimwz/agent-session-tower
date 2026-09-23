import type { GitHubWatch } from '../../shared/triggers.js';

/** One GitHub API answer, reduced to what checking needs. */
export interface GitHubResponse { status: number; body: unknown; etag?: string; truncated?: boolean; remaining?: number; reset?: number }
/** Reads by default; `send` makes it a POST, whose failure may mean it arrived (`uncertain` on the error). */
export type GitHubFetch = (path: string, etag?: string, send?: { method: 'POST'; body: unknown }) => Promise<GitHubResponse>;

/** An issue as a run receives it: outside content, shortened. */
export interface GitHubIssue {
  repository: string;
  number: number;
  title: string;
  body: string;
  author: string;
  authorAssociation: string;
  labels: string[];
  assignees: string[];
  url: string;
  createdAt: string;
  isPullRequest: boolean;
}

/** What a trigger remembers between checks. */
export interface GitHubCursor {
  /** Per repository: the highest issue number seen, and the first page's ETag. */
  repos?: Record<string, { watermark: number; etag?: string }>;
  /** Issues assigned at the last complete check, as `owner/name#number`. */
  assigned?: string[];
  assignedEtag?: string;
}

/** A failed check. `retryAt` is when GitHub's rate limit allows the next one. */
export class GitHubError extends Error {
  constructor(message: string, readonly retryAt?: number) { super(message); }
}

const ISSUE_PAGE = 30;
const ISSUE_PAGES = 10;
const ASSIGNED_PAGE = 100;
const ASSIGNED_PAGES = 10;
const MAX_ASSIGNED = 2000;
const BODY_CHARS = 8000;

type Item = Record<string, unknown>;
const record = (value: unknown): value is Item => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const login = (value: unknown) => record(value) ? text(value.login) : '';

/** Rejected credentials and a used-up rate limit end a check the same way wherever they are met. */
export function refused(response: GitHubResponse): void {
  if (response.status === 401) throw new GitHubError('GitHub rejected the credentials. Sign in again with gh, or save a new token.');
  if ((response.status === 403 || response.status === 429) && response.remaining === 0) {
    const retryAt = response.reset ? response.reset * 1000 : undefined;
    throw new GitHubError(`GitHub's rate limit is used up${retryAt ? ` until ${new Date(retryAt).toISOString()}` : ''}; checking resumes then.`, retryAt);
  }
}

/** Fails a check on anything but a complete, successful answer. */
function items(response: GitHubResponse, what: string): Item[] {
  refused(response);
  if (response.status === 404) throw new GitHubError(`${what} was not found, or the connected account cannot see it.`);
  if (response.status < 200 || response.status > 299) throw new GitHubError(`GitHub answered HTTP ${response.status} for ${what}.`);
  if (response.truncated) throw new GitHubError(`GitHub's answer for ${what} was too large to read completely.`);
  if (!Array.isArray(response.body)) throw new GitHubError(`GitHub's answer for ${what} was not a list.`);
  return response.body.filter(record);
}

export function issueOf(item: Item, repository?: string): GitHubIssue {
  const fromUrl = /repos\/([^/]+\/[^/]+)\/issues/.exec(text(item.repository_url))?.[1] ?? '';
  const body = text(item.body);
  return {
    repository: repository || (record(item.repository) ? text(item.repository.full_name) : '') || fromUrl,
    number: Number(item.number),
    title: text(item.title).slice(0, 300),
    body: body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}… [cut]` : body,
    author: login(item.user),
    authorAssociation: text(item.author_association),
    labels: Array.isArray(item.labels) ? item.labels.flatMap(label => typeof label === 'string' ? [label] : record(label) ? [text(label.name)] : []).filter(Boolean).slice(0, 20) : [],
    assignees: Array.isArray(item.assignees) ? item.assignees.map(login).filter(Boolean).slice(0, 20) : [],
    url: text(item.html_url),
    createdAt: text(item.created_at),
    isPullRequest: record(item.pull_request),
  };
}

const keyOf = (issue: Pick<GitHubIssue, 'repository' | 'number'>) => `${issue.repository.toLowerCase()}#${issue.number}`;
const lower = (values: readonly string[] | undefined) => values?.map(value => value.toLowerCase());

/** Whether an opened issue passes the watch's filters. */
export function wanted(watch: Extract<GitHubWatch, { type: 'issue-opened' }>, issue: GitHubIssue): boolean {
  const labels = lower(watch.labels);
  const authors = lower(watch.authors);
  if (labels?.length && !issue.labels.some(label => labels.includes(label.toLowerCase()))) return false;
  if (authors?.length && !authors.includes(issue.author.toLowerCase())) return false;
  return watch.authorAssociation === 'any' || watch.authorAssociation.includes(issue.authorAssociation as never);
}

/**
 * One check of a watch: the issues that are new since the last check, and what to remember for the next.
 * The first check of a repository or of assignments only remembers what is there, so setting a trigger up
 * never starts runs for issues that already existed. A check that does not finish throws and changes nothing.
 */
export async function checkGitHub(watch: GitHubWatch, previous: GitHubCursor, fetch: GitHubFetch): Promise<{ issues: GitHubIssue[]; cursor: GitHubCursor }> {
  if (watch.type === 'issue-opened') {
    const repos: NonNullable<GitHubCursor['repos']> = {};
    const found: GitHubIssue[] = [];
    for (const repo of watch.repos) {
      const known = previous.repos?.[repo];
      const path = (page: number) => `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=${ISSUE_PAGE}${page > 1 ? `&page=${page}` : ''}`;
      const first = await fetch(path(1), known?.etag);
      if (first.status === 304 && known) { repos[repo] = known; continue; }
      const all = items(first, repo);
      const highest = (list: Item[]) => list.reduce((max, item) => Math.max(max, Number(item.number) || 0), 0);
      if (!known) { repos[repo] = { watermark: highest(all), ...(first.etag ? { etag: first.etag } : {}) }; continue; }
      // Newest first: read on until the last issue already seen. If that is too far back, nothing is skipped
      // quietly: the check fails and says so, and the owner starts over from now by turning the trigger off and on.
      let last = all;
      for (let page = 2; last.length === ISSUE_PAGE && Math.min(...last.map(item => Number(item.number))) > known.watermark; page++) {
        if (page > ISSUE_PAGES) throw new GitHubError(`More than ${ISSUE_PAGE * ISSUE_PAGES} issues and pull requests were opened in ${repo} since the last check, more than one check reads, so checking stopped rather than skip some. Trying again will not help. To continue, turn the trigger off and on: it then starts from now in every watched repository, and what was opened in between is not run.`);
        last = items(await fetch(path(page)), repo);
        all.push(...last);
      }
      // Pull requests share the numbering but are not issues; an issue already closed again is left alone.
      const fresh = all.filter(item => Number(item.number) > known.watermark && !record(item.pull_request) && item.state === 'open')
        .map(item => issueOf(item, repo)).filter(issue => wanted(watch, issue)).sort((a, b) => a.number - b.number);
      found.push(...fresh);
      repos[repo] = { watermark: Math.max(known.watermark, highest(all)), ...(first.etag ? { etag: first.etag } : {}) };
    }
    return { issues: found, cursor: { repos } };
  }
  // Only a list that fit on one page is asked for with its ETag: a later page can change while the first does not.
  const first = await fetch(`/issues?filter=assigned&state=open&per_page=${ASSIGNED_PAGE}`, previous.assignedEtag);
  if (first.status === 304 && previous.assigned) return { issues: [], cursor: previous };
  const all = items(first, 'Your assigned issues');
  let complete = all.length < ASSIGNED_PAGE;
  for (let page = 2, last = all; !complete && page <= ASSIGNED_PAGES; page++) {
    last = items(await fetch(`/issues?filter=assigned&state=open&per_page=${ASSIGNED_PAGE}&page=${page}`), 'Your assigned issues');
    all.push(...last);
    complete = last.length < ASSIGNED_PAGE;
  }
  const repos = lower(watch.repos);
  const current = all.map(item => issueOf(item)).filter(issue => (!repos?.length || repos.includes(issue.repository.toLowerCase())) && (watch.includePullRequests || !issue.isPullRequest));
  const keys = current.map(keyOf);
  const etag = first.etag && all.length < ASSIGNED_PAGE ? { assignedEtag: first.etag } : {};
  // A partial list (more than ten pages) adds to what is remembered and forgets nothing, so nothing is reported
  // new twice; past the limit the check fails and the remembered list stays as it was.
  const remembered = complete || !previous.assigned ? keys : [...new Set([...previous.assigned, ...keys])];
  if (remembered.length > MAX_ASSIGNED) throw new GitHubError(`More than ${MAX_ASSIGNED} issues are assigned; narrow the trigger to some repositories.`);
  if (!previous.assigned) return { issues: [], cursor: { assigned: remembered, ...etag } };
  const before = new Set(previous.assigned);
  return { issues: current.filter(issue => !before.has(keyOf(issue))), cursor: { assigned: remembered, ...etag } };
}
