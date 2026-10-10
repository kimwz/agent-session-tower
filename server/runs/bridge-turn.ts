import type { Run, Session } from '../../shared/types.js';
import { attachmentPrompt, imagePaths } from '../stores/attachments.js';
import type { CodexBridgeRun } from './codex-bridge.js';
import { ownerOrigin } from './origin.js';
import { FINISHED } from './run-records.js';
import type { Prepared, TurnExit, TurnHost } from './turn-host.js';

/**
 * Prepares a turn for the Codex app that holds the conversation open: Tower hands it the request over the app's own
 * server instead of starting a second writer. The app runs it with its own tools, so only a turn that can do without
 * Tower's tools and instructions goes there (`unsupported` otherwise, or when no app takes it).
 *
 * `start` resolves once the submission settled: the queue waits for it, as one run occupies the loop until then.
 * The turn's end is reported once, through `host.exited`. A submission that fails before the app reported its end is
 * reported as `bridge-start-failed` and is never retried by another writer; one that fails after only closes the app's
 * handle.
 */
export async function prepareBridgeTurn(host: TurnHost, run: Run, session: Session): Promise<Prepared<CodexBridgeRun, { heldForUpdate: boolean }>> {
  // The desktop app owns its tools; only turns that can do without Tower's tools are forwarded.
  const tools = host.runTools(run, session);
  if (tools.required || run.instructions?.required) return { kind: 'unsupported' };
  if (!host.options.openCodexBridge) return { kind: 'unsupported' };
  const attachments = await host.attachments.resolve(run.sessionId, run.attachments);
  let started = false;
  /** Closed before it was sent because Tower is switching workers: the run waits for the new worker. */
  let heldForUpdate = false;
  let reported = false;
  const end = (exit: TurnExit) => { if (reported) return; reported = true; host.exited(exit); };
  const bridge = await host.options.openCodexBridge({
    // The desktop app shows every block it is sent: a turn goes there only without instructions it must have, and without
    // its notes.
    threadId: session.nativeId, runId: run.id, prompt: attachmentPrompt(run.prompt, attachments),
    ...(ownerOrigin(run.origin) ? { approvalsReviewer: 'auto_review' as const } : {}),
    ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}),
    ...(attachments.length ? { imagePaths: imagePaths(attachments) } : {}),
    onStarted: () => {
      if (FINISHED.has(run.status)) return;
      started = true;
      run.status = 'running'; run.startedAt = new Date().toISOString(); run.output = '';
      host.changed(run);
    },
    onOutput: text => { if (!FINISHED.has(run.status)) host.append(run, text); },
    onFinished: result => end({ kind: 'bridge', run, session, result, started, heldForUpdate }),
  });
  if (!bridge) return { kind: 'unsupported' };
  try { await host.prepareLaunch(run); } catch (error) { bridge.close(); throw error; }
  return {
    kind: 'ready', handle: bridge,
    dispose: detail => { heldForUpdate = detail.heldForUpdate; bridge.close(); },
    start: async () => {
      // The desktop app runs the turn with its own tools; Tower's cannot be attached there.
      if (tools.towerTools) run.towerTools = tools.servers ? 'desktop-app' : tools.towerTools;
      run.output = '열려 있는 Codex 앱의 기존 세션으로 요청을 전달하고 있습니다.';
      host.changed(run);
      try { await bridge.start(); }
      catch (error) {
        if (!reported) { reported = true; host.exited({ kind: 'bridge-start-failed', run, session, handle: bridge, error }); }
        else bridge.close();
      }
    },
  };
}
