import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import type { Provider, Run, Session } from '../../shared/types.js';
import type { AttachmentStore } from '../stores/attachments.js';
import type { ClaudeControl } from './claude-control.js';
import type { CodexBridgeOptions, CodexBridgeRun } from './codex-bridge.js';
import type { CodexStdioOptions, CodexStdioResult, CodexStdioRun } from './codex-stdio.js';
import type { RunTools } from './session-mcp.js';
import type { CreatedSessionRegistry } from './session-registry.js';
import type { checkClaudeSubscription } from './subscription.js';
import type { LaunchMarks } from './turn-env.js';
import type { TurnNotes } from './turn-notes.js';
import type { Wakeup } from './wakeup.js';

/** A Claude Code process Tower started for a turn. Only the run manager adds it to or removes it from its live turns. */
export interface OwnedProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  killTimer?: ReturnType<typeof setTimeout>;
  claude?: ClaudeControl;
  finishInput?: () => void;
}

/** What a turn module may read of the manager's options. */
export interface TurnOptions {
  env?: NodeJS.ProcessEnv;
  launchMarks?: LaunchMarks;
  spawnProcess?: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  checkClaudeSubscription?: typeof checkClaudeSubscription;
  claudeSettings?: (cwd: string, sessionId: string) => string | undefined;
  openCodexBridge?: (options: Omit<CodexBridgeOptions, 'codexHome'>) => Promise<CodexBridgeRun | undefined>;
  openCodexStdio?: (options: CodexStdioOptions) => Promise<CodexStdioRun>;
  backgroundFollowUpMs?: number;
  backgroundWaitMaxMs?: number;
}

/**
 * What the turn modules (Claude, Codex, Codex app) use of the run manager. They own their provider's protocol and what
 * they prepared; the manager owns the live turns, the last check before a provider starts, and every turn's end.
 */
export interface TurnHost {
  readonly options: Readonly<TurnOptions>;
  readonly registry: CreatedSessionRegistry;
  readonly attachments: AttachmentStore;
  readonly notes: TurnNotes;
  changed(): void;
  append(run: Run, text: string): void;
  notifyOutput(): void;
  flush(): Promise<void>;
  stopping(): boolean;
  updating(): boolean;
  /** Signals a Claude process to stop (then kills it if it does not). */
  stop(runId: string, owned: OwnedProcess): void;
  /** The launch gate's look and a permission continuation's check, taken again (may supersede the run). */
  prepareLaunch(run: Run): Promise<void>;
  refusedAtLaunch(run: Run, session: Session): boolean;
  /** The conversation is free for its next run; idempotent. */
  release(sessionId: string): void;
  /** The only way a turn reports its end (see TurnExit). */
  exited(exit: TurnExit): void;
  runTools(run: Run, session: Session): RunTools;
  executable(provider: Provider): Promise<string | undefined>;
  getSession(id: string): Session | undefined;
  isWorking(session: Session): boolean;
  validateSession(session: Session | undefined): asserts session is Session;
  masterSession(session: Session): boolean;
}

/**
 * A turn prepared to start. Preparing awaits (files, tools, adapters); the manager then checks once more, registers the
 * handle and calls `start` in one synchronous step, so nothing can land between its last check and the start.
 */
export type Prepared<H, D = void> =
  /** An intermediate check refused; the module already cleaned up and released the conversation. */
  | { kind: 'refused' }
  /** A Codex app cannot take this turn (no app, or tools or instructions it must have); nothing to clean up. */
  | { kind: 'unsupported' }
  /** `dispose` frees what was prepared when the manager's last check refuses; `start` may answer when it settles. */
  | { kind: 'ready'; handle: H; start(): void | Promise<void>; dispose(detail: D): void | Promise<void> };

/** How a Codex app turn ended. */
export type CodexBridgeResult = Parameters<CodexBridgeOptions['onFinished']>[0];

/** How a Claude process ended, as the manager decides the run's outcome from it. */
export interface ClaudeExitSummary {
  code: number | null; signal: NodeJS.Signals | null; streamError?: string; stderr: string;
  sawCompletion: boolean; sawSessionId: boolean; waitTimedOut: boolean; inputClosedByTower: boolean;
  /** Background work still running or unread, and a notice Tower handed over that Claude has not taken. */
  outstanding: number; noticePending: boolean; runningTasks: number; unreadTasks: number;
  pendingApproval: boolean; pendingSteer: boolean;
  /** A wakeup the turn scheduled. */
  wakeup?: Wakeup;
}

export type TurnExit =
  | { kind: 'claude'; run: Run; session: Session; owned: OwnedProcess; summary: ClaudeExitSummary; finish(): void }
  | { kind: 'codex'; run: Run; session: Session; result: CodexStdioResult; started: boolean }
  | { kind: 'bridge'; run: Run; session: Session; result: CodexBridgeResult; started: boolean; heldForUpdate: boolean }
  | { kind: 'bridge-start-failed'; run: Run; session: Session; handle: CodexBridgeRun; error: unknown };
