import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Run, Session } from '../../shared/types.js';
import { TOWER_NOTICE } from '../../shared/task-notification.js';
import { validModelId } from '../providers/models.js';
import { claudeInputTokens, contextCapacity, modelContextWindow } from '../sessions/context.js';
import { towerInstructionsBlock } from '../sessions/parser.js';
import { attachmentPrompt, claudeImageBlocks } from '../stores/attachments.js';
import { automaticApprovals, claudeStartMode } from './approval-policy.js';
import { BackgroundTaskTracker, messageText, type FinishedTask } from './background-tasks.js';
import { buildCreateArgs, buildResumeArgs } from './claude-args.js';
import { ClaudeControl } from './claude-control.js';
import { ReplyLog } from './replies.js';
import { errorMessage, MAX_PROMPT, RunError } from './run-records.js';
import { UUID } from './saved-state.js';
import { awaitToolServers, privateMcpConfig } from './session-mcp.js';
import { checkClaudeSubscription, MASTER_APPROVED_TOOLS, MASTER_TOOL_TIMEOUT_SECONDS } from './subscription.js';
import { turnEnv } from './turn-env.js';
import type { OwnedProcess, Prepared, TurnHost } from './turn-host.js';
import { WakeupTracker } from './wakeup.js';
import { narrationText } from '../sessions/claude-narration.js';
import { TODO_TOOLS_SERVER } from '../todo/agent-tools.js';

const BACKGROUND_FOLLOW_UP_MS = 60_000;
const BACKGROUND_WAIT_MAX_MS = 2 * 60 * 60 * 1000;
/** Task bookends can follow a result, even in the next stdout chunk: an answered turn closes its input this much later. */
export const CLAUDE_FINISH_RECHECK_MS = 250;
/** What Tower tells Claude when a finished background task did not start a follow-up turn by itself. */
function backgroundNotice(finished: readonly FinishedTask[]): string {
  const lines = finished.map(task => `- ${task.status}${task.summary ? `: ${task.summary}` : ''}${task.outputFile ? ` (output: ${task.outputFile})` : ''}`);
  return `${TOWER_NOTICE} Background work you started in this conversation has finished${lines.length ? `:\n${lines.join('\n')}` : '.'}\n`
    + 'Continue with what you planned to do once it finished, and report the result.';
}

/**
 * Prepares a Claude Code turn: the program, folder, attachments, notes, tools, arguments and environment, the master's
 * sign-in check and the private MCP config. It checks again after each step that is followed by another; the last look
 * is the manager's. `handle` spawns the process (removing the config if that throws); `start` wires its output and
 * sends the request. The process's end is reported once, through `host.exited`, after its identity is saved.
 */
export async function prepareClaudeTurn(host: TurnHost, run: Run, session: Session, creating: boolean): Promise<Prepared<() => OwnedProcess>> {
  const executable = await host.executable(session.provider);
  if (!executable) throw new Error(`${session.provider} CLI is no longer available in PATH.`);
  if (!(await stat(session.cwd)).isDirectory()) throw new Error('The session working directory no longer exists.');
  const attachments = await host.attachments.resolve(run.sessionId, run.attachments);
  await host.notes.add(run, session, creating);
  host.touch(run);
  const args = creating ? buildCreateArgs(session, run.model, run.effort) : buildResumeArgs(session, run.model, run.effort);
  const tools = host.runTools(run, session);
  await awaitToolServers(tools);
  const mcpServers = tools.servers;
  if (tools.towerTools) run.towerTools = tools.towerTools;
  if (automaticApprovals(run)) args.push('--permission-mode', 'auto');
  // Explicit either way: the owner's "enabled by default" setting must not bring their Chrome to a turn Tower left it out of.
  args.push(tools.claudeChrome ? '--chrome' : '--no-chrome');
  // The owner's allow rules go to every turn Tower starts, as Codex reads them in every run: the owner also set up the
  // triggers, Slack and GitHub watches and public agents that start work here, and chose what that work may do.
  const settings = host.options.claudeSettings?.(session.cwd, session.id);
  if (settings) args.push('--settings', settings);
  // The owner opened the todos to every agent (2026-10-17): their tools are allowed wherever the turn has them. A master's
  // turn hands work out without review too (see MASTER_APPROVED_TOOLS).
  const allowed = [...(mcpServers?.[TODO_TOOLS_SERVER] ? [`mcp__${TODO_TOOLS_SERVER}`] : []),
    ...(host.masterSession(session) ? Object.entries(MASTER_APPROVED_TOOLS).flatMap(([server, names]) => mcpServers?.[server] ? names.map(name => `mcp__${server}__${name}`) : []) : [])];
  if (allowed.length) args.push(`--allowedTools=${allowed.join(',')}`);
  for (const directory of new Set(attachments.map(item => dirname(item.path)))) args.push('--add-dir', directory);
  const input = turnMessage(run, session, attachments);
  // Recheck after asynchronous filesystem discovery, immediately before creating the writer.
  await host.prepareLaunch(run);
  const latest = host.getSession(session.id);
  if (run.status !== 'queued' || host.stopping() || (latest && (host.isWorking(latest) || (latest.provider === 'codex' && latest.activeProcess))) || host.refusedAtLaunch(run, session)) {
    host.release(session.id);
    return { kind: 'refused' };
  }
  if (!creating) host.validateSession(latest);
  else if (!latest) throw new RunError('Session no longer exists.', 'not-found');
  const master = host.masterSession(session);
  const env = turnEnv(host.options.env, master, tools, host.options.launchMarks);
  if (master) {
    env.MCP_TOOL_TIMEOUT = String(MASTER_TOOL_TIMEOUT_SECONDS * 1000);
    // Asked the way the turn will start: same program, folder and environment.
    await (host.options.checkClaudeSubscription ?? checkClaudeSubscription)(executable, session.cwd, env);
    await host.prepareLaunch(run);
    if (run.status !== 'queued' || host.stopping() || host.refusedAtLaunch(run, session)) { host.release(session.id); return { kind: 'refused' }; }
  }
  // A capability in a tool server's environment would be visible in the process list as an argument (see privateMcpConfig).
  const privateConfig = mcpServers && Object.values(mcpServers).some(server => server.env) ? await privateMcpConfig(mcpServers) : undefined;
  if (mcpServers) args.push('--mcp-config', privateConfig?.path ?? JSON.stringify({ mcpServers }));
  // Writing the file yielded; nothing may have stopped the run in the meantime. The manager looks once more after this.
  if (privateConfig || run.permissionRequestIds?.length) {
    try { await host.prepareLaunch(run); } catch (error) { await privateConfig?.remove(); throw error; }
  }
  const turn = claudeProcess(host, run, session, creating, { executable, args, env, input, privateConfig });
  return { kind: 'ready', handle: turn.spawn, start: turn.start, dispose: () => privateConfig?.remove() };
}

/** A run's request as Claude takes it at the start of a turn: its prompt, Tower's instructions and its images. */
function turnMessage(run: Run, session: Session, attachments: Awaited<ReturnType<TurnHost['attachments']['resolve']>>, uuid?: string): Record<string, unknown> {
  return {
    type: 'user', ...(uuid ? { uuid } : {}), session_id: session.nativeId, parent_tool_use_id: null,
    message: { role: 'user', content: [
      { type: 'text', text: attachmentPrompt(run.prompt, attachments) },
      // A block of its own, not the system prompt: Claude keeps a conversation's first system prompt for every later turn.
      ...(run.instructions?.text ? [{ type: 'text', text: towerInstructionsBlock(run.instructions.text) }] : []),
      ...claudeImageBlocks(attachments),
    ] },
  };
}

interface ClaudeLaunch {
  executable: string; args: string[]; env: NodeJS.ProcessEnv;
  input: Record<string, unknown>;
  privateConfig?: { path: string; bindConsumer(pid: number): Promise<void>; remove: () => Promise<void> };
}

/**
 * One Claude Code process, started for one run: its output parsing, background work, master replies and identity. A run
 * ends at its answer when only services it does not wait for still run (see BackgroundTaskTracker.holding); the process
 * is then kept for them, and the conversation's next run that may go into it becomes its run (see `adopt`).
 */
function claudeProcess(host: TurnHost, run: Run, session: Session, creating: boolean, { executable, args, env, input, privateConfig }: ClaudeLaunch) {
  let child!: ChildProcessWithoutNullStreams;
  let finish!: () => void;
  let owned!: OwnedProcess;
  let configBound: Promise<void> = Promise.resolve();
  /** The process's end is reported once. */
  let reported = false;
  let buffer = '';
  let stderr = '';
  let streamError: string | undefined;
  let sawCompletion = false;
  let sawSessionId = false;
  let sawPartial = false;
  let messageHasPartial = false;
  /** The run this process serves; none while it is kept only for background work no run waits for. */
  let current: Run | undefined = run;
  /** The last run it served: the manager holds the process under its id, and the process's end is reported for it. */
  let last: Run = run;
  // What Claude itself put in the output, apart from Tower's notes: its final result is shown only if nothing was.
  let shown = false;
  // A turn Claude starts by itself in a kept process belongs to no run: its words are in the conversation only.
  const show = (text: string) => { shown = true; if (current) host.append(current, text); };
  const note = (text: string) => { if (current) host.append(current, text); };
  // The master's words, block by block, so they can be read aloud as they are written.
  const masterReplies = (served: Run) => host.masterSession(session) ? new ReplyLog(served, Date.now) : undefined;
  let replies = masterReplies(run);
  let replyMessage = '';
  /** Messages whose words came as partial text: their complete form adds nothing. */
  const streamedMessages = new Set<string>();
  const replied = (changed: boolean) => { if (changed && current) host.notifyOutput(current); };
  let modeNoted = false;
  let contextInput: { model: string; usedTokens: number } | undefined;
  let identitySaved: Promise<void> = Promise.resolve();
  /** A new conversation's identity is being saved: no run of it may succeed before that is durable. */
  let identitySaving = false;
  const wakeups = new WakeupTracker(MAX_PROMPT);
  // A turn ends at its result, but background work it started keeps running in this process. Input stays open while
  // it runs; the run itself stays until the work it waits for has ended and Claude has taken each notice in a
  // follow-up turn of this same run.
  const tasks = new BackgroundTaskTracker();
  // Whoever reads a run's result as "done" (an agent, a master, a trigger, Slack) also waits for the long-lived services
  // it started. The owner reads the conversation: a dev server keeps running after the owner's run, which ends.
  const waitsForServices = (served: Run) => served.origin?.kind !== 'owner' || served.sender === 'master' || Boolean(served.delegation);
  /** What keeps the current run open after its answer. */
  const holding = (served: Run) => tasks.holding(waitsForServices(served)) + tasks.unreadCount + (noticeId ? 1 : 0);
  const followUpMs = host.options.backgroundFollowUpMs ?? BACKGROUND_FOLLOW_UP_MS;
  const waitMaxMs = host.options.backgroundWaitMaxMs ?? BACKGROUND_WAIT_MAX_MS;
  const finishRecheckMs = host.options.claudeFinishRecheckMs ?? CLAUDE_FINISH_RECHECK_MS;
  let turnActive = true;
  /** Tower handed Claude the notice itself and Claude has not yet replayed it. */
  let noticeId: string | undefined;
  let waitTimedOut = false;
  /** When the current run's background wait ends at the latest; follow-up turns of that run do not move it. */
  let waitDeadline: number | undefined;
  let followUpTimer: ReturnType<typeof setTimeout> | undefined;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let inputClosedByTower = false;
  const clearFinishTimer = () => { if (finishTimer) clearTimeout(finishTimer); finishTimer = undefined; };
  const clearWaitTimers = () => {
    if (followUpTimer) clearTimeout(followUpTimer);
    if (waitTimer) clearTimeout(waitTimer);
    followUpTimer = waitTimer = undefined;
  };
  const endWait = () => { if (current?.backgroundWait) { delete current.backgroundWait; host.changed(current); } };
  const beginTurn = () => {
    if (turnActive) return;
    clearFinishTimer();
    turnActive = true; clearWaitTimers(); endWait(); tasks.observeTurnStart(); owned.claude?.setTurnIdle(false);
    // Each turn reports its own completion and its own reply.
    sawCompletion = false; shown = false; sawPartial = false; messageHasPartial = false;
  };
  const spawnTurn = (): OwnedProcess => {
    try {
      child = (host.options.spawnProcess ?? spawn)(executable, args, {
        cwd: session.cwd, env, detached: true, stdio: 'pipe', shell: false,
      });
    } catch (error) { void privateConfig?.remove().catch(cleanupError => console.error('Claude launch cleanup failed:', cleanupError)); throw error; }
    configBound = privateConfig && child.pid ? privateConfig.bindConsumer(child.pid) : Promise.resolve();
    configBound.catch(error => console.error('Claude temporary consumer registration failed:', error));
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    run.output = '';
    owned = { child, done: new Promise<void>((resolve) => { finish = resolve; }) };
    return owned;
  };
  const start = (): void => {
    owned.claude = new ClaudeControl({
      write: message => new Promise<void>((resolve, reject) => {
        if ((current && current.status !== 'running') || child.exitCode !== null || child.stdin.destroyed || child.stdin.writableEnded) { reject(new Error('Provider input is closed.')); return; }
        child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve());
      }),
      onApproval: approval => {
        if (current?.status === 'running') { current.approvals = [...(current.approvals || []), approval]; host.changed(current); return; }
        // A turn Claude started by itself in a kept process: no Tower task is there to ask the owner.
        void owned.claude?.respond(approval.id, 'deny', 'No Tower task is open in this conversation to ask the owner; the owner can ask for this in their next message.').catch(error => console.error('Claude permission request in a kept process could not be answered:', error));
      },
      onCancelled: id => {
        const served = current;
        if (!served?.approvals?.some(approval => approval.id === id)) return;
        served.approvals = served.approvals.filter(approval => approval.id !== id);
        if (!served.approvals.length) delete served.approvals;
        host.changed(served);
      },
      onError: error => { streamError = error.message; host.stop(last.id, owned); },
      // Instructions queued behind this turn can be inserted now; the page is told without waiting for output.
      onReady: () => host.changed(last),
    });
    const closeInput = () => { inputClosedByTower = true; clearFinishTimer(); clearWaitTimers(); owned.claude?.close(); if (!child.stdin.writableEnded) child.stdin.end(); };
    const idle = () => !turnActive && (!current || current.status === 'running') && child.exitCode === null && !child.stdin.writableEnded;
    const arm = (timer: 'followUp' | 'wait', ms: number) => {
      const handle = setTimeout(timer === 'followUp' ? followUp : waitLimit, ms);
      handle.unref();
      if (timer === 'followUp') followUpTimer = handle; else waitTimer = handle;
    };
    /**
     * Ends the current run at its answer while the process keeps running background work no run waits for any more.
     * The run keeps `backgroundWait` while its process is kept, so its conversation counts as in use (retention).
     */
    const release = (error?: string) => {
      const served = current;
      if (!served) return;
      clearFinishTimer(); clearWaitTimers(); waitDeadline = undefined;
      tasks.detach();
      // A notice Tower handed over and Claude has not taken yet is now for a turn no run waits for.
      noticeId = undefined;
      current = undefined; replies = undefined;
      const count = tasks.detachedCount;
      if (count) served.backgroundWait = { since: new Date().toISOString(), tasks: count };
      else delete served.backgroundWait;
      if (count) host.append(served, `\n[Tower] ${error ? 'Stopped waiting' : 'Turn finished'}; ${count} background task${count === 1 ? '' : 's'} keep${count === 1 ? 's' : ''} running in this conversation's Claude process.\n`);
      host.answered(served, owned, error);
    };
    // Claude normally takes a finished task's notice by itself. If it has not, Tower hands it over as a message.
    const followUp = () => {
      followUpTimer = undefined;
      if (!idle()) return;
      // Nobody waits for a kept process's work: a notice Claude did not take by now is let go.
      if (!current) { tasks.dropDetachedUnread(); owned.finishInput?.(); return; }
      if (current.approvals?.length) { arm('followUp', followUpMs); return; }
      if (noticeId) { note('\n[Tower] Claude has not answered the background work notice yet.\n'); return; }
      const unread = tasks.takeUnread();
      if (!unread.length) { owned.finishInput?.(); return; }
      noticeId = randomUUID();
      note('\n[Tower] Background work finished; asking Claude to continue.\n');
      child.stdin.write(JSON.stringify({ type: 'user', uuid: noticeId, session_id: session.nativeId, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: backgroundNotice(unread) }] } }) + '\n');
      arm('followUp', followUpMs);
    };
    const waitLimit = () => {
      waitTimer = undefined;
      if (!idle() || !current) return;
      if (current.approvals?.length) { arm('wait', followUpMs); return; }
      // Never reported as success.
      waitTimedOut = true;
      const minutes = Math.round(waitMaxMs / 60_000);
      // Work an earlier run left (the owner's server) is not this run's to end.
      if (waitsForServices(current) && !tasks.detachedCount) {
        // Its result is read as the work's end, and no later run of its origin could take the process (a trigger's
        // next event is another origin), so the work ends with it, as the owner's Stop does. Closing input alone no
        // longer ends Claude while background work runs.
        note(`\n[Tower] Background work was still running after ${minutes} minutes; ending the turn and its work.\n`);
        closeInput(); host.stop(last.id, owned);
        return;
      }
      note(`\n[Tower] Background work was still running after ${minutes} minutes; the turn ends and the work keeps running.\n`);
      release(`The turn answered, but its background work did not finish within the ${minutes} minutes Tower waits; it keeps running in this conversation.`);
      owned.finishInput?.();
    };
    /** A kept process ends once nothing it runs is left and Claude is idle: input closes, as at any turn's end. */
    const keptIdle = () => {
      // Work started in a turn Claude began by itself belongs to no run either.
      tasks.detach();
      const count = tasks.detachedCount;
      if (count) {
        clearFinishTimer();
        if (last.backgroundWait?.tasks !== count) { last.backgroundWait = { since: last.backgroundWait?.since ?? new Date().toISOString(), tasks: count }; host.changed(last); }
        if (tasks.detachedUnreadCount && !followUpTimer) arm('followUp', followUpMs);
        return;
      }
      if (!finishTimer) finishTimer = setTimeout(() => {
        finishTimer = undefined;
        if (!idle() || current || owned.claude?.hasPendingSteers()) return;
        if (tasks.detachedCount) { owned.finishInput?.(); return; }
        if (last.backgroundWait) { delete last.backgroundWait; host.changed(last); }
        closeInput();
      }, finishRecheckMs);
    };
    owned.finishInput = () => {
      if (turnActive || owned.claude?.hasPendingSteers() || child.stdin.writableEnded) return;
      if (!current) { keptIdle(); return; }
      if (!sawCompletion) return;
      // A failed turn is not kept open for its background work. Claude does not end while that work runs, so the
      // process is kept for it, as after any run that ends before its work.
      const served = current;
      if (streamError) {
        // Task bookends can follow a result, even in the next stdout chunk. Recheck after they drain.
        if (!finishTimer) finishTimer = setTimeout(() => {
          finishTimer = undefined;
          if (!streamError || current !== served || turnActive || child.stdin.writableEnded) return;
          if (!tasks.runningCount && !tasks.detachedCount) { endWait(); closeInput(); return; }
          // The owner's process is kept for its work; work others read ends with its failed turn.
          if (waitsForServices(served) && !tasks.detachedCount) { closeInput(); host.stop(last.id, owned); return; }
          const failure = streamError; streamError = undefined;
          release(failure); owned.finishInput?.();
        }, finishRecheckMs);
        return;
      }
      if (!holding(served)) {
        // Task bookends can follow a result, even in the next stdout chunk. Recheck after they drain.
        if (!finishTimer) finishTimer = setTimeout(() => {
          finishTimer = undefined;
          if (!idle() || current !== served || owned.claude?.hasPendingSteers()) return;
          if (holding(served)) { owned.finishInput?.(); return; }
          // A run ends here only once a new conversation's identity is saved, as at an exit (see the close handler).
          if (identitySaving) { void identitySaved.then(() => owned.finishInput?.()); return; }
          // It failed meanwhile (its identity could not be saved): never released as a success.
          if (streamError) { owned.finishInput?.(); return; }
          // Services it does not wait for, and work an earlier run left, keep the process after the run.
          if (tasks.runningCount || tasks.detachedCount) { release(); owned.finishInput?.(); return; }
          endWait(); closeInput();
        }, finishRecheckMs);
        return;
      }
      clearFinishTimer();
      if (tasks.unreadCount && !followUpTimer) arm('followUp', followUpMs);
      const waiting = tasks.holding(waitsForServices(served));
      if (!served.backgroundWait) {
        served.backgroundWait = { since: new Date().toISOString(), tasks: waiting };
        note(waiting ? `\n[Tower] Waiting for ${waiting} background task${waiting === 1 ? '' : 's'} before this turn ends.\n`
          : '\n[Tower] Waiting for Claude to take the finished background work.\n');
      } else served.backgroundWait.tasks = waiting;
      if (!waitTimer) { waitDeadline ??= Date.now() + waitMaxMs; arm('wait', Math.max(0, waitDeadline - Date.now())); }
      host.changed(served);
    };
    /**
     * The conversation's next run goes into a kept process as a turn of its own, while no turn is under way here. A run
     * still waiting for its background work keeps it: what arrives meanwhile is inserted into that run, as before.
     * The caller sends the run's message; Claude acknowledges it by replaying it.
     */
    owned.canAdopt = () => !current && !turnActive && !streamError && child.exitCode === null && !child.stdin.writableEnded
      && !owned.claude?.hasPendingSteers() && !noticeId && Boolean(owned.claude?.canSteer());
    owned.adopt = (next, attachments) => {
      if (!owned.canAdopt?.() || !owned.claude) return undefined;
      clearFinishTimer(); clearWaitTimers();
      if (last.backgroundWait) { delete last.backgroundWait; host.changed(last); }
      current = last = next;
      sawCompletion = false; shown = false; sawPartial = false; messageHasPartial = false; waitTimedOut = false; waitDeadline = undefined;
      replies = masterReplies(next);
      return owned.claude.steer(turnMessage(next, session, attachments, next.id));
    };
    /** The adopted run's message never reached Claude: the process is kept for its background work again. */
    owned.disown = (next, previous) => {
      if (current !== next || turnActive) return false;
      current = undefined; last = previous; replies = undefined;
      owned.finishInput?.();
      return true;
    };
    const parseEventLine = (line: string): void => {
      if (!line.trim()) return;
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { show(line + '\n'); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Expected a provider event object.');
      if (owned.claude?.handle(event)) {
        if (event.type === 'user' && event.isReplay) { beginTurn(); sawCompletion = false; tasks.observeReplay(event); }
        return;
      }
      const actualId = event.type === 'system' && event.subtype === 'init' ? event.session_id : undefined;
      if (actualId && creating && host.registry.unconfirmed(session.id) && typeof actualId === 'string' && UUID.test(actualId)
        && actualId === session.nativeId) {
        host.registry.confirm(session.id, actualId);
        session.nativeId = actualId;
        host.changed(run);
        identitySaving = true;
        identitySaved = host.persistNativeIdentity(run).then(() => {}).catch(error => {
          streamError = `Cannot save the new conversation identity: ${errorMessage(error)}`;
          host.stop(last.id, owned);
        }).finally(() => { identitySaving = false; });
      }
      if (actualId === session.nativeId) sawSessionId = true;
      // Claude reports the mode it actually runs in before doing anything, for example the one it falls back to
      // where automatic mode is not available. An unattended run continues only in automatic mode, or in a mode
      // that asks the owner; any other or missing mode is stopped. The owner's own turns go on and say so.
      const startMode = actualId ? claudeStartMode(run, event.permissionMode) : undefined;
      if (startMode && 'stop' in startMode) {
        streamError = startMode.stop;
        host.stop(last.id, owned);
        return;
      }
      if (startMode) {
        if (!modeNoted) note(startMode.note);
        modeNoted = true;
      }
      if (actualId && actualId !== session.nativeId) {
        streamError = creating ? 'The provider did not confirm the new conversation ID. The task was stopped.' : 'The provider opened a different conversation instead of resuming the requested session. The task was stopped.';
        host.stop(last.id, owned);
        return;
      }
      const mainContext = event.parent_tool_use_id == null && (event.session_id === undefined || event.session_id === session.nativeId);
      // Anything the main conversation says after a result is a follow-up turn, typically Claude taking a task's notice.
      if (mainContext && ['assistant', 'user', 'stream_event'].includes(event.type)) beginTurn();
      if (mainContext && event.type === 'user' && event.isReplay) {
        // Tower's own notice is taken once Claude replays it; the turn it starts must then reach its result.
        if (noticeId && event.uuid === noticeId) noticeId = undefined;
        else { tasks.observeReplay(event); wakeups.observeReplay(messageText(event)); }
      }
      if ((event.session_id === undefined || event.session_id === session.nativeId) && tasks.observe(event) && !turnActive) owned.finishInput?.();
      if (mainContext && event.type === 'system' && event.subtype === 'compact_boundary') contextInput = undefined;
      if (event.type === 'system' && event.subtype === 'task_started' && event.is_backgrounded === false && (event.session_id === undefined || event.session_id === session.nativeId)) owned.claude?.foregroundStarted();
      if (mainContext) wakeups.observe(event);
      if (mainContext && event.type === 'stream_event' && event.event?.type === 'message_start') tasks.observeReply(event.event.message?.id);
      if (mainContext && event.type === 'assistant' && !event.isMeta && !event.is_meta) {
        const model = event.message?.model;
        if (!String(model || '').includes('synthetic')) {
          tasks.observeReply(event.message?.id);
          contextInput = undefined;
          const usedTokens = claudeInputTokens(event.message?.usage);
          if (validModelId(model) && usedTokens !== undefined) contextInput = { model, usedTokens };
        }
      }
      if (replies && mainContext && event.type === 'stream_event') {
        const part = event.event;
        const block = `${replyMessage}:${Number(part?.index) || 0}`;
        if (part?.type === 'message_start') replyMessage = typeof part.message?.id === 'string' ? part.message.id : randomUUID();
        else if (part?.type === 'content_block_start' && part.content_block?.type === 'text') replied(replies.add(block, typeof part.content_block.text === 'string' ? part.content_block.text : ''));
        else if (part?.type === 'content_block_delta' && part.delta?.type === 'text_delta' && typeof part.delta.text === 'string') { streamedMessages.add(replyMessage); replied(replies.add(block, part.delta.text)); }
        else if (part?.type === 'content_block_stop') replied(replies.finish(block));
      }
      if (event.type === 'stream_event') {
        if (event.event?.type === 'message_start') messageHasPartial = false;
        const delta = event.event?.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          show(delta.text); sawPartial = true; messageHasPartial = true;
        }
        if (event.event?.type === 'message_stop' && messageHasPartial) show('\n\n');
      } else if (event.type === 'assistant') {
        const messageId = typeof event.message?.id === 'string' ? event.message.id : randomUUID();
        for (const [index, block] of (event.message?.content ?? []).entries()) {
          if (block.type === 'text' && replies && mainContext && !streamedMessages.has(messageId)) replied(replies.add(`${messageId}:a${index}`, String(block.text), true));
          if (block.type === 'text' && !messageHasPartial) show(String(block.text) + '\n\n');
          // Narration arrives whole as a thinking block, never as text deltas.
          const narration = narrationText(block);
          if (narration !== undefined) show(narration.trim() + '\n\n');
          if (block.type === 'tool_use') show(`[${block.name}]\n`);
        }
        messageHasPartial = false;
      } else if (event.type === 'result' && mainContext) {
        const capacity = contextInput && mainContext ? modelContextWindow(event.modelUsage, contextInput.model) : undefined;
        if (current && contextInput && contextCapacity(capacity) && sawSessionId && !streamError) {
          current.contextUsage = { ...contextInput, contextWindow: capacity, usedPercent: contextInput.usedTokens / capacity * 100,
            updatedAt: new Date().toISOString() };
          host.changed(current);
        }
        sawCompletion = true;
        turnActive = false;
        owned.claude?.setTurnIdle(true);
        // A turn Claude started by itself in a kept process has no run to fail.
        if (event.is_error && current) streamError = (event.errors ?? [event.result ?? 'Claude Code could not complete this turn.']).join('\n');
        // A denied tool call (by the user or the auto mode classifier) is part of a turn that
        // still finished; Claude's own reply explains it. Only a failed turn is reported.
        if (event.is_error && current && event.permission_denials?.length) {
          const denied = [...new Set(event.permission_denials.map((denial: any) => denial.tool_name ?? 'tool'))].join(', ');
          streamError = `Permission was denied for: ${denied}. The instruction could not complete with the current permissions.`;
          show(`\n${streamError}\n`);
        }
        if (!sawPartial && !shown && event.result) show(String(event.result));
        owned.finishInput?.();
      }
    };
    const parseLine = (line: string): void => {
      try { parseEventLine(line); }
      catch {
        streamError = 'The provider emitted an invalid output event. The task was stopped.';
        host.stop(last.id, owned);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); parseLine(line); }
      if (buffer.length > 2_000_000) { streamError = 'Provider emitted an oversized output event.'; buffer = ''; host.stop(last.id, owned); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') streamError = errorMessage(error); });
    child.on('error', (error: Error) => { streamError = errorMessage(error); });
    child.on('close', async (code: number | null, signal: NodeJS.Signals | null) => {
      if (buffer) parseLine(buffer);
      clearFinishTimer(); clearWaitTimers();
      const pendingApproval = !!current?.approvals?.length;
      const pendingSteer = owned.claude?.hasPendingSteers();
      delete last.backgroundWait;
      owned.claude?.close();
      // A newly bound UUID must be durable before this turn reports success.
      await identitySaved;
      try { await configBound; await privateConfig?.remove(); } catch (error) { console.error('Claude temporary config cleanup failed:', error); }
      if (reported) return;
      reported = true;
      host.exited({ kind: 'claude', run: last, session, owned, finish, summary: { code, signal, streamError, stderr, sawCompletion, sawSessionId, waitTimedOut, inputClosedByTower,
        outstanding: tasks.outstanding, noticePending: Boolean(noticeId), runningTasks: tasks.runningCount, unreadTasks: tasks.unreadCount,
        pendingApproval, pendingSteer: Boolean(pendingSteer), wakeup: wakeups.pending } });
    });
    owned.claude.start(input);
    host.changed(run);
  };
  return { spawn: spawnTurn, start };
}
