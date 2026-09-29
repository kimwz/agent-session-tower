import { homedir } from 'node:os';
import { basename, join, normalize, relative, sep } from 'node:path';
import { cp, lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import type { Run, Session, WorktreeCleanup, WorktreeKeptReason } from '../../shared/types.js';
import { gitRunner, type GitRunner } from '../repositories/git.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { ignoredWork, keepable, linkedWorktree, regenerable, removalBlocker, removeWorktree, type LinkedWorktree } from './git.js';
import { namesFolder, pathArguments, processCommands, processCwds, type ProgramLine } from './process-cwds.js';
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
/** Ignored work files moved aside before a removal at most; more keeps the worktree. */
const MOST_KEPT = { bytes: 200 * 1024 * 1024, files: 20_000 };
/** A pass running longer than this no longer counts as work in flight. */
const STUCK_MS = 10 * 60_000;
/** A folder only helper runs worked in is removed once they and the conversation that made it were quiet this long. */
const HIDDEN_QUIET_MS = 30 * 60_000;
/** Folders of helper runs whose creator is looked for in one pass; each look reads transcripts. */
const HIDDEN_PER_PASS = 5;
/** Transcripts read to find who made one such folder. */
const CREATORS_READ = 8;

interface Entry {
  /** `hidden`: a folder only helper runs (hidden from the canvas) worked in, removed when their work is done. */
  kind?: 'hidden';
  root: string;
  sessions: string[];
  createdAt: number;
  state: 'pending' | 'kept' | 'removed';
  reason?: WorktreeKeptReason;
  detail?: string;
  /** Where the ignored work files went before removal. */
  archive?: string;
  checkedAt: number;
}
interface World { sessions: Session[]; families: Map<string, Session[]>; finishedRoots: Set<string>; finished: Set<string>; open: Session[] }
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
  /** Folders Tower itself is set to work in (trigger folders, pinned projects): a worktree there is in use. */
  reserved?: () => Promise<string[]>;
  git?: GitRunner;
  home?: string;
  now?: () => number;
  cwds?: () => Promise<string[] | undefined>;
  commands?: () => Promise<ProgramLine[] | undefined>;
  firstPassMs?: number;
  passMs?: number;
}

export const worktreeCleanupFile = (stateDir: string) => join(stateDir, 'worktree-cleanup.json');

/**
 * Removes the git worktrees a conversation made once its work is over: the owner closed it, or automation finished it.
 * Only worktrees its own transcript proves it created, only when no open session refers to or works in the folder (a session
 * that ran the same `git worktree add` names it), no program works in it, and nothing committed or uncommitted would be lost.
 * Files git ignores go with it. Branches are kept.
 */
export class WorktreeJanitor {
  private saved: Saved = { version: VERSION, scanned: {}, worktrees: {} };
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private runningSince = 0;
  private removal?: Promise<void>;
  private paused = false;
  private closed = false;
  private sealed = false;
  /** Per open session: the folder names looked for, those its transcript refers to, and how far it was read. */
  private readonly mentions = new Map<string, { file: string; end: number; searched: Set<string>; found: Set<string> }>();
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
  /**
   * A pass under way: a handoff or idle exit waits for a moment between passes instead of holding submissions while one
   * finishes (a removal can take minutes), and never leaves a half-deleted folder to the next worker.
   */
  inFlight(): boolean {
    // A pass stuck on an unresponsive folder (a dead network mount) never holds a handoff for long; a pause stops it
    // before any removal, and only a removal already started is always waited for.
    return this.removal !== undefined || (this.running !== undefined && !this.stopping && this.now() - this.runningSince < STUCK_MS);
  }
  private get stopping(): boolean { return this.paused || this.closed; }
  async flush(): Promise<void> {
    if (this.removal) await this.removal.catch(() => {});
    else if (this.running) {
      // Awaited on purpose (handoff, idle exit): the timer keeps the wait alive even when nothing else runs.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.running, new Promise(resolve => { timer = setTimeout(resolve, 5_000); })]);
      clearTimeout(timer);
    }
    // Once closed and flushed, the state file belongs to the next worker: a pass that was stuck writes nothing when it ends.
    if (this.closed) this.sealed = true;
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => { void this.pass().finally(() => this.schedule(this.options.passMs ?? PASS_MS)); }, ms);
    this.timer.unref?.();
  }

  /** One pass; never runs twice at once. */
  pass(): Promise<void> {
    if (this.paused || this.closed) return Promise.resolve();
    if (!this.running) this.runningSince = this.now();
    this.running ??= this.work().catch(error => { console.error(`Worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  /** Folders resolved in this pass: a session's folder is looked up once, not once per worktree. */
  private folders = new Map<string, string>();
  private async resolved(folder: string): Promise<string> {
    let real = this.folders.get(folder);
    if (real === undefined) { real = await realpath(folder).catch(() => folder); this.folders.set(folder, real); }
    return real;
  }

  /** Which conversations' work is over, as things are right now. */
  private async world(): Promise<World> {
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
    return { sessions, families, finishedRoots, finished, open: sessions.filter(session => !finished.has(session.id)) };
  }

  private async work(): Promise<void> {
    const now = this.now();
    this.folders = new Map();
    const world = await this.world();
    let changed = false;

    let budget = FAMILIES_PER_PASS;
    for (const root of world.finishedRoots) {
      const members = world.families.get(root)!;
      if (members.every(member => this.saved.scanned[member.id] === member.updatedAt)) continue;
      if (budget-- <= 0 || this.stopping) break;
      try {
        // A scan cut short by a pause is not recorded, so the next pass reads the family again.
        if (!await this.scan(root, members)) break;
        for (const member of members) this.saved.scanned[member.id] = member.updatedAt;
        changed = true;
      } catch (error) {
        // Not recorded as scanned: the next pass tries this family again.
        console.error(`Worktrees of ${root} were not checked: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const due = Object.entries(this.saved.worktrees).filter(([, entry]) => entry.state !== 'removed' && world.finishedRoots.has(entry.root)
      && (entry.state === 'pending' || now - entry.checkedAt >= RECHECK_MS));
    // Reads each open transcript once for every folder name; the checks before each removal then find them cached.
    if (due.length) await this.referrers(world.open, [...new Set(due.map(([path]) => basename(path)))], true);
    for (const [path, entry] of due) {
      if (this.stopping) break;
      await this.settle(path, entry, world);
      changed = true;
    }
    if (await this.hiddenPass(world)) changed = true;
    if (changed) await this.save(this.options.sessions());
  }

  /**
   * Folders only helper runs worked in: an agent's `codex exec` or `claude -p`, hidden from the canvas, often in a worktree
   * made just for them. Once those runs and the conversation that made the folder were quiet for a while, the folder goes,
   * with the same care as any other (changes, unpushed commits, programs, reserved folders keep it). Only a worktree a
   * conversation's transcript proves it made with `git worktree add` is ever removed this way; one made by hand never is.
   */
  private async hiddenPass(world: World): Promise<boolean> {
    const now = this.now();
    let changed = false;
    const folders = new Map<string, Session[]>();
    for (const session of world.sessions) if (hiddenRun(session) && session.cwd && !session.node) {
      const cwd = await this.resolved(session.cwd);
      folders.set(cwd, [...folders.get(cwd) ?? [], session]);
    }
    let budget = HIDDEN_PER_PASS;
    for (const cwd of folders.keys()) {
      if (this.stopping || budget <= 0) break;
      const worktree = await linkedWorktree(this.git, cwd).catch(() => undefined);
      if (!worktree) continue;
      const entry = this.saved.worktrees[worktree.path];
      if (entry && entry.createdAt === worktree.createdAt) {
        if (entry.state === 'removed' || entry.kind !== 'hidden' || (entry.state === 'kept' && now - entry.checkedAt < RECHECK_MS)) continue;
      }
      if (this.hiddenWait(worktree.path, world)) continue;
      budget--;
      const known = entry && entry.createdAt === worktree.createdAt ? entry : undefined;
      const creator = known ? known.root : await this.creatorOf(worktree, world, folders.get(cwd)!);
      if (!creator) continue;
      const record: Entry = known ?? { kind: 'hidden', root: creator, sessions: [creator], createdAt: worktree.createdAt, state: 'pending', checkedAt: 0 };
      this.saved.worktrees[worktree.path] = record;
      await this.settle(worktree.path, record, world);
      changed = true;
    }
    return changed;
  }

  /** Whether helper runs still work in the folder, or finished too recently: then it is looked at again later. */
  private hiddenWait(path: string, world: World): boolean {
    const inside = (folder: string) => folder === path || folder.startsWith(path + sep);
    const here = world.sessions.filter(session => !session.node && session.cwd && inside(this.folders.get(session.cwd) ?? session.cwd));
    if (!here.some(hiddenRun)) return true;
    const busy = busySessionIds(world.sessions, this.options.runs());
    if (here.some(session => busy.has(session.id))) return true;
    return this.now() - Math.max(...here.map(session => Date.parse(session.updatedAt) || 0)) < HIDDEN_QUIET_MS;
  }

  /** The conversation whose transcript proves it made this worktree: the helpers' own families, then conversations naming it. */
  private async creatorOf(worktree: LinkedWorktree, world: World, helpers: Session[]): Promise<string | undefined> {
    const name = basename(worktree.path);
    const rootOf = new Map<string, string>();
    for (const [root, members] of world.families) for (const member of members) rootOf.set(member.id, root);
    const families = [...new Set(helpers.map(helper => rootOf.get(helper.id) ?? helper.id))].flatMap(root => world.families.get(root) ?? []);
    await this.referrers(world.open, [name]);
    const naming = world.open.filter(session => this.mentions.get(session.id)?.found.has(name));
    const seen = new Set<string>();
    for (const session of [...families, ...naming]) {
      if (seen.has(session.id) || seen.size >= CREATORS_READ || this.stopping) continue;
      seen.add(session.id);
      if (!session.filePath) continue;
      for (const creation of await unlessGone(transcriptCreations(session.filePath, session.provider, this.home, session.cwd || undefined), [])) {
        const made = await linkedWorktree(this.git, creation.path).catch(() => undefined) ?? (creation.path.includes('/..') ? await linkedWorktree(this.git, normalize(creation.path)).catch(() => undefined) : undefined);
        if (made?.path === worktree.path && createdBy(worktree, creation)) return rootOf.get(session.id) ?? session.id;
      }
    }
    return undefined;
  }

  /**
   * For a helpers' folder, right before removal: no conversation the owner sees works in it, the helpers are done, and no
   * open conversation naming it (the one that made it included) was active in the last half hour.
   */
  private async hiddenBlocker(path: string, world: World): Promise<{ reason: WorktreeKeptReason; detail?: string } | 'wait' | undefined> {
    const inside = (folder: string) => folder === path || folder.startsWith(path + sep);
    for (const session of world.open) {
      if (session.node || hiddenRun(session) || !session.cwd) continue;
      if (inside(await this.resolved(session.cwd))) return { reason: 'openSession', detail: session.customTitle || session.title };
    }
    if (this.hiddenWait(path, world)) return 'wait';
    const name = basename(path);
    await this.referrers(world.open, [name]);
    const busy = busySessionIds(world.sessions, this.options.runs());
    for (const session of world.open) {
      if (!this.mentions.get(session.id)?.found.has(name)) continue;
      if (busy.has(session.id) || this.now() - (Date.parse(session.updatedAt) || 0) < HIDDEN_QUIET_MS) return { reason: 'openSession', detail: session.customTitle || session.title };
    }
    return undefined;
  }

  /** Records every worktree a family's transcripts prove they created and that still exists; false when cut short. */
  private async scan(root: string, members: Session[]): Promise<boolean> {
    for (const member of members) {
      if (this.stopping) return false;
      if (!member.filePath) continue;
      for (const creation of await unlessGone(transcriptCreations(member.filePath, member.provider, this.home, member.cwd || undefined), [])) {
        // Written relative to a folder that is gone since (often another worktree the agent removed), the path is read as text.
        const worktree = await linkedWorktree(this.git, creation.path) ?? (creation.path.includes('/..') ? await linkedWorktree(this.git, normalize(creation.path)) : undefined);
        if (!worktree || !createdBy(worktree, creation)) continue;
        const entry = this.saved.worktrees[worktree.path];
        if (entry && entry.createdAt === worktree.createdAt) { if (!entry.sessions.includes(member.id)) entry.sessions.push(member.id); continue; }
        this.saved.worktrees[worktree.path] = { root, sessions: [member.id], createdAt: worktree.createdAt, state: 'pending', checkedAt: 0 };
      }
    }
    return true;
  }

  private async settle(path: string, entry: Entry, world: World): Promise<void> {
    const keep = (reason: WorktreeKeptReason, detail?: string) => Object.assign(entry, { state: 'kept', reason, detail, checkedAt: this.now() });
    const named = (session: Session) => session.customTitle || session.title;
    try {
      const worktree = await linkedWorktree(this.git, path);
      // Gone, or another worktree made later at the same place: nothing of this conversation's is left there.
      if (!worktree || worktree.createdAt !== entry.createdAt) { delete this.saved.worktrees[path]; return; }
      const blocker = await removalBlocker(this.git, worktree);
      if (blocker) { keep(blocker.reason, blocker.detail); return; }
      const name = basename(worktree.path);
      const inside = (folder: string) => folder === worktree.path || folder.startsWith(worktree.path + sep);
      // Programs first: listing them is the slow part. Everything about conversations is judged after it, as things are
      // right before removing: another removal in this pass may have taken minutes, and conversations may have been
      // reopened or given work meanwhile. An open session that ran the same `git worktree add` names the folder too.
      const cwds = await (this.options.cwds ?? processCwds)();
      if (!cwds) { keep('processesUnknown'); return; }
      if (cwds.some(inside)) { keep('process'); return; }
      // A program started elsewhere may still work in it (`--directory ../preview`): its command line names the folder.
      const commands = await (this.options.commands ?? processCommands)();
      if (!commands) { keep('processesUnknown'); return; }
      if (commands.some(command => namesFolder(command.args, name))) { keep('process'); return; }
      // Or reaches it through a symlink (`--directory /w/current` → the worktree): arguments are followed to where they lead.
      for (const command of commands) for (const argument of pathArguments(command)) {
        if (inside(await this.resolved(argument))) { keep('process'); return; }
      }
      const reserved = await Promise.all((await this.options.reserved?.() ?? []).map(folder => this.resolved(folder)));
      if (reserved.some(inside)) { keep('reserved'); return; }
      // Files git ignores that no tool makes again (notes, review records, local settings) are moved to Tower's state folder
      // first; an unusually large amount of them keeps the worktree instead.
      const work = await ignoredWork(this.git, worktree.path, MOST_KEPT);
      if (work.bytes > MOST_KEPT.bytes || work.files > MOST_KEPT.files) { keep('ignoredWork', `${work.files} files`); return; }
      const hidden = entry.kind === 'hidden';
      // A helpers' folder may go while the conversation that made it is still open: its moved-aside files are never pruned,
      // and when there is no room left for them the folder stays instead.
      if (hidden && work.entries.length && await archivesSize(join(this.options.stateDir, 'worktree-files')) + work.bytes > ARCHIVES_MOST_BYTES) { keep('ignoredWork', 'archive full'); return; }
      const archive = work.entries.length ? join(this.options.stateDir, 'worktree-files', `${name}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}${hidden ? KEPT_SUFFIX : ''}`) : undefined;
      const discard = async () => { if (archive) await rm(archive, { recursive: true, force: true }); };
      // A copy that fails partway is removed, so retries never pile up copies.
      if (archive) try {
        for (const entry of work.entries) {
          await cp(join(worktree.path, entry), join(archive, entry), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true,
            filter: async source => !regenerable(relative(worktree.path, source)) && keepable(await lstat(source)) });
        }
        if (!hidden) await pruneArchives(join(this.options.stateDir, 'worktree-files'), archive);
      } catch (error) { await discard(); throw error; }
      // Conversations are judged last, and again until nothing changed while their transcripts were read (a few tries; a
      // busy moment leaves the worktree for the next pass). Nothing waits between the last look and the removal.
      const revision = (session: Session) => `${session.id}\0${session.updatedAt}\0${session.cwd}`;
      let checked = new Set<string>();
      for (let attempt = 0; ; attempt++) {
        const now = await this.world();
        if (this.stopping) { await discard(); return; }
        if (hidden && !now.finishedRoots.has(entry.root)) {
          const blocker = await this.hiddenBlocker(worktree.path, now);
          if (blocker === 'wait') { await discard(); entry.state = 'pending'; return; }
          if (blocker) { await discard(); keep(blocker.reason, blocker.detail); return; }
          break;
        }
        if (!now.finishedRoots.has(entry.root)) { await discard(); return; }
        const changed = now.open.filter(session => !checked.has(revision(session)));
        if (!changed.length) break;
        if (attempt === 3) { await discard(); return; }
        for (const session of changed) {
          const cwd = session.cwd && await this.resolved(session.cwd);
          if (cwd && inside(cwd)) { await discard(); keep('openSession', named(session)); return; }
        }
        const referrer = (await this.referrers(changed, [name])).get(name);
        if (referrer) { await discard(); keep('openSession', named(referrer)); return; }
        checked = new Set(now.open.map(revision));
      }
      this.removal = removeWorktree(this.git, worktree);
      try { await this.removal; } catch (error) { await discard(); throw error; } finally { this.removal = undefined; }
      Object.assign(entry, { state: 'removed', reason: undefined, detail: undefined, archive, checkedAt: this.now() });
    } catch (error) {
      keep('failed', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The first open session referring to each folder name. Each transcript is read once for the names it was not yet searched
   * for, and afterwards only from where the last read ended: a working session that grew meanwhile is caught up in a moment.
   */
  private async referrers(open: Session[], names: string[], forget = false): Promise<Map<string, Session>> {
    const referrers = new Map<string, Session>();
    const live = new Set<string>();
    for (const session of open) {
      if (this.stopping) break;
      if (!session.filePath) continue;
      live.add(session.id);
      let known = this.mentions.get(session.id);
      if (known?.file !== session.filePath) known = { file: session.filePath, end: 0, searched: new Set(), found: new Set() };
      const missing = names.filter(name => !known!.searched.has(name));
      const unfound = [...known.searched].filter(name => !known!.found.has(name));
      // New names are looked for from the start, together with those still not found; otherwise only what was appended.
      const search = missing.length ? [...missing, ...unfound] : unfound;
      if (search.length) {
        const result = await unlessGone(transcriptMentions(session.filePath, search, missing.length ? 0 : known.end), { found: new Set<string>(), end: 0 });
        for (const name of result.found) known.found.add(name);
        for (const name of missing) known.searched.add(name);
        known.end = result.end;
      }
      this.mentions.set(session.id, known);
      for (const name of names) if (known.found.has(name) && !referrers.has(name)) referrers.set(name, session);
    }
    // Sessions no longer open are dropped, when all open sessions were given.
    if (forget) for (const id of this.mentions.keys()) if (!live.has(id)) this.mentions.delete(id);
    return referrers;
  }

  private async save(sessions: Session[]): Promise<void> {
    // Paused for a handoff, or closed and flushed: the state file may already belong to the next worker. What this pass
    // learned is kept in memory for the next pass here, or found again by the next worker.
    if (this.sealed || this.stopping) return;
    const present = new Set(sessions.map(session => session.id));
    for (const id of Object.keys(this.saved.scanned)) if (!present.has(id)) delete this.saved.scanned[id];
    const removed = Object.entries(this.saved.worktrees).filter(([, entry]) => entry.state === 'removed').sort(([, a], [, b]) => b.checkedAt - a.checkedAt);
    for (const [path] of removed.slice(KEEP_REMOVED)) delete this.saved.worktrees[path];
    await writePrivateJson(worktreeCleanupFile(this.options.stateDir), `${JSON.stringify(this.saved)}\n`)
      .catch(error => console.error(`Worktree cleanup state was not saved: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** Moved-aside files kept at most, all worktrees together; the oldest folders go first, never the one just made. */
const ARCHIVES_MOST_BYTES = 2 * 1024 * 1024 * 1024;
const KEPT_SUFFIX = '-kept';

/** A run another agent started: hidden from the canvas, shown at most under its launcher. */
function hiddenRun(session: Session): boolean { return Boolean(session.launchedByAgent || session.parentLink === 'exec'); }

async function archivesSize(root: string): Promise<number> {
  const size = async (path: string): Promise<number> => {
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory()) return info?.size ?? 0;
    let total = 0;
    for (const name of await readdir(path).catch(() => [] as string[])) total += await size(join(path, name));
    return total;
  };
  return size(root);
}

async function pruneArchives(root: string, keep: string): Promise<void> {
  const size = async (path: string): Promise<number> => {
    const info = await lstat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of await readdir(path)) total += await size(join(path, name));
    return total;
  };
  const folders = await Promise.all((await readdir(root)).map(async name => ({ path: join(root, name), at: (await stat(join(root, name))).mtimeMs, bytes: await size(join(root, name)) })));
  // Files of a helpers' folder removed while its conversation was still open are never pruned.
  for (const folder of folders) if (folder.path.endsWith(KEPT_SUFFIX)) folder.at = Infinity;
  let total = folders.reduce((sum, folder) => sum + folder.bytes, 0);
  for (const folder of folders.sort((a, b) => a.at - b.at)) {
    if (total <= ARCHIVES_MOST_BYTES) break;
    if (folder.path === keep || folder.path.endsWith(KEPT_SUFFIX)) continue;
    await rm(folder.path, { recursive: true, force: true });
    total -= folder.bytes;
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
    .map(([path, entry]) => ({ path, state: entry.state as 'removed' | 'kept', ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.detail ? { detail: entry.detail } : {}), ...(entry.archive ? { archive: entry.archive } : {}), at: new Date(entry.checkedAt).toISOString() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
