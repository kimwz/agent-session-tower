import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { TODO_MASTER_TASK_ID, TODO_MASTERS_FOLDER, type MasterBinding } from '../../shared/master.js';
import type { Session, Snapshot } from '../../shared/types.js';
import { CALLER_CAPABILITY_HEADER } from '../runs/session-mcp.js';
import { todoMasterTaskId } from '../runs/subscription.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { LiveState } from '../tower-tools/live-state.js';
import type { ReadDatabase } from '../tower-tools/read-db.js';
import type { TowerClient } from '../tower-tools/tower-client.js';
import { writeTodoMasterGuide } from './guide.js';
import { issueDataDir } from './paths.js';
import { MasterSession } from './session.js';
import { MasterTools, type MasterScreen } from './tools.js';

const FOLLOW_MS = 5_000;
/** An issue master's follow file is cleared away this long after its session was closed (or went away). */
export const KEEP_CLOSED_MS = 30 * 24 * 60 * 60_000;
/** How often the follow files of closed issue masters are looked over. */
const SWEEP_MS = 60 * 60_000;


interface IssueMaster { taskId: string; binding: MasterBinding; session: MasterSession; tools: MasterTools }

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
  /** The main master: its session and its own turns, which belong to it and not to an issue master. */
  main: { binding(): MasterBinding | undefined; ownRun(id: string): boolean };
  followMs?: number;
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
  private readonly parents = new Map<string, string>();

  constructor(private readonly options: IssueMastersOptions) {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.options.followMs ?? FOLLOW_MS);
    this.timer.unref();
  }

  size(): number { return this.instances.size; }
  get(taskId: string): MasterSession | undefined { return this.instances.get(taskId)?.session; }
  /** A report is on its way to an issue master: a host of another build waits until it is sent. */
  busy(): boolean { return [...this.instances.values()].some(entry => entry.session.busy()); }

  /**
   * How a master knows the masters' work apart: whether a session is a master's (the main master's, or one in an issue
   * master folder), and whether a run is one of another master's turns, also after it left the snapshot. `self` is the
   * asking issue master's todo, or nothing for the main master.
   */
  masterSession(id: string): boolean {
    return id === this.options.main.binding()?.sessionId || [...this.instances.values()].some(entry => entry.binding.sessionId === id) || this.folderSessions().has(id);
  }
  masterRun(id: string, self?: string): boolean {
    return (self !== undefined && this.options.main.ownRun(id)) || [...this.instances.values()].some(entry => entry.taskId !== self && entry.session.ownRun(id));
  }

  /**
   * A tool call from an issue master's session, with its turn's reporting credential: Tower records the work it starts
   * as that turn's, and the issue master follows it. A call the host cannot place yet still goes; the master finds what
   * it started once it follows that session.
   */
  async call(taskId: string, name: string, args: Record<string, unknown>, capability: string): Promise<unknown> {
    if (!this.instances.has(taskId)) await this.refresh();
    const tools = this.instances.get(taskId)?.tools ?? (this.untracked ??= new MasterTools({ tower: this.options.tower, live: this.options.live, ...(this.options.readDb ? { readDb: this.options.readDb } : {}),
      screen: this.options.screen, started: async () => {}, delegated: () => ({ name: 'delegated', columns: ['id', 'title', 'state', 'session_id', 'node', 'created_at', 'report', 'outcome'], rows: [] }) }));
    return tools.call(name, args, { [CALLER_CAPABILITY_HEADER]: capability });
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
    const open = new Map<string, Session>();
    for (const session of snapshot.sessions) {
      if (session.closed || session.node || session.isSubagent || session.parentId || session.launchedByAgent) continue;
      const taskId = this.issueOf(session.cwd);
      if (!taskId) continue;
      const newest = open.get(taskId);
      if (!newest || Date.parse(session.createdAt) > Date.parse(newest.createdAt)) open.set(taskId, session);
    }
    for (const [taskId, entry] of [...this.instances]) {
      if (open.has(taskId) || this.closed) continue;
      this.instances.delete(taskId);
      await entry.session.retire().catch(error => console.error(`An issue master could not be let go of: ${error instanceof Error ? error.message : String(error)}`));
    }
    for (const [taskId, session] of open) {
      if (this.closed) return;
      const known = this.instances.get(taskId);
      // Only the newest session of a todo is its master; Tower hides the others.
      if (known) { if (known.binding.sessionId !== session.id) known.binding = bindingOf(session); continue; }
      await this.open(taskId, session, snapshot);
    }
    if (Date.now() - this.sweptAt >= SWEEP_MS) { this.sweptAt = Date.now(); await this.sweep(); }
  }

  private async open(taskId: string, session: Session, snapshot: Snapshot): Promise<void> {
    // Work it handed out before the host first saw it (a host just started) is still its own.
    const times = [session.createdAt, ...(snapshot.runs ?? []).filter(run => run.sessionId === session.id).map(run => run.createdAt)].map(Date.parse).filter(Number.isFinite);
    const baselineAt = times.length ? new Date(Math.min(...times) - 60_000).toISOString() : undefined;
    const entry = { taskId, binding: bindingOf(session) } as IssueMaster;
    const { tower, live, readDb, screen, followMs } = this.options;
    entry.session = new MasterSession({ stateDir: this.options.stateDir, dataDir: issueDataDir(this.options.dataDir, taskId), binding: () => entry.binding,
      folder: join(this.options.stateDir, TODO_MASTERS_FOLDER, taskId), writeGuide: folder => writeTodoMasterGuide(folder, taskId), ...(baselineAt ? { baselineAt } : {}),
      otherMaster: { session: id => this.masterSession(id), run: id => this.masterRun(id, taskId) }, tower, live, ...(followMs ? { followMs } : {}) });
    entry.tools = new MasterTools({ tower, live, ...(readDb ? { readDb } : {}), screen, started: (target, body, answer) => entry.session.started(target, body, answer), delegated: () => entry.session.delegatedTable() });
    try { await mkdir(issueDataDir(this.options.dataDir, taskId), { recursive: true, mode: 0o700 }); await entry.session.start(); }
    catch (error) {
      // best-effort: it never started; the error that stopped it is logged below.
      await entry.session.close().catch(() => {});
      console.error(`An issue master could not start following its work: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.instances.set(taskId, entry);
  }

  /**
   * The files of issue masters not followed now: one left open when its session went away while the host was not
   * running is marked closed; one closed for long enough is removed, with anything set aside beside it.
   */
  private async sweep(): Promise<void> {
    const root = issueDataDir(this.options.dataDir);
    const names = await readdir(root).catch(() => [] as string[]);
    for (const taskId of names) {
      if (this.closed) return;
      if (!TODO_MASTER_TASK_ID.test(taskId) || this.instances.has(taskId)) continue;
      const folder = join(root, taskId);
      const path = join(folder, 'follow.json');
      // best-effort: a file that cannot be read is judged by how long it has lain untouched, below.
      const saved = await readPrivateJson(path).catch(() => undefined) as Record<string, unknown> | undefined;
      const closedAt = typeof saved?.closedAt === 'string' ? Date.parse(saved.closedAt) : NaN;
      if (Number.isFinite(closedAt)) {
        if (Date.now() - closedAt >= KEEP_CLOSED_MS) await rm(folder, { recursive: true, force: true });
      } else if (saved && typeof saved === 'object' && saved.version === 1) {
        await writePrivateJson(path, JSON.stringify({ ...saved, closedAt: new Date().toISOString() }));
      } else {
        // Nothing readable to mark: how long it has lain untouched decides.
        const changed = await stat(folder).then(info => info.mtimeMs, () => Date.now());
        if (Date.now() - changed >= KEEP_CLOSED_MS) await rm(folder, { recursive: true, force: true });
      }
    }
  }

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
