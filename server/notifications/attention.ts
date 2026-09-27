import type { DecisionEngine } from '../decisions/engine.js';
import type { SessionOutcome } from '../../shared/types.js';

/** How a finished turn left things for the owner. `progress` is an intermediate step with nothing for them yet. */
export type TurnOutcome = SessionOutcome;
export interface TurnAttention {
  outcome: TurnOutcome;
  /** True only when the turn is clearly an intermediate step: then no push is sent. */
  quiet: boolean;
  /** How likely each outcome was, as the judgment gave it. */
  probabilities: Record<TurnOutcome, number>;
}
export interface TurnAttentionInput {
  /** The owner's request this turn works on (for a scheduled continuation, the request that started it). */
  request: string;
  /** What the agent wrote during this turn, as Tower recorded it; its last message is at the end. */
  output: string;
  conversation: string;
  project: string;
}

/**
 * A push is skipped only when the turn's last message clearly says the agent is not done and carries on by itself.
 * Measured on 59 of the owner's real turns (all worth a push) and on made-up intermediate ones that follow some
 * narration: no real turn went above 0.50, and every intermediate one was at least 0.99.
 */
export const QUIET_CONTINUING = 0.8;
const OUTCOMES = { finished: 'done', asks_owner: 'needsOwner', failed: 'blocked', continuing: 'progress' } as const;

const tail = (value: string, length: number) => {
  const text = value.trim();
  return text.length > length ? `…${text.slice(-(length - 1))}` : text;
};
const head = (value: string, length: number) => {
  const text = value.trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

/**
 * A turn's output as the judgment reads it: Tower writes each Claude tool call into it as `[ToolName]` and a line
 * break; those marks are blanked and nothing else is removed, so a reply that quotes such a line keeps all its text.
 */
export function turnOutput(output: string): string {
  return output.replace(/\[[A-Za-z0-9_:.-]{1,100}\]\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Whether the owner should be told now that a conversation turn ended, and how it ended. */
export async function judgeTurn(engine: DecisionEngine, input: TurnAttentionInput, signal?: AbortSignal): Promise<TurnAttention> {
  const { turn_end } = await engine.decide({ signal, state: {
    about: 'An AI coding agent ended one turn of work in a conversation with its owner.',
    project: head(input.project, 200), conversation: head(input.conversation, 200),
    owner_request: head(input.request, 2000),
    end_of_turn_output: tail(turnOutput(input.output), 4000),
  }, questions: {
    turn_end: { type: 'choice', instructions: 'The end_of_turn_output is the end of what the agent wrote during this turn, with its last message at the very end. How does that last message leave things for the owner?', options: {
      finished: 'It reports the requested work as done or answers the question, possibly with notes, caveats, remaining steps or suggestions.',
      asks_owner: 'It asks the owner to choose, approve, answer, confirm or do something.',
      failed: 'It says the work could not be done or stopped on an error it could not fix.',
      continuing: 'It says the work is not finished yet and that the agent itself will continue, or is waiting for something it started to finish, and it gives no result yet.',
    } },
  } });
  const probabilities = Object.fromEntries(Object.entries(OUTCOMES).map(([option, outcome]) => [outcome, turn_end.probabilities[option] ?? 0])) as Record<TurnOutcome, number>;
  const quiet = probabilities.progress >= QUIET_CONTINUING;
  const chosen = OUTCOMES[turn_end.choice as keyof typeof OUTCOMES] ?? 'done';
  return { outcome: chosen === 'progress' && !quiet ? 'done' : chosen, quiet, probabilities };
}
