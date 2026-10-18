import { join } from 'node:path';
import { TODO_MASTERS_FOLDER } from '../../shared/master.js';
import type { ResolvedModel } from '../../shared/models.js';
import { TowerError } from '../../shared/errors.js';
import type { TodoAgent, TodoOverview, TodoTaskDetail } from '../../shared/todo/types.js';
import type { AutoPromptJob, CreateSessionRequest, Run, Session } from '../../shared/types.js';
import { MAX_PROMPT } from '../runs/run-records.js';
import { issueMasterCandidates, newestIssueMaster, todoMasterTaskId } from '../runs/subscription.js';
import { todoFilePath } from './files.js';
import type { TodoStore } from './store.js';

/**
 * Issue masters: a master of its own for one todo, started by the owner's first message in the todo's chat
 * (shared/master.ts). The store keeps one row per todo and the sessions each master started (its family); this module
 * brings sessions in line with the todos, in one queue for the whole web process:
 *
 * - a todo closed for good (completed, or deleted) closes its master: the master, every session in its folder and its
 *   family are handed to retention, which moves them to compressed storage once their work is over. Nothing is hidden
 *   or stopped: work they were given goes on to its end, and only then do they leave;
 * - a todo opened again takes its master back from retention (from compressed storage too); the rest stay handed over;
 * - a start whose answer was lost is found by its folder, or given up after a while so the owner can start again.
 *
 * Each pass reads the rows again and changes one only while it is as it was read (TodoStore.changeAgent), so a todo
 * reopened while its master is being closed, a request sent twice, a restored backup or an older build's writes all
 * end where the todos say. Stopping the web stops none of this halfway for good: the next pass picks it up.
 */

/** How long a start may go unanswered, and a lost master unfound, before its row goes and the owner can start again. */
export const TODO_AGENT_START_WAIT_MS = 2 * 60_000;
/** Passes come this often, and a failed close or reopen of one todo waits this long before it is tried again. */
const PASS_MS = 60_000;
/**
 * Every master is compared with its todo this often (and at start, and after a restore). Between, a change compares
 * the todos it touched and a pass the masters not closed, so closed ones cost nothing while their todos stay closed.
 */
const FULL_CHECK_MS = 60 * 60_000;
const TITLE_CHARS = 60;
const COMMENTS = 20;
const LIST_ITEMS = 50;
/** The most session ids one hand-over to retention takes (the worker refuses more). */
const HAND_OVER_CHUNK = 500;
const LINE_CHARS = 300;

/** What a pass needs to know of a session, as pages see it (closed ones included). */
export type AgentSession = Pick<Session, 'id' | 'cwd' | 'provider' | 'status' | 'closed' | 'activeProcess' | 'scheduledAt' | 'creationPending' | 'createdAt' | 'isSubagent' | 'parentId' | 'launchedByAgent' | 'node'>;

export interface TodoAgentsOptions {
  stateDir: string;
  store: Pick<TodoStore, 'availability' | 'agentsToSettle' | 'agent' | 'taskState' | 'settleAgents' | 'changeAgent' | 'familyOf' | 'familyTask' | 'addFamily' | 'removeFamily' | 'detail' | 'overview'>;
  /** This computer's sessions; undefined while they cannot be known (no worker, sessions unavailable). */
  sessions(): AgentSession[] | undefined;
  run(id: string): Pick<Run, 'sessionId'> | undefined;
  /** This computer's Auto Prompt jobs, as the snapshot lists them: a job an issue master sent may make a new session. */
  jobs?(): readonly Pick<AutoPromptJob, 'id' | 'sessionId' | 'decision' | 'delegation'>[] | undefined;
  /**
   * Shows a session as the owner's reopen does: brings it back from compressed storage and takes back its hand-over
   * to retention. Undefined when there is no such session.
   */
  reopen(id: string): Promise<unknown>;
  /** Hands sessions to retention, which moves them (and their sub-agents) to compressed storage once idle. */
  requestArchive(ids: string[]): Promise<unknown>;
  /** Starts a session as the owner. */
  createSession(input: CreateSessionRequest): Promise<{ session: Pick<Session, 'id' | 'provider'> }>;
  /** Whether a failed start may have made the session after all. */
  uncertain(error: unknown): boolean;
  model(): Promise<ResolvedModel>;
  writeGuide(folder: string, taskId: string): Promise<void>;
  /** Takes the guide away again (and the folder, if nothing else is in it): for a start that came to nothing. */
  removeGuide(folder: string): Promise<void>;
  /** Makes the master host run, which follows issue masters' work. */
  startHost(): Promise<unknown>;
  /** The rows changed: pages load the todos again. */
  onChange(): void;
  now?: () => number;
}

export const todoMasterFolder = (stateDir: string, taskId: string) => join(stateDir, TODO_MASTERS_FOLDER, taskId);

/** A session still at work, or about to be: its family record stays until it is not. */
const busy = (session: AgentSession) => session.status === 'working' || Boolean(session.activeProcess || session.scheduledAt || session.creationPending);

export class TodoAgents {
  private tail: Promise<void> = Promise.resolve();
  private waiting?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  /** Todos whose start this process still waits on: passes leave them to it. */
  private readonly starting = new Set<string>();
  /** Sessions this process handed to retention; after a restart they are handed again once, which changes nothing. */
  private readonly handed = new Set<string>();
  /** Auto Prompt jobs an issue master sent through the master's own calls, by job: the todo they work for. */
  private readonly issueJobs = new Map<string, string>();
  /** Jobs already looked at for a new session: each is adopted once. */
  private readonly adopted = new Set<string>();
  /**
   * Todos whose master this process has taken back from retention since the master last (re)opened. Once per process
   * and per reopening, so a hand-over left from before a restart never outlives an open todo.
   */
  private readonly confirmed = new Set<string>();
  /** When closing or reopening a todo's master last failed. */
  private readonly failed = new Map<string, number>();
  /** When every master was last compared with its todo; 0 asks the next pass to. */
  private fullCheckAt = 0;

  constructor(private readonly options: TodoAgentsOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** A pass now and every minute. */
  start(): void {
    void this.schedule();
    this.timer = setInterval(() => void this.schedule(), PASS_MS);
    this.timer.unref();
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * After a change of todos: moves the masters of the todos it touched (`taskIds`) that it opened or closed at once, so
   * the answer carries them (TodoChanges.agents), and leaves the sessions to a pass.
   */
  settle(taskIds: readonly string[]): Record<string, TodoAgent | null> {
    let moved: Record<string, TodoAgent | null> = {};
    try { if (this.options.store.availability().state === 'ready') moved = this.options.store.settleAgents(taskIds); }
    catch (error) { console.error(`Issue masters were not brought in line with the todos: ${message(error)}`); }
    for (const taskId of Object.keys(moved)) this.confirmed.delete(taskId);
    void this.schedule();
    return moved;
  }

  /** After the todos were replaced wholesale (a restored backup): the next pass compares every master with its todo. */
  recheckAll(): Promise<void> {
    this.fullCheckAt = 0;
    return this.schedule();
  }

  /** A pass after the one running; asked for again before it begins, it is the same pass. */
  schedule(): Promise<void> {
    if (this.waiting) return this.waiting;
    const pass = this.tail.then(() => { this.waiting = undefined; return this.pass(); })
      .catch(error => console.error(`Issue masters could not be brought in line with the todos: ${message(error)}`));
    this.waiting = pass;
    this.tail = pass;
    return pass;
  }

  /**
   * Starts a todo's issue master with the owner's first message, the todo's contents after it. A refused start leaves
   * nothing behind; one whose answer was lost stays `starting` until a pass finds its session in the folder.
   */
  async begin(taskId: string, text: string): Promise<TodoAgent> {
    const store = this.options.store;
    const where = store.taskState(taskId);
    if (where === 'gone') throw new TowerError('not-found', '할 일을 찾을 수 없습니다.');
    if (where !== 'open') throw new TowerError('conflict', '닫힌 할 일에는 이슈 마스터를 시작할 수 없습니다. 할 일을 다시 연 뒤 보내세요.');
    if (store.agent(taskId)) throw new TowerError('conflict', '이 할 일에는 이미 이슈 마스터가 있습니다.');
    const model = await this.options.model();
    const detail = store.detail(taskId);
    const prompt = todoAgentPrompt(text, detail, store.overview(), sha256 => todoFilePath(this.options.stateDir, sha256));
    if (!store.changeAgent(taskId, null, { state: 'starting', provider: model.provider })) throw new TowerError('conflict', '이 할 일에는 이미 이슈 마스터가 있습니다.');
    this.starting.add(taskId);
    this.options.onChange();
    try {
      const folder = todoMasterFolder(this.options.stateDir, taskId);
      let created: { session: Pick<Session, 'id' | 'provider'> };
      try {
        await this.options.writeGuide(folder, taskId);
        created = await this.options.createSession({ provider: model.provider, ...(model.model ? { model: model.model } : {}), ...(model.effort ? { effort: model.effort } : {}),
          cwd: folder, prompt, title: `이슈: ${detail.task.content.slice(0, TITLE_CHARS)}` });
      } catch (error) {
        if (!this.options.uncertain(error)) await this.giveUp(taskId);
        throw error;
      }
      const agent = this.bind(taskId, created.session);
      void this.options.startHost().catch(error => console.error(`The master host did not start for an issue master: ${message(error)}`));
      return agent;
    } finally {
      this.starting.delete(taskId);
      void this.schedule();
    }
  }

  /** Records the session a start made: the master runs, or, if its todo closed meanwhile, is closed with the rest. */
  private bind(taskId: string, session: Pick<Session, 'id' | 'provider'>): TodoAgent {
    const store = this.options.store;
    // Passes leave a starting todo alone, so the row is still `starting`, or `closing` if the todo closed meanwhile.
    const agent = store.agent(taskId);
    const state = agent?.state === 'starting' && store.taskState(taskId) === 'open' ? 'active' : 'closing';
    if (store.changeAgent(taskId, agent ? { state: agent.state, sessionId: agent.sessionId } : null, { state, sessionId: session.id, provider: session.provider })) {
      // A session just made has nothing to take back from retention.
      if (state === 'active') this.confirmed.add(taskId);
      this.options.onChange();
    }
    return store.agent(taskId)!;
  }

  /**
   * Records a session another one made (POST /api/sessions with the calling turn's capability) in an issue master's
   * family when the calling session is that master or already in its family. One made for a closed issue is handed over
   * by the next pass.
   */
  recordFamily(run: Pick<Run, 'sessionId' | 'delegation'>): void {
    const delegation = run.delegation;
    if (!delegation) return;
    try {
      const parent = this.options.run(delegation.parentRunId) ?? this.options.run(delegation.rootRunId);
      if (!parent || parent.sessionId === run.sessionId) return;
      const store = this.options.store;
      const cwd = this.options.sessions()?.find(session => session.id === parent.sessionId)?.cwd;
      const taskId = (cwd ? todoMasterTaskId(this.options.stateDir, cwd) : undefined) ?? store.familyTask(parent.sessionId);
      const agent = taskId ? store.agent(taskId) : undefined;
      if (!taskId || !agent) return;
      store.addFamily(run.sessionId, taskId);
      this.options.onChange();
      if (agent.state === 'closing' || agent.state === 'closed') void this.schedule();
    } catch (error) { console.error(`A session an issue master started was not recorded: ${message(error)}`); }
  }

  /**
   * Remembers an Auto Prompt job an issue master sent with the master's own calls (they name the todo, see
   * TODO_MASTER_ISSUE_HEADER): a new session it makes joins the todo's family (`adoptJobs`).
   */
  recordIssueJob(taskId: string, jobId: string): void {
    if (this.options.store.agent(taskId)) { this.issueJobs.set(jobId, taskId); void this.schedule(); }
  }

  /**
   * Sessions Auto Prompt jobs made for an issue master join its family, as sessions it makes itself do: jobs it sent
   * with the master's calls (`recordIssueJob`), and jobs its turns or its family's sent with their Tower tools (their
   * delegation names the calling turn). A job that continued an existing session leaves that session alone: the issue
   * master used it but did not make it.
   */
  private adoptJobs(): void {
    const jobs = this.options.jobs?.();
    if (!jobs) return;
    const listed = new Set(jobs.map(job => job.id));
    for (const id of this.adopted) if (!listed.has(id)) this.adopted.delete(id);
    for (const id of this.issueJobs.keys()) if (!listed.has(id)) this.issueJobs.delete(id);
    const store = this.options.store;
    for (const job of jobs) {
      if (this.adopted.has(job.id) || !job.sessionId || job.decision?.action !== 'create') continue;
      this.adopted.add(job.id);
      const named = this.issueJobs.get(job.id);
      this.issueJobs.delete(job.id);
      let taskId = named;
      if (!taskId && job.delegation) {
        const parent = this.options.run(job.delegation.parentRunId) ?? this.options.run(job.delegation.rootRunId);
        const cwd = parent ? this.options.sessions()?.find(session => session.id === parent.sessionId)?.cwd : undefined;
        taskId = (cwd ? todoMasterTaskId(this.options.stateDir, cwd) : undefined) ?? (parent ? store.familyTask(parent.sessionId) : undefined);
      }
      if (!taskId || !store.agent(taskId) || store.familyTask(job.sessionId)) continue;
      store.addFamily(job.sessionId, taskId);
      this.options.onChange();
    }
  }

  /**
   * Records a session an issue master made itself (its calls carry the todo, see TODO_MASTER_ISSUE_HEADER) in that
   * todo's family; one made for a closed issue is handed over by the next pass.
   */
  recordIssueSession(taskId: string, sessionId: string): void {
    try {
      const store = this.options.store;
      const agent = store.agent(taskId);
      if (!agent) return;
      store.addFamily(sessionId, taskId);
      this.options.onChange();
      if (agent.state === 'closing' || agent.state === 'closed') void this.schedule();
    } catch (error) { console.error(`A session an issue master started was not recorded: ${message(error)}`); }
  }

  /**
   * One pass. Its cost follows the issues still at work: the rows read are those not closed or with a family left,
   * plus those of folders that still list sessions, and the folders are grouped once.
   */
  private async pass(): Promise<void> {
    const store = this.options.store;
    // A todo file this build may not change (or cannot open) is left as it is until one that may does.
    const sessions = this.options.sessions();
    if (this.stopped || !sessions || store.availability().state !== 'ready') return;
    try { this.adoptJobs(); } catch (error) { console.error(`Sessions Auto Prompt made for issue masters were not recorded: ${message(error)}`); }
    const full = this.now() - this.fullCheckAt >= FULL_CHECK_MS;
    const moved = store.settleAgents(full ? 'all' : 'open');
    if (full) this.fullCheckAt = this.now();
    for (const taskId of Object.keys(moved)) this.confirmed.delete(taskId);
    if (Object.keys(moved).length) this.options.onChange();
    const byId = new Map(sessions.map(session => [session.id, session]));
    const folders = this.folders(sessions);
    const agents = store.agentsToSettle();
    const known = new Set(agents.map(agent => agent.taskId));
    for (const taskId of folders.keys()) {
      if (known.has(taskId)) continue;
      const agent = store.agent(taskId);
      if (agent) { agents.push(agent); known.add(taskId); }
    }
    // What this process remembers stays as small as what is still listed: moved sessions and old failures go.
    for (const id of this.handed) if (!byId.has(id)) this.handed.delete(id);
    for (const [taskId, at] of this.failed) if (this.now() - at >= PASS_MS || !known.has(taskId)) this.failed.delete(taskId);
    for (const taskId of this.confirmed) if (!agents.some(agent => agent.taskId === taskId && agent.state === 'active')) this.confirmed.delete(taskId);
    for (const agent of agents) {
      if (this.stopped) return;
      try {
        const folder = folders.get(agent.taskId) ?? [];
        if (agent.state === 'starting') await this.recover(agent, folder);
        else if (agent.state === 'active') await this.keep(agent, folder, byId);
        else if (agent.state === 'closing') await this.closeAgent(agent, folder, byId);
        else await this.tidy(agent, folder, byId);
      } catch (error) {
        this.failed.set(agent.taskId, this.now());
        console.error(`The issue master of todo ${agent.taskId} could not be brought in line: ${message(error)}`);
      }
    }
    // Sessions in the folder of a todo with no master (a start given up on whose session came late) are handed over.
    for (const [taskId, folder] of folders) {
      if (this.stopped || known.has(taskId) || this.starting.has(taskId)) continue;
      try { await this.handOver(folder.map(session => session.id), byId); }
      catch (error) { console.error(`Sessions left in the folder of todo ${taskId} were not handed over: ${message(error)}`); }
    }
  }

  /** Each todo's issue-master folder sessions that can be its master (issueMasterCandidates), grouped once a pass. */
  private folders(sessions: AgentSession[]): Map<string, AgentSession[]> {
    const groups = new Map<string, AgentSession[]>();
    for (const session of sessions) {
      const taskId = todoMasterTaskId(this.options.stateDir, session.cwd);
      if (taskId) groups.set(taskId, [...groups.get(taskId) ?? [], session]);
    }
    for (const [taskId, group] of groups) {
      const candidates = issueMasterCandidates(this.options.stateDir, taskId, group);
      if (candidates.length) groups.set(taskId, candidates); else groups.delete(taskId);
    }
    return groups;
  }

  /** Everything of a todo's issue master: its session, every session in its folder, and its recorded family. */
  private members(agent: TodoAgent, folder: AgentSession[], family = this.options.store.familyOf(agent.taskId)): string[] {
    return [...new Set([...agent.sessionId ? [agent.sessionId] : [], ...folder.map(session => session.id), ...family.map(member => member.sessionId)])];
  }

  private waitingAfterFailure(taskId: string): boolean {
    const at = this.failed.get(taskId);
    return at !== undefined && this.now() - at < PASS_MS;
  }

  /** A start whose answer was lost: the newest session in the folder is its master; none after a while, and it goes. */
  private async recover(agent: TodoAgent, folder: AgentSession[]): Promise<void> {
    if (this.starting.has(agent.taskId)) return;
    const found = newestIssueMaster(this.options.stateDir, agent.taskId, folder.filter(session => !session.closed));
    const store = this.options.store;
    if (found) {
      if (!store.changeAgent(agent.taskId, agent, { state: 'active', sessionId: found.id, provider: found.provider })) return;
      this.confirmed.add(agent.taskId);
      this.options.onChange();
    } else if (this.now() - Date.parse(agent.createdAt) > TODO_AGENT_START_WAIT_MS && store.changeAgent(agent.taskId, agent, null)) {
      this.options.onChange();
      await this.forgetFolder(agent.taskId);
    }
  }

  /**
   * A start that came to nothing: its row goes, whatever its todo did meanwhile (a todo closed while it started
   * leaves it `closing`), as long as no session was ever bound to it; and its guide goes with it.
   */
  private async giveUp(taskId: string): Promise<void> {
    const agent = this.options.store.agent(taskId);
    if (!agent || agent.sessionId || !this.options.store.changeAgent(taskId, { state: agent.state, sessionId: undefined }, null)) return;
    this.options.onChange();
    await this.forgetFolder(taskId);
  }

  /** A start that came to nothing leaves no guide behind: only Tower's own files go, and the folder if then empty. */
  private async forgetFolder(taskId: string): Promise<void> {
    try { await this.options.removeGuide(todoMasterFolder(this.options.stateDir, taskId)); }
    catch (error) { console.error(`The guide of a start that came to nothing for todo ${taskId} was not removed: ${message(error)}`); }
  }

  /**
   * An open todo's master: taken back from retention once (a reopened todo's, or one handed over before a restart),
   * which also brings it back from compressed storage; the newest session in its folder (a compaction's, a late
   * start's) is the master, and any other is handed over.
   */
  private async keep(agent: TodoAgent, folder: AgentSession[], byId: Map<string, AgentSession>): Promise<void> {
    const store = this.options.store;
    const bound = agent.sessionId ? byId.get(agent.sessionId) : undefined;
    if (!bound || bound.closed || !this.confirmed.has(agent.taskId)) {
      if (!agent.sessionId || this.waitingAfterFailure(agent.taskId)) return;
      // Its folder may be gone (the master host removes a closed issue's files after a while), and a turn needs it.
      await this.options.writeGuide(todoMasterFolder(this.options.stateDir, agent.taskId), agent.taskId);
      if (await this.options.reopen(agent.sessionId)) {
        this.handed.delete(agent.sessionId);
        this.confirmed.add(agent.taskId);
        if (bound && !bound.closed) return this.keep(agent, folder, byId);
        return;
      }
      // Its session is nowhere, even in compressed storage: the owner can start a new master.
      if (this.now() - Date.parse(agent.updatedAt) > TODO_AGENT_START_WAIT_MS && store.changeAgent(agent.taskId, agent, null)) {
        console.warn(`The issue master session of todo ${agent.taskId} is gone; the todo can start a new one.`);
        this.options.onChange();
      }
      return;
    }
    const open = folder.filter(session => !session.closed && !session.creationPending && !this.handed.has(session.id));
    const master = newestIssueMaster(this.options.stateDir, agent.taskId, open) ?? bound;
    if (master.id !== bound.id && store.changeAgent(agent.taskId, agent, { state: 'active', sessionId: master.id, provider: master.provider })) {
      this.confirmed.delete(agent.taskId);
      this.options.onChange();
    }
    const extra = open.filter(session => session.id !== master.id).map(session => session.id);
    if (extra.length && !this.waitingAfterFailure(agent.taskId)) await this.handOver(extra, byId);
  }

  /** A closed todo's master: it, its folder and its family are handed to retention, then it is `closed`. */
  private async closeAgent(agent: TodoAgent, folder: AgentSession[], byId: Map<string, AgentSession>): Promise<void> {
    if (this.starting.has(agent.taskId) || this.waitingAfterFailure(agent.taskId)) return;
    const store = this.options.store;
    // Closed while its start went unanswered: a session that turns up in the folder is closed with the rest; none for a
    // while, and the start came to nothing.
    if (!agent.sessionId && !folder.length) {
      if (this.now() - Date.parse(agent.createdAt) > TODO_AGENT_START_WAIT_MS) await this.giveUp(agent.taskId);
      return;
    }
    await this.handOver(this.members(agent, folder), byId);
    // Only if nothing reopened the todo or rebound its master meanwhile.
    if (store.taskState(agent.taskId) !== 'open' && store.changeAgent(agent.taskId, agent, { state: 'closed', sessionId: agent.sessionId, provider: agent.provider })) this.options.onChange();
  }

  /**
   * A closed master: whatever of it shows up since (a late start in its folder, a session its family started) is
   * handed over too. Once all of it is handed over and none of it can lose work, the family record goes, since nothing
   * of a master whose work is over starts new sessions. One the owner reopened by hand is left to ordinary retention.
   */
  private async tidy(agent: TodoAgent, folder: AgentSession[], byId: Map<string, AgentSession>): Promise<void> {
    const store = this.options.store;
    const family = store.familyOf(agent.taskId);
    const loose = this.members(agent, folder, family).filter(id => byId.has(id) && !this.handed.has(id));
    if (loose.length) {
      if (!this.waitingAfterFailure(agent.taskId)) await this.handOver(loose, byId);
      return;
    }
    if (!family.length) return;
    // Decided on the sessions and records as they are now, not as this pass began: others may have been added since.
    const fresh = this.options.sessions();
    const now = new Map((fresh ?? []).map(session => [session.id, session]));
    const current = store.familyOf(agent.taskId);
    if (!fresh || !current.length) return;
    // One recorded but not listed yet would look moved away; it is waited for.
    if (current.some(member => !now.has(member.sessionId) && this.now() - Date.parse(member.createdAt) < TODO_AGENT_START_WAIT_MS)) return;
    const unsettled = (id: string) => { const session = now.get(id); return session !== undefined && (busy(session) || !this.handed.has(id)); };
    if (this.members(agent, this.folders(fresh).get(agent.taskId) ?? [], current).some(unsettled)) return;
    store.removeFamily(agent.taskId);
    this.options.onChange();
  }

  /** Hands listed sessions to retention, once each and at most 500 at a time; ones already moved away need nothing. */
  private async handOver(ids: string[], byId: Map<string, AgentSession>): Promise<void> {
    const unhanded = ids.filter(id => byId.has(id) && !this.handed.has(id));
    for (let at = 0; at < unhanded.length; at += HAND_OVER_CHUNK) {
      const chunk = unhanded.slice(at, at + HAND_OVER_CHUNK);
      await this.options.requestArchive(chunk);
      for (const id of chunk) this.handed.add(id);
    }
  }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const clip = (text: string, chars: number) => text.length > chars ? `${text.slice(0, chars)}…` : text;
const oneLine = (text: string) => clip(text.replace(/\s+/g, ' ').trim(), LINE_CHARS);
const indent = (text: string) => text.split('\n').map(line => `  ${line}`).join('\n');
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const MARK = '--- 이 할 일의 내용 (Tower가 붙인 참고 데이터) ---';
const CUT = '(길어서 일부를 줄였습니다. todos_get으로 전체를 읽으세요.)';

/**
 * The first message of an issue master: the owner's text, then the todo as data (what it is, sub-tasks, recent
 * comments, attachments at their local paths), within the prompt limit. When it does not fit, the description and
 * the oldest comments are cut first and the master is told to read the rest itself.
 */
export function todoAgentPrompt(text: string, detail: Pick<TodoTaskDetail, 'task' | 'subtasks' | 'comments' | 'files'>,
  names: Pick<TodoOverview, 'projects' | 'sections' | 'labels'>, filePath: (sha256: string) => string, limit = MAX_PROMPT): string {
  const { task } = detail;
  const project = names.projects.find(item => item.id === task.projectId);
  const section = task.sectionId ? names.sections.find(item => item.id === task.sectionId) : undefined;
  const labels = task.labelIds.map(id => names.labels.find(label => label.id === id)?.name).filter(Boolean);
  const when = [task.dueDate && `날짜: ${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ''}${task.durationMin ? ` (${task.durationMin}분)` : ''}`,
    task.recurrence && `반복: ${JSON.stringify(task.recurrence)}`, task.deadlineDate && `마감: ${task.deadlineDate}`,
    task.priority < 4 && `우선순위: P${task.priority}`, labels.length && `라벨: ${labels.join(', ')}`].filter(Boolean);
  const head = [MARK, `할 일 id: ${task.id}`, `제목: ${oneLine(task.content)}`,
    `프로젝트: ${project ? project.inbox ? 'Inbox' : oneLine(project.name) : task.projectId}${section ? ` / 섹션: ${oneLine(section.name)}` : ''}`,
    ...when.length ? [when.join(' · ')] : []];
  const subtasks = detail.subtasks.slice(0, LIST_ITEMS).map(item => `- [${item.completedAt ? 'x' : ' '}] ${oneLine(item.content)}`);
  if (detail.subtasks.length > LIST_ITEMS) subtasks.push(`- … 외 ${detail.subtasks.length - LIST_ITEMS}개`);
  // Every attachment, always: the master reads them from these paths before it starts.
  const files = detail.files.map(file => `- ${oneLine(file.name)} (${size(file.size)}${file.commentId ? ', 댓글 첨부' : ''}): ${file.missing ? '이 컴퓨터에 없음' : filePath(file.sha256)}`);
  const comments = detail.comments.slice(-COMMENTS);
  const read = '시작하기 전에 첨부 파일(이미지·문서)을 먼저 읽으세요.';
  const compose = (description: string, listed: string[], kept: { at: string; body: string }[], cut: boolean) => [
    text, '', ...head,
    ...description ? ['설명:', description] : [],
    ...listed.length ? ['하위 작업:', ...listed] : [],
    ...kept.length ? [`최근 댓글 (${detail.comments.length}개 중 ${kept.length}개, 오래된 것부터):`, ...kept.map(comment => `- ${comment.at}\n${indent(comment.body)}`)] : [],
    ...files.length ? ['첨부 파일:', ...files, read] : [],
    ...cut ? [CUT] : [],
  ].join('\n');
  const all = comments.map(comment => ({ at: comment.createdAt, body: comment.body }));
  const whole = compose(task.description, subtasks, all, false);
  if (whole.length <= limit) return whole;
  // What the master needs before anything else (what the todo is, where its files are) always goes in; a first
  // message that leaves no room for it is refused rather than either being cut.
  const least = compose('', [], [], true);
  if (least.length > limit) throw new TowerError('invalid', `첫 메시지가 너무 깁니다. 할 일 내용과 첨부 파일 경로를 붙일 수 있게 ${limit - (least.length - text.length)}자 이하로 줄여 주세요.`);
  // The description gets up to half of what is left, the newest comments the rest; whatever still does not fit goes:
  // the oldest comments, then the description, then sub-tasks from the end.
  const room = limit - compose('', subtasks, [], true).length;
  let description = clip(task.description, Math.max(0, Math.floor(room / 2)));
  let left = room - description.length;
  const kept: { at: string; body: string }[] = [];
  for (const comment of [...all].reverse()) {
    const body = clip(comment.body, Math.max(0, left - comment.at.length));
    if (!body.trim() || left <= 0) break;
    kept.unshift({ at: comment.at, body });
    left -= comment.at.length + body.length;
  }
  const listed = [...subtasks];
  let result = compose(description, listed, kept, true);
  while (result.length > limit) {
    if (kept.length) kept.shift();
    else if (description) description = description.length > 1 ? clip(task.description, Math.max(0, description.length - (result.length - limit) - 2)) : '';
    else listed.pop();
    result = compose(description, listed, kept, true);
  }
  return result;
}
