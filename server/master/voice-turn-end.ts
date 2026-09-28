/**
 * Whether the owner, pausing while speaking to the master, has finished what they meant to say. The page asks at each
 * pause (and again as the pause grows or what was written down changes); the web answers with a fast judgment, so a
 * natural pause mid-thought does not send half a request. Without a judgment the page falls back to its own rule.
 */
import { VOICE_TURN_FINISHED, type DecisionRecord } from '../../shared/decisions.js';
import type { DecisionEngine } from '../decisions/engine.js';

/** A judgment slower than this is of no use to a waiting speaker; the page then uses its own rule. */
const JUDGMENT_MS = 2_500;
/** At most this many judgments per voice session in a minute: a stuck page cannot run up the bill. */
const PER_MINUTE = 40;
const CACHED = 64;

export interface TurnEndAnswer {
  /** Probability that the owner has finished, 0–1. */
  finished?: number;
  /** No judgment: the feature is off, the session is not this page's, or the service failed. The page decides. */
  unavailable?: true;
}

const clip = (value: string, length: number) => value.length > length ? `…${value.slice(-(length - 1))}` : value;

export async function judgeTurnEnd(engine: DecisionEngine, input: { text: string; pauseMs: number }, signal?: AbortSignal): Promise<number> {
  const { finished } = await engine.decide({ signal, state: {
    about: 'The owner is speaking to a voice assistant, and has just paused. Speech-to-text wrote down what they said so far; it may lack punctuation and contain small errors. The assistant answers (and starts work) as soon as the owner has finished, so answering too early cuts them off mid-thought.',
    said_so_far: clip(input.text.trim(), 2_000),
    pause_seconds: Math.round(input.pauseMs / 100) / 10,
  }, questions: {
    finished: { type: 'yesNo', instructions: 'Has the owner finished what they wanted to say, so the assistant should answer now rather than keep listening?',
      yes: 'Finished: a complete request, question or answer that reads as whole, with nothing obviously left to add. Short commands count ("deploy it", "배포해 줘", "보여 줘"), as do short replies ("yes", "네", "do it", "that is all"). So does a request already made and then followed by its reason, purpose or an extra item, even when that tail ends in a joining form ("…해 줄래? 그래서 신나게 말할 수 있도록.", "…고쳐 줘, 테스트도 넣고", "…해 줘. 너무 길어서"). Fillers and restarts earlier in the speech (그, 어, 음) are normal for speech and say nothing about the end. The longer the pause after a sentence that could stand on its own, the more likely it is finished.',
      no: 'Not finished: it stops mid-sentence or mid-thought, ends with a filler (um, uh, 음, 어, 그), a joining word or ending (and, so, 그리고, 그래서, -고, -는데, -서, -면) before any request or question has been made, a particle, a list with more items announced, or a request whose object or action has not been said yet.' },
  } });
  return finished.yes;
}

export interface TurnEndDependencies {
  /** The engine for this feature, or nothing when it is off. */
  engine(): DecisionEngine | undefined;
  /** Whether `session` is the voice session the host has now. */
  known(session: string): Promise<boolean>;
  record(entry: Omit<DecisionRecord, 'at'>): void;
  now?(): number;
}

/** Judgments for voice pauses, limited per session and remembered for text already judged at the same pause. */
export class VoiceTurnEnd {
  private readonly calls = new Map<string, number[]>();
  private readonly cache = new Map<string, number>();

  constructor(private readonly dependencies: TurnEndDependencies) {}

  async judge(body: { session?: unknown; text?: unknown; pauseMs?: unknown }): Promise<TurnEndAnswer> {
    const { session, text } = body;
    const pauseMs = typeof body.pauseMs === 'number' && Number.isFinite(body.pauseMs) ? Math.max(0, Math.min(body.pauseMs, 600_000)) : 0;
    if (typeof session !== 'string' || session.length > 200 || typeof text !== 'string' || !text.trim() || text.length > 4_000) return { unavailable: true };
    const engine = this.dependencies.engine();
    if (!engine) return { unavailable: true };
    // Pauses a second apart are judged alike, so a page asking again with the same words is answered from memory.
    const key = JSON.stringify([session, text.trim(), Math.round(pauseMs / 1_000)]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return { finished: cached };
    const now = this.dependencies.now?.() ?? Date.now();
    const recent = (this.calls.get(session) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= PER_MINUTE || !await this.dependencies.known(session).catch(() => false)) return { unavailable: true };
    recent.push(now);
    this.calls.set(session, recent);
    if (this.calls.size > 16) this.calls.delete(this.calls.keys().next().value!);
    const started = performance.now();
    const record = (result: DecisionRecord['result'], probabilities: Record<string, number>, detail?: string) =>
      this.dependencies.record({ feature: 'voiceTurnEnd', subject: text.trim(), result, probabilities, ...(detail ? { detail } : {}), ms: performance.now() - started });
    try {
      const finished = await judgeTurnEnd(engine, { text, pauseMs }, AbortSignal.timeout(JUDGMENT_MS));
      this.cache.set(key, finished);
      if (this.cache.size > CACHED) this.cache.delete(this.cache.keys().next().value!);
      record(finished >= VOICE_TURN_FINISHED ? 'finished' : 'listening', { finished }, `${Math.round(pauseMs / 100) / 10}s pause`);
      return { finished };
    } catch (error) {
      record('failed', {}, error instanceof Error ? error.message : String(error));
      return { unavailable: true };
    }
  }
}
