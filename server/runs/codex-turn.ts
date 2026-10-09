import { stat } from 'node:fs/promises';
import type { Run, Session } from '../../shared/types.js';
import { attachmentPrompt, imagePaths } from '../stores/attachments.js';
import { codexReviewer } from './approval-policy.js';
import { openCodexStdioRun, type CodexStdioRun } from './codex-stdio.js';
import { ReplyLog } from './replies.js';
import { errorMessage, FINISHED, RunError } from './run-records.js';
import { UUID } from './saved-state.js';
import { awaitToolServers } from './session-mcp.js';
import { MASTER_TOOL_TIMEOUT_SECONDS } from './subscription.js';
import { turnEnv } from './turn-env.js';
import type { Prepared, TurnHost, TurnExit } from './turn-host.js';

/**
 * Prepares a turn of Tower's own Codex (its app server over stdio): the program, folder, attachments, notes, tools and
 * environment, then the adapter, which does not spawn until it starts. It checks again after each step that is
 * followed by another; the last look is the manager's. `start` marks the run running once the manager registered the
 * handle; the adapter's end is reported once, through `host.exited`, and only for a registered turn.
 */
export async function prepareCodexTurn(host: TurnHost, run: Run, session: Session, creating: boolean): Promise<Prepared<CodexStdioRun>> {
  const executable = await host.executable('codex');
  if (!executable) throw new Error('Codex CLI is no longer available in PATH.');
  if (!(await stat(session.cwd)).isDirectory()) throw new Error('The session working directory no longer exists.');
  const attachments = await host.attachments.resolve(run.sessionId, run.attachments);
  const latest = host.getSession(session.id);
  if (run.status !== 'queued' || host.stopping() || (latest && (host.isWorking(latest) || latest.activeProcess))) {
    host.release(session.id);
    return { kind: 'refused' };
  }
  if (!creating) host.validateSession(latest);
  else if (!latest) throw new RunError('Session no longer exists.', 'not-found');
  const master = host.masterSession(session);
  let started = false;
  let registered = false;
  let reported = false;
  const end = (exit: TurnExit) => { if (reported) return; reported = true; host.exited(exit); };
  await host.notes.add(run, session, creating);
  const tools = host.runTools(run, session);
  await awaitToolServers(tools);
  if (run.status !== 'queued' || host.stopping()) {
    host.release(session.id);
    return { kind: 'refused' };
  }
  const env = turnEnv(host.options.env, master, tools, host.options.launchMarks);
  // The master's own tools may take longer than Codex's default minute (see MASTER_TOOL_TIMEOUT_SECONDS).
  const mcpServers = master && tools.servers?.tower_master
    ? { ...tools.servers, tower_master: { ...tools.servers.tower_master, tool_timeout_sec: MASTER_TOOL_TIMEOUT_SECONDS } as typeof tools.servers.tower_master } : tools.servers;
  if (tools.towerTools) run.towerTools = tools.towerTools;
  const codexReplies = master ? new ReplyLog(run, Date.now) : undefined;
  const handle = await (host.options.openCodexStdio ?? openCodexStdioRun)({
    executable, cwd: session.cwd, env, spawnProcess: host.options.spawnProcess,
    mcpServers, ...(master ? { subscriptionOnly: true } : {}),
    ...(!creating ? { threadId: session.nativeId } : {}),
    ...codexReviewer(run, creating, Boolean(mcpServers?.tower_slack)),
    ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}),
    prompt: attachmentPrompt(run.prompt, attachments),
    ...(run.instructions?.text ? { instructions: run.instructions.text } : {}),
    imagePaths: imagePaths(attachments),
    onSession: async id => {
      if (!UUID.test(id) || (!creating && id !== session.nativeId)) throw new Error('Codex returned a different or invalid conversation ID. No message was submitted.');
      if (run.status !== 'running' || host.stopping()) throw new Error('The task stopped before a message was submitted.');
      if (creating) {
        if (!host.registry.confirm(session.id, id)) throw new Error('The new conversation identity changed. No message was submitted.');
        session.nativeId = id;
        host.changed();
        try { if (!await host.persistNativeIdentity(run)) return; }
        catch (error) { throw new Error(`Cannot save the new conversation identity: ${errorMessage(error)}`); }
      }
    },
    onStarted: (_turnId, startedAt) => {
      if (FINISHED.has(run.status)) return;
      started = true; run.startedAt = startedAt ?? new Date().toISOString(); host.changed();
    },
    onOutput: text => { if (!FINISHED.has(run.status)) host.append(run, text); },
    ...(codexReplies ? { onReply: (id: string, text: string, done: boolean) => { if (!FINISHED.has(run.status) && codexReplies.add(id, text, done)) host.notifyOutput(); } } : {}),
    onApproval: approval => { if (run.status === 'running') { run.approvals = [...(run.approvals || []), approval]; host.changed(); } },
    onApprovalCancelled: id => {
      if (!run.approvals?.some(approval => approval.id === id)) return;
      run.approvals = run.approvals.filter(approval => approval.id !== id);
      if (!run.approvals.length) delete run.approvals;
      host.changed();
    },
    // The adapter reports completion only after its native child has closed.
    onFinished: result => { if (registered) end({ kind: 'codex', run, session, result, started }); },
  });
  // Opening an adapter does not spawn. Admission can be cancelled during discovery.
  try { await host.prepareLaunch(run); } catch (error) { handle.close(); throw error; }
  return { kind: 'ready', handle, dispose: () => handle.close(),
    start: () => { registered = true; run.status = 'running'; run.output = ''; host.changed(); } };
}
