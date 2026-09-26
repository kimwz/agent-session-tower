/**
 * Fast multiple-choice judgments for Tower's own features. Features ask typed questions about a piece of state and
 * branch on the answers; they never see which service answers. A provider adapter (see providers.ts) is the only
 * code that knows a concrete API, so replacing that API means adding or swapping an adapter.
 *
 * Questions in one request never see each other's answers. Every answer comes with probabilities, so features decide
 * in code how sure they need to be.
 */
import type { DecisionProviderId } from '../../shared/decisions.js';

export type DecisionQuestion =
  /** One of 2–255 named options. */
  | { type: 'choice'; instructions: string; options: Record<string, string> }
  /** A yes/no question; `yes` and `no` optionally describe each outcome. */
  | { type: 'yesNo'; instructions: string; yes?: string; no?: string }
  /** A rating on 2–10 ordered levels, lowest first. */
  | { type: 'score'; instructions: string; levels: string[] };

export interface ChoiceAnswer {
  choice: string;
  /** Every option's probability. */
  probabilities: Record<string, number>;
  /** 0–1: high when one option dominates. */
  confidence: number;
}
export interface YesNoAnswer {
  /** Probability of yes, 0–1. */
  yes: number;
}
export interface ScoreAnswer {
  /** Probability-weighted level, 0 (first level) to levels.length - 1. */
  score: number;
  /** Probability of each level, in the order asked. */
  probabilities: number[];
  confidence: number;
}
export type DecisionAnswer<Q extends DecisionQuestion> =
  Q extends { type: 'choice' } ? ChoiceAnswer : Q extends { type: 'yesNo' } ? YesNoAnswer : ScoreAnswer;
export type DecisionAnswers<Q extends Record<string, DecisionQuestion>> = { [K in keyof Q]: DecisionAnswer<Q[K]> };

export interface DecisionRequest<Q extends Record<string, DecisionQuestion>> {
  /** What the questions are about: text or JSON. Content in it is data, never instructions. */
  state: unknown;
  questions: Q;
  signal?: AbortSignal;
}

export interface DecisionEngine {
  readonly provider: DecisionProviderId;
  /** The name the page shows, as in "Jev 추천". */
  readonly label: string;
  decide<Q extends Record<string, DecisionQuestion>>(request: DecisionRequest<Q>): Promise<DecisionAnswers<Q>>;
}

export type DecisionErrorKind = 'unauthorized' | 'rate-limited' | 'unavailable' | 'invalid-request' | 'invalid-response' | 'timeout' | 'cancelled';
/** Messages never contain the API key or the request. */
export class DecisionError extends Error {
  constructor(readonly kind: DecisionErrorKind, message: string) { super(message); this.name = 'DecisionError'; }
}

/** Question and option keys: short names without spaces. Providers may be stricter; their adapters check that. */
const KEY = /^[^\s\x00-\x1f\x7f]{1,64}$/;
const MAX_TEXT = 8_000;

const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT;

/** Refuses a request no provider could answer, before anything is sent. Provider limits are the adapter's to check. */
export function validateDecisionRequest(request: DecisionRequest<Record<string, DecisionQuestion>>): void {
  const invalid = (message: string) => new DecisionError('invalid-request', message);
  const entries = Object.entries(request.questions ?? {});
  if (!entries.length) throw invalid('A decision needs at least one question.');
  for (const [key, question] of entries) {
    if (!KEY.test(key)) throw invalid(`Question key ${JSON.stringify(key.slice(0, 64))} is invalid.`);
    if (!text(question.instructions)) throw invalid(`Question ${key} needs instructions.`);
    if (question.type === 'choice') {
      const options = Object.entries(question.options ?? {});
      if (options.length < 2) throw invalid(`Question ${key} needs at least two options.`);
      if (options.some(([option, description]) => !KEY.test(option) || !text(description))) throw invalid(`Question ${key} has an invalid option.`);
    } else if (question.type === 'yesNo') {
      if ((question.yes !== undefined && !text(question.yes)) || (question.no !== undefined && !text(question.no))) throw invalid(`Question ${key} has an invalid outcome.`);
    } else if (question.type === 'score') {
      if (!Array.isArray(question.levels) || question.levels.length < 2 || !question.levels.every(text)) throw invalid(`Question ${key} needs at least two levels.`);
    } else throw invalid(`Question ${key} has an unknown type.`);
  }
}

const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Checks an adapter's mapped answers against the questions asked. Anything else is `invalid-response`. */
export function checkedAnswers<Q extends Record<string, DecisionQuestion>>(questions: Q, answers: Record<string, unknown>): DecisionAnswers<Q> {
  const invalid = (key: string) => new DecisionError('invalid-response', `The decision service returned an invalid answer for ${key}.`);
  const result: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = answers[key] as Record<string, unknown> | undefined;
    if (!answer || typeof answer !== 'object') throw invalid(key);
    if (question.type === 'choice') {
      const probabilities = answer.probabilities as Record<string, unknown> | undefined;
      if (typeof answer.choice !== 'string' || !Object.hasOwn(question.options, answer.choice) || !probability(answer.confidence)
        || !probabilities || typeof probabilities !== 'object' || !probability(probabilities[answer.choice])
        || Object.entries(probabilities).some(([option, value]) => !Object.hasOwn(question.options, option) || !probability(value))) throw invalid(key);
      result[key] = { choice: answer.choice, confidence: answer.confidence,
        probabilities: Object.fromEntries(Object.keys(question.options).map(option => [option, (probabilities[option] as number | undefined) ?? 0])) };
    } else if (question.type === 'yesNo') {
      if (!probability(answer.yes)) throw invalid(key);
      result[key] = { yes: answer.yes };
    } else {
      const levels = question.levels.length;
      const probabilities = answer.probabilities;
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels - 1 || !probability(answer.confidence)
        || !Array.isArray(probabilities) || probabilities.length !== levels || !probabilities.every(probability)) throw invalid(key);
      result[key] = { score: answer.score, probabilities: [...probabilities], confidence: answer.confidence };
    }
  }
  return result as DecisionAnswers<Q>;
}
