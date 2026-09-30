import type { GitHubWatch, IssueWatch } from '../../shared/triggers.js';

/** One GitHub API answer, reduced to what checking needs. */
export interface GitHubResponse { status: number; body: unknown; etag?: string; truncated?: boolean; remaining?: number; reset?: number }
/** Reads by default; `send` makes it a write, whose failure may mean it arrived (`uncertain` on the error). */
export type GitHubFetch = (path: string, etag?: string, send?: { method: 'POST' | 'PATCH'; body: unknown }) => Promise<GitHubResponse>;

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
  /** Found because it asks the connected account for a review. */
  reviewRequested?: boolean;
}

/** What a trigger remembers between checks. */
export interface GitHubCursor {
  /** Pull requests asking for a review at the last complete check, as `owner/name#number`. */
  reviews?: string[];
  /** Issues taken, as `owner/name#number`; kept while they are open, whatever the filters say later. */
  handled?: string[];
  /** Issues left alone because they were already there when a watch starting from now began; kept while open. */
  skipped?: string[];
  /** Issues that matched at the last check, taken or waiting for a place. */
  matched?: string[];
  /** When the last complete check finished. */
  checkedAt?: number;
  /**
   * Issues already there are noted instead of taken at the next check: those created before `before` that did not
   * match at the last check (after an edit), or those up to a number per repository (kept from the earlier new-issue
   * watch). The very first check of a watch that starts from now notes all of them.
   */
  baseline?: { before?: string; watermarks?: Record<string, number> };
  /** When remembered issues missing from the assigned list were last looked up. */
  verifiedAt?: number;
}

/** A failed check. `retryAt` is when GitHub's rate limit allows the next one. */
export class GitHubError extends Error {
  constructor(message: string, readonly retryAt?: number) { super(message); }
}

const OPEN_PAGE = 100;
const OPEN_PAGES = 10;
const MAX_OPEN = 5000;
/** Remembered issues missing from the assigned list whose state one check looks up. */
const VERIFY_PER_CHECK = 30;
const VERIFY_EVERY_MS = 60 * 60_000;
const SEARCH_PAGE = 100;
/** GitHub's search never returns more than this many results. */
const SEARCH_MAX = 1000;
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

const labelsOf = (item: Item) => Array.isArray(item.labels) ? item.labels.flatMap(label => typeof label === 'string' ? [label] : record(label) ? [text(label.name)] : []).filter(Boolean) : [];
const assigneesOf = (item: Item) => Array.isArray(item.assignees) ? item.assignees.map(login).filter(Boolean) : [];

export function issueOf(item: Item, repository?: string): GitHubIssue {
  const fromUrl = /\/repos\/([^/]+\/[^/?#]+)/.exec(text(item.repository_url))?.[1] ?? '';
  const body = text(item.body);
  return {
    repository: repository || (record(item.repository) ? text(item.repository.full_name) : '') || fromUrl,
    number: Number(item.number),
    title: text(item.title).slice(0, 300),
    body: body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}… [cut]` : body,
    author: login(item.user),
    authorAssociation: text(item.author_association),
    labels: labelsOf(item).slice(0, 20),
    assignees: assigneesOf(item).slice(0, 20),
    url: text(item.html_url),
    createdAt: text(item.created_at),
    isPullRequest: record(item.pull_request),
  };
}

export const keyOf = (issue: Pick<GitHubIssue, 'repository' | 'number'>) => `${issue.repository.toLowerCase()}#${issue.number}`;
const lower = (values: readonly string[] | undefined) => values?.map(value => value.toLowerCase());

/** One check of a watch. A check that does not finish throws and changes nothing. */
export async function checkGitHub(watch: GitHubWatch, previous: GitHubCursor, fetch: GitHubFetch, account: string, now = Date.now()): Promise<{ issues: GitHubIssue[]; cursor: GitHubCursor }> {
  return watch.type === 'review-requested' ? checkReviews(watch, previous, fetch) : checkIssues(watch, previous, fetch, account, now);
}


/** Whether an open issue passes the watch's filters, judged on everything GitHub said about it, before any shortening. */
export function wanted(watch: IssueWatch, item: Item, account: string): boolean {
  const labels = labelsOf(item).map(label => label.toLowerCase());
  const assignees = assigneesOf(item).map(name => name.toLowerCase());
  const include = lower(watch.labels);
  const exclude = lower(watch.excludeLabels);
  const authors = lower(watch.authors);
  if (record(item.pull_request) && !watch.includePullRequests) return false;
  if (include?.length && !labels.some(label => include.includes(label))) return false;
  if (exclude?.length && labels.some(label => exclude.includes(label))) return false;
  if (authors?.length && !authors.includes(login(item.user).toLowerCase())) return false;
  if (watch.assignee === 'me' && !assignees.includes(account.toLowerCase())) return false;
  if (watch.assignee === 'none' && assignees.length) return false;
  return watch.authorAssociation === 'any' || watch.authorAssociation.includes(text(item.author_association) as never);
}

/** The order the watch works in: by when issues were opened. */
export function ordered(watch: IssueWatch, issues: GitHubIssue[]): GitHubIssue[] {
  const sorted = [...issues].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.repository.localeCompare(b.repository) || a.number - b.number);
  return watch.order === 'newest' ? sorted.reverse() : sorted;
}

/** What one read of an issue watch saw: the matching open issues in order, and every open issue it read. */
export interface IssueRead { issues: GitHubIssue[]; open: Set<string>; complete: boolean }

/**
 * Reads every open issue the watch covers, whole. With repositories, each one's whole open list is read, so an
 * issue missing from it is known to be closed (`complete`); without, only the account's assigned issues are listed.
 */
export async function readIssues(watch: IssueWatch, fetch: GitHubFetch, account: string): Promise<IssueRead> {
  const raw: Array<{ item: Item; repo?: string }> = [];
  const read = async (path: (page: number) => string, what: string, repo?: string) => {
    for (let page = 1; ; page++) {
      if (page > OPEN_PAGES) throw new GitHubError(`More than ${OPEN_PAGE * OPEN_PAGES} issues and pull requests are open in ${what}, more than one check reads.`);
      const list = items(await fetch(path(page)), what);
      raw.push(...list.map(item => ({ item, ...(repo ? { repo } : {}) })));
      if (list.length < OPEN_PAGE) break;
    }
  };
  const paging = (page: number) => `per_page=${OPEN_PAGE}${page > 1 ? `&page=${page}` : ''}`;
  if (watch.repos.length) for (const repo of watch.repos) await read(page => `/repos/${repo}/issues?state=open&sort=created&direction=asc&${paging(page)}`, repo, repo);
  else await read(page => `/issues?filter=assigned&state=open&sort=created&direction=asc&${paging(page)}`, 'Your assigned issues');
  const open = raw.filter(({ item }) => item.state === 'open');
  if (open.length > MAX_OPEN) throw new GitHubError(`More than ${MAX_OPEN} issues are open in the watched repositories, more than this trigger keeps track of.`);
  const issues = open.filter(({ item }) => wanted(watch, item, account)).map(({ item, repo }) => issueOf(item, repo));
  return { issues: ordered(watch, issues), open: new Set(open.map(({ item, repo }) => keyOf(issueOf(item, repo)))), complete: watch.repos.length > 0 };
}

/**
 * The issues a watch that starts from now notes instead of taking: at its first check all that match; after an
 * edit, those opened before the last check that did not match then; after the move from the earlier new-issue watch,
 * those up to the number it had seen in each repository.
 */
export function noted(watch: IssueWatch, previous: GitHubCursor, issues: GitHubIssue[]): string[] {
  if (watch.start !== 'new') return [];
  const baseline = previous.checkedAt === undefined ? previous.baseline ?? {} : previous.baseline;
  if (!baseline) return [];
  const matched = new Set(previous.matched ?? []);
  return issues.filter(issue => {
    if (baseline.watermarks) { const mark = baseline.watermarks[issue.repository.toLowerCase()]; return mark === undefined || issue.number <= mark; }
    if (baseline.before) return !matched.has(keyOf(issue)) && Date.parse(issue.createdAt) < Date.parse(baseline.before);
    return true;
  }).map(keyOf);
}

/** The issues a watch passes over: those it took, and, while it starts from now, those it left alone. */
export function passed(watch: IssueWatch, cursor: GitHubCursor): Set<string> {
  return new Set([...cursor.handled ?? [], ...watch.start === 'new' ? cursor.skipped ?? [] : []]);
}

/**
 * One check of an issue watch: every matching open issue in order, and what to remember. Which of them to take is
 * the service's choice. An issue taken stays remembered while it is open, whatever the filters say later.
 */
async function checkIssues(watch: IssueWatch, previous: GitHubCursor, fetch: GitHubFetch, account: string, now: number): Promise<{ issues: GitHubIssue[]; cursor: GitHubCursor }> {
  const read = await readIssues(watch, fetch, account);
  let handled = previous.handled ?? [];
  let skipped = previous.skipped ?? [];
  let verifiedAt = previous.verifiedAt;
  if (read.complete) { handled = handled.filter(key => read.open.has(key)); skipped = skipped.filter(key => read.open.has(key)); }
  else {
    // The assigned list is not every open issue: a remembered issue missing from it is forgotten only once it is
    // known to be closed or gone. A few are looked up at most once an hour, so the shared request budget is not used
    // up; those still open go to the back of the line.
    const due = previous.verifiedAt === undefined || now - previous.verifiedAt >= VERIFY_EVERY_MS;
    const missing = due ? [...handled, ...skipped].filter(key => !read.open.has(key)).slice(0, VERIFY_PER_CHECK) : [];
    if (missing.length) verifiedAt = now;
    const closed = new Set<string>();
    for (const key of missing) {
      const [, repo, number] = /^(.+)#(\d+)$/.exec(key) ?? [];
      if (!repo) { closed.add(key); continue; }
      const response = await fetch(`/repos/${repo}/issues/${number}`);
      refused(response);
      // Not found, gone, or no longer visible to the account (a rate limit was already refused above).
      const gone = [403, 404, 410, 451].includes(response.status);
      if (!gone && (response.status < 200 || response.status > 299)) throw new GitHubError(`GitHub answered HTTP ${response.status} for ${repo}#${number}.`);
      if (gone || (record(response.body) && response.body.state !== 'open')) closed.add(key);
    }
    const open = new Set(missing.filter(key => !closed.has(key)));
    const requeue = (list: string[]) => [...list.filter(key => !closed.has(key) && !open.has(key)), ...list.filter(key => open.has(key))];
    handled = requeue(handled);
    skipped = requeue(skipped);
  }
  const taken = new Set(handled);
  skipped = [...new Set([...skipped, ...noted(watch, previous, read.issues).filter(key => !taken.has(key))])];
  if (handled.length + skipped.length > MAX_OPEN) throw new GitHubError(`More than ${MAX_OPEN} issues are remembered for this trigger; narrow it to some repositories.`);
  return { issues: read.issues, cursor: { handled, skipped, matched: read.issues.map(keyOf), checkedAt: now, ...(verifiedAt !== undefined && !read.complete ? { verifiedAt } : {}) } };
}

/**
 * Review requests are read whole from GitHub's search each time, and a pull request that enters the list runs.
 * It leaves the list when the review is in, or while it is a draft, so a request again, or marking it ready, runs again.
 */
async function checkReviews(watch: Extract<GitHubWatch, { type: 'review-requested' }>, previous: GitHubCursor, fetch: GitHubFetch): Promise<{ issues: GitHubIssue[]; cursor: GitHubCursor }> {
  const query = encodeURIComponent(`is:pr is:open draft:false archived:false ${watch.includeTeams ? 'review-requested' : 'user-review-requested'}:@me`);
  const all: Item[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`/search/issues?q=${query}&sort=created&order=asc&per_page=${SEARCH_PAGE}&page=${page}`);
    refused(response);
    if (response.status < 200 || response.status > 299) throw new GitHubError(`GitHub answered HTTP ${response.status} for your review requests.`);
    if (response.truncated) throw new GitHubError("GitHub's answer for your review requests was too large to read completely.");
    const body = response.body;
    if (!record(body) || !Array.isArray(body.items)) throw new GitHubError("GitHub's answer for your review requests was not a search result.");
    // An incomplete search could leave a request out, and it would then run again when it came back.
    if (body.incomplete_results === true) throw new GitHubError('GitHub could not search all your review requests in time; checking tries again next time.');
    const total = Number(body.total_count) || 0;
    if (total > SEARCH_MAX) throw new GitHubError(`More than ${SEARCH_MAX} pull requests ask for your review, more than GitHub's search returns; narrow the trigger to some repositories.`);
    all.push(...body.items.filter(record));
    if (body.items.length < SEARCH_PAGE || all.length >= total) break;
  }
  const repos = lower(watch.repos);
  const current = all.map(item => ({ ...issueOf(item), reviewRequested: true })).filter(issue => issue.isPullRequest && (!repos?.length || repos.includes(issue.repository.toLowerCase())));
  const keys = current.map(keyOf);
  if (!previous.reviews) return { issues: [], cursor: { reviews: keys } };
  const before = new Set(previous.reviews);
  return { issues: current.filter(issue => !before.has(keyOf(issue))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), cursor: { reviews: keys } };
}
