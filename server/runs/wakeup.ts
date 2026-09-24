// Claude's ScheduleWakeup timer lives inside its own process. Tower closes that process when the turn
// ends, so a wakeup the agent scheduled would never fire; Tower reads the call from the turn's events
// and keeps the schedule itself.

type Message = Record<string, any>;
export interface Wakeup { at: number; prompt: string }

const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;
/** Loop sentinels are resolved by the native harness; resumed turns receive a plain instruction instead. */
const SENTINEL = /^<<[\w-]+>>$/;
const SENTINEL_PROMPT = 'Continue the work you scheduled with ScheduleWakeup.';

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
  private wakeup?: Wakeup;

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
        this.wakeup = { at: this.now() + delay * 1000, prompt: (SENTINEL.test(prompt) ? SENTINEL_PROMPT : prompt).slice(0, this.maxPrompt) };
      }
    }
  }

  get pending(): Wakeup | undefined { return this.wakeup && { ...this.wakeup }; }
}
