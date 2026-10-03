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
import { checkClaudeSubscription, MASTER_TOOL_TIMEOUT_SECONDS } from './subscription.js';
import { turnEnv } from './turn-env.js';
import type { OwnedProcess, Prepared, TurnHost } from './turn-host.js';
import { WakeupTracker } from './wakeup.js';

const BACKGROUND_FOLLOW_UP_MS = 60_000;
const BACKGROUND_WAIT_MAX_MS = 2 * 60 * 60 * 1000;
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
  const args = creating ? buildCreateArgs(session, run.model, run.effort) : buildResumeArgs(session, run.model, run.effort);
  const tools = host.runTools(run, session);
  await awaitToolServers(tools);
  const mcpServers = tools.servers;
  if (tools.towerTools) run.towerTools = tools.towerTools;
  if (automaticApprovals(run)) args.push('--permission-mode', 'auto');
  // The owner's allow rules go to every turn Tower starts, as Codex reads them in every run: the owner also set up the
  // triggers, Slack and GitHub watches and public agents that start work here, and chose what that work may do.
  const settings = host.options.claudeSettings?.(session.cwd, session.id);
  if (settings) args.push('--settings', settings);
  for (const directory of new Set(attachments.map(item => dirname(item.path)))) args.push('--add-dir', directory);
  const prompt = attachmentPrompt(run.prompt, attachments);
  const input = {
    type: 'user', session_id: session.nativeId, parent_tool_use_id: null,
    message: { role: 'user', content: [
      { type: 'text', text: prompt },
      // A block of its own, not the system prompt: Claude keeps a conversation's first system prompt for every later turn.
      ...(run.instructions?.text ? [{ type: 'text', text: towerInstructionsBlock(run.instructions.text) }] : []),
      ...claudeImageBlocks(attachments),
    ] },
  };
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
    try { await host.prepareLaunch(run); } catch (error) { privateConfig?.remove(); throw error; }
  }
  const turn = claudeProcess(host, run, session, creating, { executable, args, env, input, privateConfig });
  return { kind: 'ready', handle: turn.spawn, start: turn.start, dispose: () => privateConfig?.remove() };
}

interface ClaudeLaunch {
  executable: string; args: string[]; env: NodeJS.ProcessEnv;
  input: Record<string, unknown>;
  privateConfig?: { path: string; remove: () => void };
}

/** One Claude Code process for one run: its output parsing, background work, master replies and identity. */
function claudeProcess(host: TurnHost, run: Run, session: Session, creating: boolean, { executable, args, env, input, privateConfig }: ClaudeLaunch) {
  let child!: ChildProcessWithoutNullStreams;
  let finish!: () => void;
  let owned!: OwnedProcess;
  /** The process's end is reported once. */
  let reported = false;
  let buffer = '';
  let stderr = '';
  let streamError: string | undefined;
  let sawCompletion = false;
  let sawSessionId = false;
  let sawPartial = false;
  let messageHasPartial = false;
  // What Claude itself put in the output, apart from Tower's notes: its final result is shown only if nothing was.
  let shown = false;
  const show = (text: string) => { shown = true; host.append(run, text); };
  // The master's words, block by block, so they can be read aloud as they are written.
  const replies = host.masterSession(session) ? new ReplyLog(run, Date.now) : undefined;
  let replyMessage = '';
  /** Messages whose words came as partial text: their complete form adds nothing. */
  const streamedMessages = new Set<string>();
  const replied = (changed: boolean) => { if (changed) host.notifyOutput(); };
  let modeNoted = false;
  let contextInput: { model: string; usedTokens: number } | undefined;
  let identitySaved: Promise<void> = Promise.resolve();
  const wakeups = new WakeupTracker(MAX_PROMPT);
  // A turn ends at its result, but background work it started keeps running in this process. Input stays open
  // until that work has ended and Claude has taken each notice in a follow-up turn of this same run.
  const tasks = new BackgroundTaskTracker();
  const followUpMs = host.options.backgroundFollowUpMs ?? BACKGROUND_FOLLOW_UP_MS;
  const waitMaxMs = host.options.backgroundWaitMaxMs ?? BACKGROUND_WAIT_MAX_MS;
  let turnActive = true;
  /** Tower handed Claude the notice itself and Claude has not yet replayed it. */
  let noticeId: string | undefined;
  let waitTimedOut = false;
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
  const endWait = () => { if (run.backgroundWait) { delete run.backgroundWait; host.changed(); } };
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
    } catch (error) { privateConfig?.remove(); throw error; }
    if (privateConfig) child.once('close', privateConfig.remove);
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    run.output = '';
    owned = { child, done: new Promise<void>((resolve) => { finish = resolve; }) };
    return owned;
  };
  const start = (): void => {
    owned.claude = new ClaudeControl({
      write: message => new Promise<void>((resolve, reject) => {
        if (run.status !== 'running' || child.exitCode !== null || child.stdin.destroyed || child.stdin.writableEnded) { reject(new Error('Provider input is closed.')); return; }
        child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve());
      }),
      onApproval: approval => { if (run.status === 'running') { run.approvals = [...(run.approvals || []), approval]; host.changed(); } },
      onCancelled: id => {
        if (!run.approvals?.some(approval => approval.id === id)) return;
        run.approvals = run.approvals.filter(approval => approval.id !== id);
        if (!run.approvals.length) delete run.approvals;
        host.changed();
      },
      onError: error => { streamError = error.message; host.stop(run.id, owned); },
      // Instructions queued behind this turn can be inserted now; the page is told without waiting for output.
      onReady: () => host.changed(),
    });
    const closeInput = () => { inputClosedByTower = true; clearFinishTimer(); clearWaitTimers(); owned.claude?.close(); if (!child.stdin.writableEnded) child.stdin.end(); };
    const idle = () => !turnActive && run.status === 'running' && child.exitCode === null && !child.stdin.writableEnded;
    const arm = (timer: 'followUp' | 'wait', ms: number) => {
      const handle = setTimeout(timer === 'followUp' ? followUp : waitLimit, ms);
      handle.unref();
      if (timer === 'followUp') followUpTimer = handle; else waitTimer = handle;
    };
    // Claude normally takes a finished task's notice by itself. If it has not, Tower hands it over as a message.
    const followUp = () => {
      followUpTimer = undefined;
      if (!idle()) return;
      if (run.approvals?.length) { arm('followUp', followUpMs); return; }
      if (noticeId) { host.append(run, '\n[Tower] Claude has not answered the background work notice yet.\n'); return; }
      const unread = tasks.takeUnread();
      if (!unread.length) { owned.finishInput?.(); return; }
      noticeId = randomUUID();
      host.append(run, '\n[Tower] Background work finished; asking Claude to continue.\n');
      child.stdin.write(JSON.stringify({ type: 'user', uuid: noticeId, session_id: session.nativeId, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: backgroundNotice(unread) }] } }) + '\n');
      arm('followUp', followUpMs);
    };
    const waitLimit = () => {
      waitTimer = undefined;
      if (!idle()) return;
      if (run.approvals?.length) { arm('wait', followUpMs); return; }
      // Closing input is how every turn ended before; Claude ends what is left. Never reported as success.
      waitTimedOut = true;
      host.append(run, `\n[Tower] Background work was still running after ${Math.round(waitMaxMs / 60_000)} minutes; closing the turn.\n`);
      closeInput();
    };
    owned.finishInput = () => {
      if (!sawCompletion || turnActive || owned.claude?.hasPendingSteers() || child.stdin.writableEnded) return;
      // A failed turn is not kept open for its background work.
      if (streamError) { endWait(); closeInput(); return; }
      if (!tasks.outstanding && !noticeId) {
        // Task bookends can follow a result, even in the next stdout chunk. Recheck after they drain.
        if (!finishTimer) finishTimer = setTimeout(() => {
          finishTimer = undefined;
          if (!idle() || owned.claude?.hasPendingSteers()) return;
          if (tasks.outstanding || noticeId) { owned.finishInput?.(); return; }
          endWait(); closeInput();
        }, 250);
        return;
      }
      clearFinishTimer();
      if (tasks.unreadCount && !followUpTimer) arm('followUp', followUpMs);
      if (!run.backgroundWait) {
        run.backgroundWait = { since: new Date().toISOString(), tasks: tasks.runningCount };
        host.append(run, tasks.runningCount ? `\n[Tower] Waiting for ${tasks.runningCount} background task${tasks.runningCount === 1 ? '' : 's'} before this turn ends.\n`
          : '\n[Tower] Waiting for Claude to take the finished background work.\n');
        arm('wait', waitMaxMs);
      } else run.backgroundWait.tasks = tasks.runningCount;
      host.changed();
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
        host.changed();
        identitySaved = host.flush().catch(error => {
          streamError = `Cannot save the new conversation identity: ${errorMessage(error)}`;
          host.stop(run.id, owned);
        });
      }
      if (actualId === session.nativeId) sawSessionId = true;
      // Claude reports the mode it actually runs in before doing anything, for example the one it falls back to
      // where automatic mode is not available. An unattended run continues only in automatic mode, or in a mode
      // that asks the owner; any other or missing mode is stopped. The owner's own turns go on and say so.
      const startMode = actualId ? claudeStartMode(run, event.permissionMode) : undefined;
      if (startMode && 'stop' in startMode) {
        streamError = startMode.stop;
        host.stop(run.id, owned);
        return;
      }
      if (startMode) {
        if (!modeNoted) host.append(run, startMode.note);
        modeNoted = true;
      }
      if (actualId && actualId !== session.nativeId) {
        streamError = creating ? 'The provider did not confirm the new conversation ID. The task was stopped.' : 'The provider opened a different conversation instead of resuming the requested session. The task was stopped.';
        host.stop(run.id, owned);
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
          if (block.type === 'tool_use') show(`[${block.name}]\n`);
        }
        messageHasPartial = false;
      } else if (event.type === 'result' && mainContext) {
        const capacity = contextInput && mainContext ? modelContextWindow(event.modelUsage, contextInput.model) : undefined;
        if (contextInput && contextCapacity(capacity) && sawSessionId && !streamError) {
          run.contextUsage = { ...contextInput, contextWindow: capacity, usedPercent: contextInput.usedTokens / capacity * 100,
            updatedAt: new Date().toISOString() };
          host.changed();
        }
        sawCompletion = true;
        turnActive = false;
        owned.claude?.setTurnIdle(true);
        if (event.is_error) streamError = (event.errors ?? [event.result ?? 'Claude Code could not complete this turn.']).join('\n');
        // A denied tool call (by the user or the auto mode classifier) is part of a turn that
        // still finished; Claude's own reply explains it. Only a failed turn is reported.
        if (event.is_error && event.permission_denials?.length) {
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
        host.stop(run.id, owned);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); parseLine(line); }
      if (buffer.length > 2_000_000) { streamError = 'Provider emitted an oversized output event.'; buffer = ''; host.stop(run.id, owned); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') streamError = errorMessage(error); });
    child.on('error', (error: Error) => { streamError = errorMessage(error); });
    child.on('close', async (code: number | null, signal: NodeJS.Signals | null) => {
      if (buffer) parseLine(buffer);
      clearFinishTimer(); clearWaitTimers();
      const pendingApproval = !!run.approvals?.length;
      const pendingSteer = owned.claude?.hasPendingSteers();
      delete run.backgroundWait;
      owned.claude?.close();
      // A newly bound UUID must be durable before this turn reports success.
      await identitySaved;
      if (reported) return;
      reported = true;
      host.exited({ kind: 'claude', run, session, owned, finish, summary: { code, signal, streamError, stderr, sawCompletion, sawSessionId, waitTimedOut, inputClosedByTower,
        outstanding: tasks.outstanding, noticePending: Boolean(noticeId), runningTasks: tasks.runningCount, unreadTasks: tasks.unreadCount,
        pendingApproval, pendingSteer: Boolean(pendingSteer), wakeup: wakeups.pending } });
    });
    owned.claude.start(input);
    host.changed();
  };
  return { spawn: spawnTurn, start };
}
