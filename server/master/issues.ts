import { mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { TODO_MASTER_ISSUE_HEADER, TODO_MASTERS_FOLDER, type MasterBinding } from '../../shared/master.js';
import type { Session, Snapshot } from '../../shared/types.js';
import { newestIssueMaster, todoMasterTaskId } from '../runs/subscription.js';
import { clearClosedIssueFiles } from './issue-files.js';
import type { LiveState } from '../tower-tools/live-state.js';
import type { ReadDatabase } from '../tower-tools/read-db.js';
import type { TowerClient } from '../tower-tools/tower-client.js';
import { writeTodoMasterGuide } from './guide.js';
import { issueDataDir } from './paths.js';
import { MasterSession } from './session.js';
import { MasterTools, type MasterScreen } from './tools.js';

const FOLLOW_MS = 5_000;
/** How often the follow files of closed issue masters are looked over. */
const SWEEP_MS = 60 * 60_000;


/** `followed`: from its start until it is let go of; only then are its turns taken in (see `turnsOf`). */
interface IssueMaster { taskId: string; binding: MasterBinding; session: MasterSession; tools: MasterTools; followed: boolean }

export interface IssueMastersOptions {
  /** Tower's state directory as the host resolved it. */
  stateDir: string;
  /** The master host's data folder. */
  dataDir: string;
  tower: TowerClient;
  live: LiveState;
  readDb?: ReadDatabase;
  /** The owner's screen, shared with the main master. */
  screen: MasterScreen;
  /** The main master's session. */
  main: { binding(): MasterBinding | undefined };
  followMs?: number;
  /** Tests shorten the wait before a refused report goes again. */
  reportRetryMs?: number;
  /** What pages see of the issue masters changed: one was taken up or let go of, or its followed work moved. */
  onChange?(): void;
}

/**
 * The issue masters the host follows: one for each todo whose folder (`<state>/todo-masters/<taskId>`) has an open
 * session, bound to the newest such session. Each is a master of its own (server/master/session.ts) with its own
 * followed work and reports. One whose session is closed or gone is let go of; its file waits to be opened again, and
 * is cleared away a while later, so nothing piles up for todos that are done.
 */
export class IssueMasters {
  private readonly instances = new Map<string, IssueMaster>();
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private sweptAt = 0;
  private closed = false;
  /** The sessions in issue master folders, worked out once for each snapshot. */
  private folders?: { snapshot: Snapshot; ids: Set<string> };
  private untracked?: MasterTools;
  /** Every master's turns, by run: the master's todo, or '' for the main master. */
  private readonly turns = new Map<string, string>();
  /** The sessions the issue masters are bound to. */
  private bound = new Set<string>();
  private readonly parents = new Map<string, string>();

  constructor(private readonly options: IssueMastersOptions) {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.options.followMs ?? FOLLOW_MS);
    this.timer.unref();
  }

  size(): number { return this.instances.size; }
  /** Work each issue master handed out that is still running, by todo; todos with none are left out. */
  runningTasks(): Record<string, number> {
    return Object.fromEntries([...this.instances.values()].map(entry => [entry.taskId, entry.session.runningTasks()] as const).filter(([, count]) => count > 0));
  }
  get(taskId: string): MasterSession | undefined { return this.instances.get(taskId)?.session; }
  /** A report is on its way to an issue master: a host of another build waits until it is sent. */
  busy(): boolean { return [...this.instances.values()].some(entry => entry.session.busy()); }

  /**
   * How a master knows the masters' work apart: whether a session is a master's (the main master's, or one in an issue
   * master folder), and whether a run is one of another master's turns, also after it left the snapshot. `self` is the
   * asking issue master's todo, or nothing for the main master.
   */
  masterSession(id: string): boolean {
    return id === this.options.main.binding()?.sessionId || this.bound.has(id) || this.folderSessions().has(id);
  }
  masterRun(id: string, self = ''): boolean {
    const owner = this.turns.get(id);
    return owner !== undefined && owner !== self;
  }
  /**
   * Where a master tells of its own turns: `owner` is its todo, or '' for the main master. An issue master's are taken
   * in only while it is followed: one let go of may still finish a look (a report's answer arriving), and what it adds
   * then would be kept for no master.
   */
  turnsOf(owner = '', entry?: IssueMaster): { add(runId: string): void; delete(runId: string): void } {
    return { add: id => { if (!entry || entry.followed) this.turns.set(id, owner); }, delete: id => { if (this.turns.get(id) === owner) this.turns.delete(id); } };
  }

  /**
   * A tool call from an issue master's session. It goes as the main master's calls do, with the same powers, and names
   * its todo so Tower counts what it starts in that todo's family; the issue master follows that work as the main master
   * does. A call the host cannot place yet still goes, unfollowed.
   */
  async call(taskId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.instances.has(taskId)) await this.refresh();
    const tools = this.instances.get(taskId)?.tools ?? (this.untracked ??= new MasterTools({ tower: this.options.tower, live: this.options.live, ...(this.options.readDb ? { readDb: this.options.readDb } : {}),
      scope: 'untracked', screen: this.options.screen, started: async () => {}, delegated: () => ({ name: 'delegated', columns: ['id', 'title', 'state', 'session_id', 'node', 'created_at', 'report', 'outcome'], rows: [] }) }));
    return tools.call(name, args, { [TODO_MASTER_ISSUE_HEADER]: taskId });
  }

  /** One look at Tower's sessions: issue masters to follow, to let go of, and old files to clear away. */
  refresh(): Promise<void> {
    return this.refreshing ??= this.refreshOnce().catch(error => {
      console.error(`Issue masters could not be looked over: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.refreshing = undefined; });
  }

  private async refreshOnce(): Promise<void> {
    if (this.closed || !this.options.tower.hasCredentials()) return;
    const snapshot = await this.options.live.fresh();
    // While Tower is still reading sessions, one missing from it may only not be read yet.
    if (!snapshot || snapshot.scanning) return;
    // Each todo's master is chosen by the rule the web uses (`newestIssueMaster`), among its open sessions; a folder
    // named through a link is given as the state directory names it.
    const folders = new Map<string, Session[]>();
    for (const session of snapshot.sessions) {
      const taskId = session.closed ? undefined : this.issueOf(session.cwd);
      if (taskId) folders.set(taskId, [...folders.get(taskId) ?? [], { ...session, cwd: join(this.options.stateDir, TODO_MASTERS_FOLDER, taskId) }]);
    }
    const open = new Map<string, Session>();
    for (const [taskId, sessions] of folders) {
      const master = newestIssueMaster(this.options.stateDir, taskId, sessions);
      if (master) open.set(taskId, master);
    }
    for (const [taskId, entry] of [...this.instances]) {
      if (open.has(taskId) || this.closed) continue;
      this.forget(entry);
      await entry.session.retire().catch(error => console.error(`An issue master could not be let go of: ${error instanceof Error ? error.message : String(error)}`));
    }
    for (const [taskId, session] of open) {
      if (this.closed) return;
      const known = this.instances.get(taskId);
      // Only the newest session of a todo is its master; the web hands the others to retention.
      if (known) { if (known.binding.sessionId !== session.id) { known.binding = bindingOf(session); this.rebind(); } continue; }
      await this.open(taskId, session, snapshot);
    }
    if (Date.now() - this.sweptAt >= SWEEP_MS) {
      this.sweptAt = Date.now();
      await clearClosedIssueFiles(this.options.dataDir, { following: taskId => this.instances.has(taskId), markOpen: true, guides: taskId => join(this.options.stateDir, TODO_MASTERS_FOLDER, taskId) });
    }
  }

  private async open(taskId: string, session: Session, snapshot: Snapshot): Promise<void> {
    // Work it handed out before the host first saw it (a host just started) is still its own.
    const times = [session.createdAt, ...(snapshot.runs ?? []).filter(run => run.sessionId === session.id).map(run => run.createdAt)].map(Date.parse).filter(Number.isFinite);
    const baselineAt = times.length ? new Date(Math.min(...times) - 60_000).toISOString() : undefined;
    const entry = { taskId, binding: bindingOf(session), followed: true } as IssueMaster;
    const { tower, live, readDb, screen, followMs, reportRetryMs } = this.options;
    entry.session = new MasterSession({ stateDir: this.options.stateDir, dataDir: issueDataDir(this.options.dataDir, taskId), binding: () => entry.binding,
      folder: join(this.options.stateDir, TODO_MASTERS_FOLDER, taskId), writeGuide: folder => writeTodoMasterGuide(folder, taskId), ...(baselineAt ? { baselineAt } : {}),
      otherMaster: { session: id => this.masterSession(id), run: id => this.masterRun(id, taskId) }, turns: this.turnsOf(taskId, entry), tower, live, ...(followMs ? { followMs } : {}), ...(reportRetryMs ? { reportRetryMs } : {}),
      onChange: () => { if (entry.followed) this.options.onChange?.(); } });
    entry.tools = new MasterTools({ tower, live, ...(readDb ? { readDb } : {}), scope: `todo:${taskId}`, screen, started: (target, body, answer) => entry.session.started(target, body, answer), delegated: () => entry.session.delegatedTable() });
    try { await mkdir(issueDataDir(this.options.dataDir, taskId), { recursive: true, mode: 0o700 }); await entry.session.start(); }
    catch (error) {
      entry.followed = false;
      // best-effort: it never started; the error that stopped it is logged below.
      await entry.session.close().catch(() => {});
      for (const id of entry.session.ownRuns()) this.turnsOf(taskId).delete(id);
      console.error(`An issue master could not start following its work: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.instances.set(taskId, entry);
    this.rebind();
    this.options.onChange?.();
  }

  /**
   * An issue master let go of: its turns are forgotten here, so the map holds only masters followed now. Work other
   * masters sent it keeps its boundary through their own follow files (`Followed.master`).
   */
  private forget(entry: IssueMaster): void {
    entry.followed = false;
    this.instances.delete(entry.taskId);
    for (const id of entry.session.ownRuns()) this.turnsOf(entry.taskId).delete(id);
    this.rebind();
    this.options.onChange?.();
  }
  private rebind(): void { this.bound = new Set([...this.instances.values()].map(entry => entry.binding.sessionId)); }

  /** The sessions in issue master folders, closed ones too: their work is theirs while they exist. */
  private folderSessions(): Set<string> {
    const snapshot = this.options.live.snapshot();
    if (!snapshot) return new Set();
    if (this.folders?.snapshot !== snapshot) {
      this.folders = { snapshot, ids: new Set(snapshot.sessions.filter(session => !session.node && this.issueOf(session.cwd)).map(session => session.id)) };
    }
    return this.folders.ids;
  }

  /**
   * The todo whose issue master folder a session runs in. The host knows Tower's state directory with links followed,
   * and the web may have named the folder through a link: such a folder's parent is looked up once.
   */
  private issueOf(cwd: string): string | undefined {
    const direct = todoMasterTaskId(this.options.stateDir, cwd);
    if (direct || !cwd.includes(`/${TODO_MASTERS_FOLDER}/`)) return direct;
    const parent = dirname(cwd);
    let real = this.parents.get(parent);
    if (real === undefined) {
      // Not made yet (the web makes it before the session), the folder above it is looked up instead.
      try { real = realpathSync(parent); } catch { try { real = join(realpathSync(dirname(parent)), basename(parent)); } catch { real = ''; } }
      if (this.parents.size >= 100) this.parents.clear();
      this.parents.set(parent, real);
    }
    return real ? todoMasterTaskId(this.options.stateDir, join(real, basename(cwd))) : undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.refreshing;
    await Promise.all([...this.instances.values()].map(entry => entry.session.close()));
  }
}

function bindingOf(session: Session): MasterBinding {
  return { sessionId: session.id, provider: session.provider, startedAt: session.createdAt };
}
