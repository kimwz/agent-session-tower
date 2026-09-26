// Claude's ScheduleWakeup timer lives inside its own process. Tower closes that process when the turn
// ends, so a wakeup the agent scheduled would never fire; Tower reads the call from the turn's events
// and keeps the schedule itself.

import { isTaskNotification } from '../../shared/task-notification.js';

type Message = Record<string, any>;
/** How Tower's own messages to Claude begin; they are never a native wakeup. */
export const TOWER_NOTICE = '[Agent Session Tower]';
export interface Wakeup { at: number; prompt: string }

const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;
/** Loop sentinels are resolved by the native harness; resumed turns receive a plain instruction instead. */
const SENTINEL = /^<<[\w-]+>>$/;
const SENTINEL_PROMPT = 'Continue the work you scheduled with ScheduleWakeup.';
/** Claude rounds its timer to a minute boundary and reports it; allow for that and for clock drift. */
const NATIVE_SLACK_MS = 30_000;

const record = (value: unknown): value is Message => !!value && typeof value === 'object' && !Array.isArray(value);

function delaySeconds(input: Message, result: unknown): number | undefined {
  // The native reply reports the delay it actually scheduled, rounded to its minute boundary.
  const text = typeof result === 'string' ? result
    : Array.isArray(result) ? result.map(item => record(item) && typeof item.text === 'string' ? item.text : '').join('\n') : '';
  const reported = Number(/\(in (\d+)s\)/.exec(text)?.[1]);
  if (Number.isSafeInteger(reported) && reported > 0 && reported <= MAX_DELAY_S + 120) return reported;
  const requested = Number(input.delaySeconds);
  return Number.isFinite(requested) ? Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(requested))) : undefined;
}

/** Follows ScheduleWakeup calls of one turn's main conversation; the last accepted call wins. */
export class WakeupTracker {
  private readonly calls = new Map<string, Message>();
  private wakeup?: Wakeup & { raw: string; sentinel: boolean };

  constructor(private readonly maxPrompt: number, private readonly now = () => Date.now()) {}

  observe(event: Message): void {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!record(block)) continue;
      if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'ScheduleWakeup' && typeof block.id === 'string' && record(block.input)) {
        this.calls.set(block.id, block.input);
      } else if (event.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const input = this.calls.get(block.tool_use_id);
        if (!input) continue;
        this.calls.delete(block.tool_use_id);
        if (block.is_error === true) continue;
        if (input.stop === true) { this.wakeup = undefined; continue; }
        const delay = delaySeconds(input, block.content);
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
        if (delay === undefined || !prompt) continue;
        const sentinel = SENTINEL.test(prompt);
        this.wakeup = { at: this.now() + delay * 1000, prompt: (sentinel ? SENTINEL_PROMPT : prompt).slice(0, this.maxPrompt), raw: prompt, sentinel };
      }
    }
  }

  /**
   * Tower keeps Claude's process open while background work runs, so Claude's own timer may fire in it. Claude replays
   * the prompt it resumes with; once that happens Tower must not schedule the wakeup again. A loop sentinel is replaced
   * by instructions Tower cannot match, so for it any other replayed message at or after the time counts.
   */
  observeReplay(text: string): void {
    if (!this.wakeup) return;
    const replayed = text.trim();
    if (replayed === this.wakeup.raw || (this.wakeup.sentinel && this.now() >= this.wakeup.at - NATIVE_SLACK_MS && !isTaskNotification(replayed) && !replayed.startsWith(TOWER_NOTICE))) this.wakeup = undefined;
  }

  get pending(): Wakeup | undefined { return this.wakeup && { at: this.wakeup.at, prompt: this.wakeup.prompt }; }
}
