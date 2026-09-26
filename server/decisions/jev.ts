/** TypeSafe's Jev behind Tower's decision contract. Nothing outside server/decisions knows this API. */
import { checkedAnswers, DecisionError, validateDecisionRequest, type DecisionAnswers, type DecisionEngine, type DecisionQuestion, type DecisionRequest } from './engine.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const TIMEOUT_MS = 8_000;
/**
 * Jev's own limits: up to 255 options per choice and 10 score levels. The state with the longest question must fit
 * in about 32k tokens and all questions together in about 64k; these character budgets stay under that.
 */
export const JEV_MAX_OPTIONS = 255;
export const JEV_MAX_LEVELS = 10;
export const JEV_MAX_STATE_AND_QUESTION_CHARS = 110_000;
export const JEV_MAX_QUESTIONS_CHARS = 220_000;
const JEV_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** What Jev refuses, checked before sending so a feature learns it without a round trip. */
export function checkJevLimits(request: DecisionRequest<Record<string, DecisionQuestion>>): string {
  const invalid = (message: string) => new DecisionError('invalid-request', message);
  for (const [key, question] of Object.entries(request.questions)) {
    if (!JEV_KEY.test(key)) throw invalid(`Jev cannot take the question key ${JSON.stringify(key)}.`);
    if (question.type === 'choice') {
      const options = Object.keys(question.options);
      if (options.length > JEV_MAX_OPTIONS) throw invalid(`Jev takes at most ${JEV_MAX_OPTIONS} options per question.`);
      if (options.some(option => !JEV_KEY.test(option))) throw invalid(`Jev cannot take an option key of question ${key}.`);
    }
    if (question.type === 'score' && question.levels.length > JEV_MAX_LEVELS) throw invalid(`Jev takes at most ${JEV_MAX_LEVELS} score levels.`);
  }
  const state = JSON.stringify(request.state ?? null);
  const sizes = Object.values(request.questions).map(question => JSON.stringify(jevQuestion(question)).length);
  if (state.length + Math.max(...sizes) > JEV_MAX_STATE_AND_QUESTION_CHARS || sizes.reduce((sum, size) => sum + size, 0) > JEV_MAX_QUESTIONS_CHARS) throw invalid('The decision is too large for Jev.');
  return state;
}

type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export function jevQuestion(question: DecisionQuestion): JevQuestion {
  if (question.type === 'choice') return { type: 'choice', instructions: question.instructions, criteria: { ...question.options } };
  if (question.type === 'score') return { type: 'score', instructions: question.instructions, criteria: [...question.levels] };
  return { type: 'noul', instructions: question.instructions,
    ...(question.yes !== undefined || question.no !== undefined ? { criteria: { true: question.yes ?? 'Yes.', false: question.no ?? 'No.' } } : {}) };
}

/** Jev's answers in the contract's shape; checkedAnswers then rejects anything that does not fit the questions. */
export function fromJevAnswers(questions: Record<string, DecisionQuestion>, answers: unknown): Record<string, unknown> {
  const source = answers && typeof answers === 'object' ? answers as Record<string, Record<string, unknown> | undefined> : {};
  const mapped: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = source[key];
    if (!answer || typeof answer !== 'object') continue;
    if (question.type === 'yesNo') { if (answer.type === 'noul') mapped[key] = { yes: answer.noul }; continue; }
    if (question.type === 'choice') { if (answer.type === 'choice') mapped[key] = { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence }; continue; }
    if (answer.type !== 'score') continue;
    // Jev keys each level's probability by its index as a string.
    // A level missing from the answer leaves a hole that the contract check refuses.
    const byLevel = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities as Record<string, unknown> : {};
    mapped[key] = { score: answer.score, confidence: answer.confidence, probabilities: question.levels.map((_, index) => byLevel[String(index)]) };
  }
  return mapped;
}

export class JevEngine implements DecisionEngine {
  readonly provider = 'jev' as const;
  readonly label = 'Jev';

  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = TIMEOUT_MS) {}

  async decide<Q extends Record<string, DecisionQuestion>>(request: DecisionRequest<Q>): Promise<DecisionAnswers<Q>> {
    validateDecisionRequest(request);
    const state = checkJevLimits(request);
    const questions = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, jevQuestion(question)]));
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(JEV_ENDPOINT, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: `{"model":${JSON.stringify(MODEL)},"state":${state},"questions":${JSON.stringify(questions)}}`,
      });
    } catch {
      if (request.signal?.aborted) throw new DecisionError('cancelled', 'The decision was cancelled.');
      if (timeout.aborted) throw new DecisionError('timeout', 'Jev did not answer in time.');
      throw new DecisionError('unavailable', 'Jev could not be reached.');
    }
    let body: unknown;
    try { body = JSON.parse(await response.text()); } catch { body = undefined; }
    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) throw new DecisionError('unauthorized', 'Jev rejected the API key.');
      if (status === 429) throw new DecisionError('rate-limited', 'Jev is limiting requests. Try again shortly.');
      if (status === 400 || status === 422) throw new DecisionError('invalid-request', `Jev refused the request (HTTP ${status}).`);
      throw new DecisionError('unavailable', `Jev is unavailable (HTTP ${status}).`);
    }
    return checkedAnswers(request.questions, fromJevAnswers(request.questions, (body as { answers?: unknown } | undefined)?.answers));
  }
}
