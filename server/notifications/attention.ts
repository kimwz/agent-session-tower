import type { DecisionEngine } from '../decisions/engine.js';

/** How a finished turn left things for the owner. `progress` is an intermediate step with nothing for them yet. */
export type TurnOutcome = 'done' | 'needsOwner' | 'blocked' | 'progress';
export interface TurnAttention {
  outcome: TurnOutcome;
  /** True only when the turn is clearly an intermediate step: then no push is sent. */
  quiet: boolean;
}
export interface TurnAttentionInput {
  /** The owner's request this turn works on (for a scheduled continuation, the request that started it). */
  request: string;
  /** The end of what the agent wrote in this turn; its final answer is at the end. */
  reply: string;
  conversation: string;
  project: string;
}

/** Both signals must agree before a push is skipped, so a real result is not lost to one uncertain answer. */
const QUIET_PROGRESS = 0.5;
const QUIET_INTERRUPT = 0.5;
const OUTCOMES = { done: 'done', needs_owner: 'needsOwner', blocked: 'blocked', progress: 'progress' } as const;

const tail = (value: string, length: number) => {
  const text = value.trim();
  return text.length > length ? `…${text.slice(-(length - 1))}` : text;
};
const head = (value: string, length: number) => {
  const text = value.trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

/** Whether the owner should be told now that a conversation turn finished, and how it finished. */
export async function judgeTurn(engine: DecisionEngine, input: TurnAttentionInput, signal?: AbortSignal): Promise<TurnAttention> {
  const answers = await engine.decide({ signal, state: {
    about: 'An AI coding agent finished one turn of work in a conversation with its owner. The owner is notified on their phone only when they need to look now.',
    project: head(input.project, 200), conversation: head(input.conversation, 200),
    owner_request: head(input.request, 2000),
    end_of_agent_output: tail(input.reply, 4000),
  }, questions: {
    outcome: { type: 'choice', instructions: 'How did this turn leave the work, judging by the end of the agent output?', options: {
      done: 'The agent reports that the requested work is finished, or it fully answered the question. There is a result for the owner to look at.',
      needs_owner: 'The agent asks the owner a question or needs a decision, approval, information, credentials or a manual step before it can continue.',
      blocked: 'The agent could not finish: it reports an error, a failing check or a problem it could not resolve.',
      progress: 'An intermediate update: the agent is still working, will continue by itself, waits for background work or a scheduled check, or only reports one step of a larger task. Nothing is needed from the owner yet.',
    } },
    owner_should_know: { type: 'yesNo', instructions: 'Should the owner be interrupted now to read or act on this turn?' },
  } });
  const outcome = OUTCOMES[answers.outcome.choice as keyof typeof OUTCOMES] ?? 'done';
  const quiet = outcome === 'progress' && answers.outcome.probabilities.progress >= QUIET_PROGRESS && answers.owner_should_know.yes < QUIET_INTERRUPT;
  return { outcome: outcome === 'progress' && !quiet ? 'done' : outcome, quiet };
}
