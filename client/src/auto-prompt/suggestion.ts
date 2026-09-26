import { useEffect, useRef, useState } from 'react';
import { AUTO_PROMPT_SUGGESTION_INTERVAL_MS, AUTO_PROMPT_SUGGESTION_MIN_CHARS, type AutoPromptSuggestion, type AutoPromptSuggestionRequest, type AutoPromptSuggestionResponse, type DecisionFailure } from '../../../shared/decisions';
import type { AutoPromptRequest, Provider } from '../../../shared/types';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { api } from '../common/lib';

/** What a suggestion is about besides the text: it never carries over to another tool, folder or computer. */
export const suggestionContext = (provider: Provider, cwd: string, machine: string | undefined) => JSON.stringify([provider, cwd, machine ?? '']);

/** The draft worth a suggestion, or nothing while it is shorter than the minimum. */
export function suggestionKey(prompt: string, context: string): string | undefined {
  const text = prompt.trim();
  return text.length >= AUTO_PROMPT_SUGGESTION_MIN_CHARS ? JSON.stringify([context, text]) : undefined;
}

export interface SuggestionTiming { requestedKey?: string; startedAt?: number; inFlight: boolean }
/**
 * How long to wait before asking about `key`: nothing when there is nothing new to ask or a request is still out,
 * otherwise at most one request per interval, and the latest draft is always asked about in the end.
 */
export function suggestionWait(key: string | undefined, timing: SuggestionTiming, now: number, interval = AUTO_PROMPT_SUGGESTION_INTERVAL_MS): number | undefined {
  if (!key || timing.inFlight || key === timing.requestedKey) return undefined;
  return timing.startedAt === undefined ? 0 : Math.max(0, timing.startedAt + interval - now);
}

/** Where an accepted suggestion sends the request: straight to that conversation, or a new one in that folder. */
export function suggestionTarget(suggestion: AutoPromptSuggestion): Pick<AutoPromptRequest, 'cwd' | 'sessionMode' | 'targetSessionId'> {
  return suggestion.sessionId ? { cwd: suggestion.cwd, targetSessionId: suggestion.sessionId } : { cwd: suggestion.cwd, sessionMode: 'new' };
}

export interface SuggestionState {
  /** The draft and context it answers; a new draft or another tool, folder or computer never shows it. */
  draft: number;
  context: string;
  label: string;
  suggestion: AutoPromptSuggestion | null;
  loading: boolean;
  error?: DecisionFailure;
}
export interface SuggestionInput {
  enabled: boolean;
  /** While a request is being sent, nothing is asked and nothing shown changes. */
  paused: boolean;
  /** Changes whenever the dialog starts a new draft. */
  draft: number;
  prompt: string;
  provider: Provider;
  cwd: string;
  machine: string | undefined;
}
interface Timers { now(): number; set(run: () => void, ms: number): unknown; clear(timer: unknown): void }
const SUGGESTION_TIMEOUT_MS = 30_000;

/**
 * The suggestion for the Auto Prompt draft being written: asks at most once per interval while the draft changes,
 * starts over for a new draft, a short draft, or another tool, folder or computer, and drops answers meant for
 * any of those.
 */
export class SuggestionFeed {
  private state?: SuggestionState;
  private input?: SuggestionInput & { key?: string; context: string };
  private timing: SuggestionTiming = { inFlight: false };
  private controller?: AbortController;
  private timer?: unknown;

  constructor(private readonly ask: (body: AutoPromptSuggestionRequest, signal: AbortSignal) => Promise<AutoPromptSuggestionResponse>,
    private readonly changed: () => void, private readonly timers: Timers = { now: Date.now, set: (run, ms) => setTimeout(run, ms), clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }) {}

  update(next: SuggestionInput): void {
    const context = suggestionContext(next.provider, next.cwd, next.machine);
    const key = next.enabled ? suggestionKey(next.prompt, context) : undefined;
    const previous = this.input;
    this.input = { ...next, key, context };
    if (!previous || previous.draft !== next.draft || previous.context !== context || !key) this.restart();
    else if (next.paused && !previous.paused) this.stopAsking();
    this.schedule();
  }

  /** What to show for `input` right now; nothing that belongs to another draft, context or a too-short draft. */
  view(input: SuggestionInput): SuggestionState | undefined {
    const context = suggestionContext(input.provider, input.cwd, input.machine);
    const key = input.enabled ? suggestionKey(input.prompt, context) : undefined;
    return key && this.state?.draft === input.draft && this.state.context === context ? this.state : undefined;
  }

  /**
   * Cancels everything for an unmounted dialog. The next `update` starts afresh, as React's development mode does when
   * it runs a component's effects a second time.
   */
  stop(): void { this.stopAsking(); this.input = undefined; }

  private restart(): void {
    this.stopAsking();
    this.timing = { inFlight: false };
    if (this.state) { this.state = undefined; this.changed(); }
  }

  /** Cancels what is out without forgetting what is shown; the same draft is asked about again later. */
  private stopAsking(): void {
    if (this.timer !== undefined) { this.timers.clear(this.timer); this.timer = undefined; }
    this.controller?.abort();
    this.controller = undefined;
    this.timing = { ...this.timing, inFlight: false, requestedKey: undefined };
    if (this.state?.loading) { this.state = { ...this.state, loading: false }; this.changed(); }
  }

  private schedule(): void {
    if (this.timer !== undefined) { this.timers.clear(this.timer); this.timer = undefined; }
    const input = this.input;
    if (!input || input.paused) return;
    const wait = suggestionWait(input.key, this.timing, this.timers.now());
    if (wait === undefined) return;
    this.timer = this.timers.set(() => { this.timer = undefined; this.request(); }, wait);
  }

  private request(): void {
    const input = this.input;
    if (!input?.key || input.paused) return;
    const controller = new AbortController();
    this.controller = controller;
    this.timing = { requestedKey: input.key, startedAt: this.timers.now(), inFlight: true };
    const mine = { draft: input.draft, context: input.context };
    const same = this.state && this.state.draft === mine.draft && this.state.context === mine.context ? this.state : undefined;
    this.state = { ...mine, label: same?.label ?? '', suggestion: same?.suggestion ?? null, loading: true };
    this.changed();
    const deadline = this.timers.set(() => controller.abort(), SUGGESTION_TIMEOUT_MS);
    const body: AutoPromptSuggestionRequest = { prompt: input.prompt, provider: input.provider, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.machine ? { node: input.machine } : {}) };
    const current = () => this.controller === controller;
    this.ask(body, controller.signal)
      .then(response => {
        if (!current()) return;
        this.state = response.available ? { ...mine, label: response.label, suggestion: response.suggestion, loading: false, ...(response.error ? { error: response.error } : {}) } : undefined;
      })
      .catch(() => {
        if (!current()) return;
        this.state = { ...mine, label: this.state?.label ?? '', suggestion: this.state?.suggestion ?? null, loading: false, error: 'unavailable' };
      })
      .finally(() => {
        this.timers.clear(deadline);
        if (!current()) return;
        this.controller = undefined;
        this.timing = { ...this.timing, inFlight: false };
        this.changed();
        this.schedule();
      });
  }
}

/** The dialog's suggestion, kept by one SuggestionFeed for the dialog's lifetime. */
export function useAutoPromptSuggestion(input: SuggestionInput & { token: string }): SuggestionState | undefined {
  const [, rerender] = useState(0);
  const token = useRef(input.token);
  token.current = input.token;
  const feed = useRef<SuggestionFeed | undefined>(undefined);
  feed.current ??= new SuggestionFeed(
    (body, signal) => api<AutoPromptSuggestionResponse>('/api/auto-prompt-suggestions', { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token.current }, body: JSON.stringify(body), signal }),
    () => rerender(value => value + 1));
  const { enabled, paused, draft, prompt, provider, cwd, machine } = input;
  const usable = enabled && Boolean(input.token);
  useEffect(() => { feed.current!.update({ enabled: usable, paused, draft, prompt, provider, cwd, machine }); }, [usable, paused, draft, prompt, provider, cwd, machine]);
  useEffect(() => () => feed.current!.stop(), []);
  return feed.current.view({ enabled: usable, paused, draft, prompt, provider, cwd, machine });
}
