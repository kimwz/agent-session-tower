import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { Run, Session, WorktreeCleanup, WorktreeKeptReason } from '../../shared/types.js';
import { gitRunner, type GitRunner } from '../repositories/git.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { linkedWorktree, removalBlocker, removeWorktree, type LinkedWorktree } from './git.js';
import { processCwds } from './process-cwds.js';
import { transcriptCreations, transcriptMentions } from './transcripts.js';

const VERSION = 1;
const FIRST_PASS_MS = 60_000;
const PASS_MS = 5 * 60_000;
/** Families whose transcripts are read in one pass; the backlog after an update drains over several passes. */
const FAMILIES_PER_PASS = 20;
/** A trigger or Slack follow-up may continue a finished automation session shortly after. */
const AUTOMATION_GRACE_MS = 30 * 60_000;
const RECHECK_MS = 60 * 60_000;
const SLACK_MS = 5_000;
/** How long after its call a creation may still be proven: background calls and calls without a result. */
const LONGEST_CALL_MS = 30 * 60_000;
const KEEP_REMOVED = 500;

interface Entry {
  root: string;
  sessions: string[];
  createdAt: number;
  state: 'pending' | 'kept' | 'removed';
  reason?: WorktreeKeptReason;
  detail?: string;
  checkedAt: number;
}
interface Saved { version: number; scanned: Record<string, string>; worktrees: Record<string, Entry> }

export interface WorktreeJanitorOptions {
  stateDir: string;
  /** Every conversation, also those the canvas no longer shows. */
  sessions: () => Session[];
  /** Conversations the owner closed, as the web process last saved them. */
  closedIds: () => Promise<ReadonlySet<string>>;
  /** Sessions automation created whose work is done (`finishedAutomationSessionIds`). */
  finishedAutomation: () => ReadonlySet<string>;
  runs: () => Run[];
  git?: GitRunner;
  home?: string;
  now?: () => number;
  cwds?: () => Promise<string[] | undefined>;
  firstPassMs?: number;
  passMs?: number;
}

export const worktreeCleanupFile = (stateDir: string) => join(stateDir, 'worktree-cleanup.json');

/**
 * Removes the git worktrees a conversation made once its work is over: the owner closed it, or automation finished it.
 * Only worktrees its own transcript proves it created, only when every session that ran the same `git worktree add` is done,
 * nobody else refers to or works in the folder, and nothing committed or uncommitted would be lost. Branches are kept.
 */
export class WorktreeJanitor {
  private saved: Saved = { version: VERSION, scanned: {}, worktrees: {} };
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private removing = false;
  private paused = false;
  private closed = false;
  /** Per session and transcript revision: the folder names looked for, and those it refers to. */
  private readonly mentions = new Map<string, { searched: Set<string>; found: Set<string> }>();
  private readonly git: GitRunner;
  private readonly home: string;
  private readonly now: () => number;

  constructor(private readonly options: WorktreeJanitorOptions) {
    this.git = options.git ?? gitRunner();
    this.home = options.home ?? homedir();
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.saved = await loadCleanup(this.options.stateDir);
    this.schedule(this.options.firstPassMs ?? FIRST_PASS_MS);
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  /** A removal under way: a handoff waits for it rather than leave a half-deleted folder to the next worker. */
  inFlight(): boolean { return this.removing; }
  async flush(): Promise<void> { await this.running; }

  private schedule(ms: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => { void this.pass().finally(() => this.schedule(this.options.passMs ?? PASS_MS)); }, ms);
    this.timer.unref?.();
  }

  /** One pass; never runs twice at once. */
  pass(): Promise<void> {
    if (this.paused || this.closed) return Promise.resolve();
    this.running ??= this.work().catch(error => { console.error(`Worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async work(): Promise<void> {
    const now = this.now();
    const sessions = this.options.sessions();
    const closed = await this.options.closedIds();
    const automation = this.options.finishedAutomation();
    const families = groupFamilies(sessions);
    const busy = busySessionIds(sessions, this.options.runs());
    const finishedRoots = new Set<string>();
    for (const [root, members] of families) {
      if (members.some(member => busy.has(member.id))) continue;
      const lastActive = Math.max(...members.map(member => Date.parse(member.updatedAt) || 0));
      if (closed.has(root) || (automation.has(root) && now - lastActive >= AUTOMATION_GRACE_MS)) finishedRoots.add(root);
    }
    const finished = new Set([...finishedRoots].flatMap(root => families.get(root)!.map(member => member.id)));
    let changed = false;

    let budget = FAMILIES_PER_PASS;
    for (const root of finishedRoots) {
      const members = families.get(root)!;
      if (members.every(member => this.saved.scanned[member.id] === member.updatedAt)) continue;
      if (budget-- <= 0 || this.closed || this.paused) break;
      try {
        await this.scan(root, members);
        for (const member of members) this.saved.scanned[member.id] = member.updatedAt;
        changed = true;
      } catch (error) {
        // Not recorded as scanned: the next pass tries this family again.
        console.error(`Worktrees of ${root} were not checked: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const due = Object.entries(this.saved.worktrees).filter(([, entry]) => entry.state !== 'removed' && finishedRoots.has(entry.root)
      && (entry.state === 'pending' || now - entry.checkedAt >= RECHECK_MS));
    if (due.length) {
      const cwds = await (this.options.cwds ?? processCwds)();
      const open = sessions.filter(session => !finished.has(session.id));
      const referrers = await this.referrers(open, [...new Set(due.map(([path]) => basename(path)))]);
      for (const [path, entry] of due) {
        if (this.closed || this.paused) break;
        await this.settle(path, entry, sessions, finished, open, referrers, cwds);
        changed = true;
      }
    }
    if (changed) await this.save(sessions);
  }

  /** Records every worktree a family's transcripts prove they created and that still exists. */
  private async scan(root: string, members: Session[]): Promise<void> {
    for (const member of members) {
      if (!member.filePath) continue;
      for (const creation of await unlessGone(transcriptCreations(member.filePath, member.provider, this.home, member.cwd || undefined), [])) {
        const worktree = await linkedWorktree(this.git, creation.path);
        if (!worktree || !createdBy(worktree, creation)) continue;
        const entry = this.saved.worktrees[worktree.path];
        if (entry && entry.createdAt === worktree.createdAt) { if (!entry.sessions.includes(member.id)) entry.sessions.push(member.id); continue; }
        this.saved.worktrees[worktree.path] = { root, sessions: [member.id], createdAt: worktree.createdAt, state: 'pending', checkedAt: 0 };
      }
    }
  }

  private async settle(path: string, entry: Entry, sessions: Session[], finished: ReadonlySet<string>, open: Session[], referrers: ReadonlyMap<string, Session>, cwds: string[] | undefined): Promise<void> {
    const keep = (reason: WorktreeKeptReason, detail?: string) => Object.assign(entry, { state: 'kept', reason, detail, checkedAt: this.now() });
    try {
      const worktree = await linkedWorktree(this.git, path);
      // Gone, or another worktree made later at the same place: nothing of this conversation's is left there.
      if (!worktree || worktree.createdAt !== entry.createdAt) { delete this.saved.worktrees[path]; return; }
      const name = basename(worktree.path);
      // Every session that ran a `git worktree add` for this folder around its creation must be done: a failed attempt
      // at a path someone else had just created, and a fork's copy of its original's command, look the same.
      for (const session of sessions) {
        if (finished.has(session.id) || !session.filePath) continue;
        const from = Date.parse(session.createdAt) - 60_000, to = Date.parse(session.updatedAt) + 60_000;
        if (!(from <= worktree.createdAt && worktree.createdAt <= to)) continue;
        const creations = await unlessGone(transcriptCreations(session.filePath, session.provider, this.home, session.cwd || undefined, name), []);
        for (const creation of creations) {
          if (!(creation.start - SLACK_MS <= worktree.createdAt && worktree.createdAt <= creation.start + LONGEST_CALL_MS + SLACK_MS)) continue;
          if (await realpath(creation.path).catch(() => creation.path) === worktree.path) { keep('otherCreator', session.title); return; }
        }
      }
      const inside = (folder: string) => folder === worktree.path || folder.startsWith(worktree.path + sep);
      const referrer = referrers.get(name);
      if (referrer) { keep('openSession', referrer.title); return; }
      for (const session of open) {
        const cwd = session.cwd && await realpath(session.cwd).catch(() => session.cwd);
        if (cwd && inside(cwd)) { keep('openSession', session.title); return; }
      }
      if (!cwds) { keep('processesUnknown'); return; }
      if (cwds.some(inside)) { keep('process'); return; }
      const blocker = await removalBlocker(this.git, worktree);
      if (blocker) { keep(blocker.reason, blocker.detail); return; }
      this.removing = true;
      try { await removeWorktree(this.git, worktree); }
      finally { this.removing = false; }
      Object.assign(entry, { state: 'removed', reason: undefined, detail: undefined, checkedAt: this.now() });
    } catch (error) {
      keep('failed', error instanceof Error ? error.message : String(error));
    }
  }

  /** The first open session referring to each folder name; each transcript is read once for all names it was not yet searched for. */
  private async referrers(open: Session[], names: string[]): Promise<Map<string, Session>> {
    const referrers = new Map<string, Session>();
    const live = new Set<string>();
    for (const session of open) {
      if (!session.filePath) continue;
      const key = `${session.id}\0${session.updatedAt}`;
      live.add(key);
      const known = this.mentions.get(key) ?? { searched: new Set<string>(), found: new Set<string>() };
      const missing = names.filter(name => !known.searched.has(name));
      if (missing.length) {
        for (const name of await unlessGone(transcriptMentions(session.filePath, missing), new Set<string>())) known.found.add(name);
        for (const name of missing) known.searched.add(name);
        this.mentions.set(key, known);
      }
      for (const name of names) if (known.found.has(name) && !referrers.has(name)) referrers.set(name, session);
    }
    // Revisions no open session has any more are dropped.
    for (const key of this.mentions.keys()) if (!live.has(key)) this.mentions.delete(key);
    return referrers;
  }

  private async save(sessions: Session[]): Promise<void> {
    const present = new Set(sessions.map(session => session.id));
    for (const id of Object.keys(this.saved.scanned)) if (!present.has(id)) delete this.saved.scanned[id];
    const removed = Object.entries(this.saved.worktrees).filter(([, entry]) => entry.state === 'removed').sort(([, a], [, b]) => b.checkedAt - a.checkedAt);
    for (const [path] of removed.slice(KEEP_REMOVED)) delete this.saved.worktrees[path];
    await writePrivateJson(worktreeCleanupFile(this.options.stateDir), `${JSON.stringify(this.saved)}\n`)
      .catch(error => console.error(`Worktree cleanup state was not saved: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** A transcript deleted since the index read it holds nothing; any other read failure stops the pass, to be tried again. */
async function unlessGone<T>(read: Promise<T>, empty: T): Promise<T> {
  try { return await read; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty; throw error; }
}

/** The creation lies within the call that named its folder, from its start to its result (or the longest a call may run). */
function createdBy(worktree: LinkedWorktree, creation: { start: number; end?: number }): boolean {
  const end = Math.min(creation.end ?? Infinity, creation.start + LONGEST_CALL_MS);
  return creation.start - SLACK_MS <= worktree.createdAt && worktree.createdAt <= end + SLACK_MS;
}

/**
 * Conversations by family root: a native subagent or a proven agent launch belongs to its parent's family, as on the canvas.
 * A user's fork has a parent but is its own conversation.
 */
export function groupFamilies(sessions: Session[]): Map<string, Session[]> {
  const aliases = (session: Session) => [session.id, `${session.provider}:${session.nativeId}`];
  const byAlias = new Map<string, Session>();
  for (const session of sessions) for (const alias of aliases(session)) if (!byAlias.has(alias)) byAlias.set(alias, session);
  const parentOf = (session: Session): Session | undefined => {
    if (!session.isSubagent || !session.parentId) return undefined;
    if (session.parentLink === 'exec') return byAlias.get(session.parentId);
    const parent = byAlias.get(session.parentId) ?? byAlias.get(`${session.provider}:${session.parentId}`);
    return parent && parent.provider === session.provider ? parent : undefined;
  };
  const families = new Map<string, Session[]>();
  for (const session of sessions) {
    let root = session;
    const seen = new Set<string>([session.id]);
    for (let parent = parentOf(root); parent && !seen.has(parent.id); parent = parentOf(root)) { seen.add(parent.id); root = parent; }
    const members = families.get(root.id) ?? [];
    members.push(session);
    families.set(root.id, members);
  }
  return families;
}

function busySessionIds(sessions: Session[], runs: Run[]): Set<string> {
  const active = new Set(runs.filter(run => run.status === 'running' || run.status === 'queued').map(run => run.sessionId));
  return new Set(sessions.filter(session => session.status === 'working' || session.activeProcess || session.creationPending
    || active.has(session.id) || active.has(`${session.provider}:${session.nativeId}`)).map(session => session.id));
}

async function loadCleanup(stateDir: string): Promise<Saved> {
  let saved: unknown;
  try { saved = await readPrivateJson(worktreeCleanupFile(stateDir)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Worktree cleanup state was not loaded: ${error instanceof Error ? error.message : String(error)}`);
    return { version: VERSION, scanned: {}, worktrees: {} };
  }
  const value = saved as Partial<Saved> | undefined;
  if (!value || value.version !== VERSION || typeof value.scanned !== 'object' || typeof value.worktrees !== 'object' || !value.scanned || !value.worktrees) return { version: VERSION, scanned: {}, worktrees: {} };
  return { version: VERSION, scanned: { ...value.scanned }, worktrees: { ...value.worktrees } };
}

/** What happened to the worktrees these conversations made, for the conversation's page. */
export async function worktreeCleanupFor(stateDir: string, ids: readonly string[]): Promise<WorktreeCleanup[]> {
  const saved = await loadCleanup(stateDir);
  const wanted = new Set(ids);
  return Object.entries(saved.worktrees).filter(([, entry]) => entry.state !== 'pending' && (wanted.has(entry.root) || entry.sessions.some(id => wanted.has(id))))
    .map(([path, entry]) => ({ path, state: entry.state as 'removed' | 'kept', ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.detail ? { detail: entry.detail } : {}), at: new Date(entry.checkedAt).toISOString() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
