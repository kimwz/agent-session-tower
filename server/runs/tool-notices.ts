import { randomUUID } from 'node:crypto';
import type { Run, Session } from '../../shared/types.js';
import { towerInstructionsBlock } from '../sessions/parser.js';
import { ClaudeControl } from './claude-control.js';
import type { CodexStdioRun } from './codex-stdio.js';
import type { RunTools } from './session-mcp.js';
import { SteeringError } from './steering.js';

export interface ToolNoticeHost {
  runs(): Iterable<Run>;
  run(id: string): Run | undefined;
  getSession(id: string): Session | undefined;
  runTools(run: Run, session: Session): RunTools;
  stopping(): boolean;
  updating(): boolean;
  /** A run of the session is being admitted or inserted right now. */
  admitting(run: Run): boolean;
  /** The Tower-owned native writer of a running turn; never a Codex app (bridged) turn, which owns its own context. */
  writer(runId: string): CodexStdioRun | ClaudeControl | undefined;
  /** Lets a turn that has nothing left close its input. */
  finishInput(runId: string): void;
}

/**
 * Private notices about the owner's tools (a secret connection made or changed) for the owner's running turns. They go
 * into the running turn only, never as a new run or visible history, and an uncertain send is never repeated.
 */
export class ToolNotices {
  private readonly pending = new Map<string, string>();
  private readonly sendingIds = new Set<string>();
  constructor(private readonly host: ToolNoticeHost) {}

  /** Being sent now: a handoff waits for an uncertain hidden send to settle. */
  get sending(): number { return this.sendingIds.size; }

  clear(): void { this.pending.clear(); }

  /** An explicit owner connection targets one session; never creates or resumes a provider turn. */
  notify(instructions: string, sessionId: string): void {
    if (!sessionId || this.host.stopping() || this.host.updating()) return;
    for (const run of this.host.runs()) {
      if (run.status !== 'running' || run.steering || run.sessionId !== sessionId) continue;
      if (this.eligible(run)) this.pending.set(run.id, instructions);
    }
    // Coalesce changes committed in the same tick before touching the native transport.
    queueMicrotask(() => this.flush());
  }

  private eligible(run: Run): boolean {
    const session = this.host.getSession(run.sessionId);
    return Boolean(session && !session.closed && !run.ownerStopped && run.origin?.kind === 'owner'
      && run.towerTools === 'attached' && this.host.runTools(run, session).servers?.tower_secrets);
  }

  flush(): void {
    for (const [id, text] of this.pending) {
      const run = this.host.run(id);
      if (!run || run.status !== 'running' || !this.eligible(run)) { this.pending.delete(id); continue; }
      if (this.host.stopping() || this.host.updating() || this.sendingIds.has(id) || run.approvals?.length) continue;
      if ([...this.host.runs()].some(other => other.sessionId === run.sessionId && this.host.admitting(other))) continue;
      // Only Tower-owned native writers receive private instructions; desktop bridges own their own context.
      const adapter = this.host.writer(id);
      if (!adapter?.canSteer?.() || !adapter.steer) continue;
      this.pending.delete(id); this.sendingIds.add(id);
      const messageId = randomUUID();
      const prompt = towerInstructionsBlock(text);
      const send = async () => {
        if (run.status !== 'running' || this.host.stopping() || this.host.updating() || !this.eligible(run) || !adapter.canSteer?.()) throw new SteeringError('Private notice target is no longer available.', 'rejected');
        if (adapter instanceof ClaudeControl) await adapter.steer({ type: 'user', uuid: messageId, session_id: this.host.getSession(run.sessionId)!.nativeId, parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
        else {
          const steer = adapter.steer;
          if (!steer) throw new SteeringError('Private notice writer is no longer available.', 'rejected');
          await steer.call(adapter, { id: messageId, prompt });
        }
      };
      void send().catch(error => {
        if (error instanceof SteeringError && error.disposition === 'rejected' && run.status === 'running' && !this.host.stopping() && this.eligible(run)) {
          if (!this.pending.has(id)) this.pending.set(id, text);
        } else {
          // An uncertain message may already be in the turn: do not resend it or log provider text.
          console.warn('Tower could not confirm a private secret-connection notice; credentials remain discoverable when needed.');
        }
      }).finally(() => {
        this.sendingIds.delete(id);
        this.host.finishInput(id);
      });
    }
  }
}
