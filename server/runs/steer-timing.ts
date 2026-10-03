/**
 * Whether a message the owner sends while a turn runs belongs to that work and goes into it now, or is a separate
 * request that waits for the turn to end. The web decides with a fast judgment and inserts through the worker's own
 * steering, which still checks everything an insert needs; waiting is what happens without a judgment.
 */
import type { Run } from '../../shared/types.js';
import type { DecisionEngine } from '../decisions/engine.js';
import type { DecisionRecord } from '../../shared/decisions.js';

/**
 * A message is inserted only when this sure it belongs to the work in progress. Measured on the owner's own inserted
 * and waiting messages and made-up ones: no separate request went above 0.43, and every message about the current
 * work but one reached 0.66 or more. A wrong insert cannot be taken back; a message left waiting just runs next.
 */
export const INSERT_NOW = 0.6;
const JUDGMENT_MS = 6_000;
/** Only a message accepted just now is judged; a retried request that returns an older one is left as it is. */
export const FRESH_MS = 30_000;
/**
 * How long to follow an insert before recording how it ended. Claude confirms one only when it takes it at its next
 * step, and a long reply or tool call can put that minutes away.
 */
const SETTLE_MS = 30 * 60_000;
const SETTLE_POLL_MS = 1_000;

export interface SteerTimingInput {
  /** What the running turn was asked to do. */
  currentRequest: string;
  /** What the agent has written in that turn so far. */
  currentOutput: string;
  /** The message just sent. */
  message: string;
}
export interface SteerTiming { now: number; after: number; insert: boolean }

const clip = (value: string, length: number) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
const tail = (value: string, length: number) => value.length > length ? `…${value.slice(-(length - 1))}` : value;
/** Tower writes each Claude tool call into a turn's output as `[ToolName]` and a line break. */
const withoutToolMarks = (output: string) => output.replace(/\[[A-Za-z0-9_:.-]{1,100}\]\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export async function judgeSteerTiming(engine: DecisionEngine, input: SteerTimingInput, signal?: AbortSignal): Promise<SteerTiming> {
  const { timing } = await engine.decide({ signal, state: {
    about: 'An AI coding agent is in the middle of a turn of work for its owner. The owner has just sent another message to the same conversation.',
    current_request: clip(input.currentRequest.trim(), 2000),
    agent_progress_so_far: tail(withoutToolMarks(input.currentOutput), 1500),
    new_message: clip(input.message.trim(), 2000),
  }, questions: {
    timing: { type: 'choice', instructions: 'The owner sent new_message while the agent is still working on current_request. Should the agent read it now, in the middle of that work, or only after that work is finished?', options: {
      now: 'It belongs to the work in progress: it corrects, redirects, narrows, pauses or stops it, adds a detail or a finishing step to it (such as "also add tests" or "then deploy it"), or answers something the agent asked. The agent should read it before going on.',
      after: 'It is a separate request: a different task, project or question that is not part of the current work, so it should wait until the current work is finished.',
    } },
  } });
  const now = timing.probabilities.now ?? 0;
  return { now, after: timing.probabilities.after ?? 0, insert: now >= INSERT_NOW };
}

export interface InsertDependencies {
  /** The engine for this feature, or nothing when it is off. */
  engine(): DecisionEngine | undefined;
  /** Whether the execution worker can insert into one chosen turn only; without that nothing is judged. */
  canTarget(): boolean;
  runs(): readonly Run[];
  /** Inserts into exactly `targetRunId`, or refuses. */
  steer(runId: string, targetRunId: string): Promise<Run>;
  record(entry: Omit<DecisionRecord, 'at'>): void;
  /** True the first time a message is offered; each message is judged at most once. */
  claim(runId: string): boolean;
  /**
   * This computer's link ID, when the message went from its page to a joined computer's conversation. Only a message
   * this computer sent there is judged here; that computer leaves messages from its controllers to them.
   */
  sentBy?: string;
  now?(): number;
  wait?(ms: number): Promise<void>;
}
export type InsertOutcome = 'inserted' | 'waiting' | 'uncertain' | 'skipped';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Judges a message just queued in a conversation whose turn is running, and inserts it into that same turn when it
 * belongs to the work. A refusal (the turn ended or changed, or the message cannot join it) leaves it waiting, as
 * without a judgment; a delivery that could not be confirmed is left for the owner to check and never sent again.
 */
export async function insertIfItBelongs(dependencies: InsertDependencies, queued: Run): Promise<InsertOutcome> {
  const engine = dependencies.engine();
  const now = dependencies.now?.() ?? Date.now();
  // Only the page of the computer that judges: the one the owner uses, whether the conversation runs here or on a
  // computer it joined. A computer controlled from elsewhere never judges its controllers' messages itself, since a
  // controller retries a request with the same ID and gets the message back.
  if (!engine || !dependencies.canTarget() || queued.status !== 'queued' || queued.origin?.kind !== 'owner' || queued.origin.controllerId !== dependencies.sentBy
    || queued.scheduled || queued.steering) return 'skipped';
  if (!(now - Date.parse(queued.createdAt) <= FRESH_MS) || !dependencies.claim(queued.id)) return 'skipped';
  const runs = dependencies.runs();
  // The worker says whether this message could join the running turn at all (same origin, model and effort).
  if (runs.find(run => run.id === queued.id)?.canSteer === false) return 'skipped';
  const target = runs.find(run => run.sessionId === queued.sessionId && run.status === 'running' && !run.steering);
  // A turn that only waits for background work takes owner messages by itself.
  if (!target || target.backgroundWait) return 'skipped';
  const started = performance.now();
  const subject = queued.prompt.trim() || queued.attachments?.map(file => file.name).join(', ') || '';
  const record = (result: DecisionRecord['result'], probabilities: Record<string, number>, detail?: string) =>
    dependencies.record({ feature: 'steerTiming', subject, result, probabilities, ...(detail ? { detail } : {}), ms: performance.now() - started });
  let judged: SteerTiming;
  try {
    judged = await judgeSteerTiming(engine, { currentRequest: target.prompt, currentOutput: target.output, message: queued.prompt }, AbortSignal.timeout(JUDGMENT_MS));
  } catch (error) {
    record('failed', {}, message(error));
    return 'waiting';
  }
  const probabilities = { now: judged.now, after: judged.after };
  if (!judged.insert) { record('waiting', probabilities); return 'waiting'; }
  let inserted: Run;
  try {
    inserted = await dependencies.steer(queued.id, target.id);
  } catch (error) {
    if ((error as { disposition?: unknown }).disposition === 'uncertain') {
      record('failed', probabilities, `Delivery could not be confirmed; the conversation shows what arrived. ${message(error)}`);
      return 'uncertain';
    }
    record('waiting', probabilities, message(error));
    return 'waiting';
  }
  // Another request (such as the owner's own click) may be inserting the same message: record how that ends.
  const state = await settled(dependencies, queued.id, inserted);
  if (state === 'delivered') { record('inserted', probabilities); return 'inserted'; }
  record('failed', probabilities, state === 'uncertain' ? 'Delivery could not be confirmed; the conversation shows what arrived.' : 'The insert was not confirmed in time; the conversation shows what arrived.');
  return 'uncertain';
}

/**
 * Judges a message without making anyone wait. Judgment failures, waits and uncertain deliveries are recorded by the
 * judgment itself; only an unexpected error reaches here, and it is logged without the message or a claim about
 * whether the message arrived.
 */
export function insertInBackground(dependencies: InsertDependencies, queued: Run, log: (line: string) => void = console.error): void {
  void insertIfItBelongs(dependencies, queued).catch(error => log(`Judging whether a message belongs to the running turn ended with an unexpected error: ${message(error)}`));
}

async function settled(dependencies: InsertDependencies, runId: string, returned: Run): Promise<'delivered' | 'uncertain' | 'unknown'> {
  const wait = dependencies.wait ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const deadline = (dependencies.now?.() ?? Date.now()) + SETTLE_MS;
  let run: Run | undefined = returned;
  for (;;) {
    const state = run?.steering?.state;
    if (state === 'delivered') return 'delivered';
    if (state === 'uncertain' || run?.status === 'error') return 'uncertain';
    if ((dependencies.now?.() ?? Date.now()) >= deadline) return 'unknown';
    await wait(SETTLE_POLL_MS);
    run = dependencies.runs().find(item => item.id === runId);
  }
}
