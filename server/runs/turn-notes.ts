import type { Run, RunInstructions, Session } from '../../shared/types.js';
import { RunError } from './run-records.js';

export const MAX_INSTRUCTIONS = 48_000;
/** Instructions as a turn may carry them, or a 413. */
export function checkedInstructions(value: RunInstructions): RunInstructions {
  if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > MAX_INSTRUCTIONS) throw new RunError('Tower instructions for this turn are invalid or too long.', 413);
  return { text: value.text, ...(value.required ? { required: true } : {}) };
}
const NOTES_MS = 6_000;
type Notes = (run: Run, session: Session) => Promise<string | undefined>;

/**
 * Adds `firstTurnNotes` to a new conversation's first turn and `turnNotes` to every turn. Never delays a turn by more
 * than a few seconds, never fails it, and a turn gets them once however often it is launched.
 */
export class TurnNotes {
  /** Turns that already received their notes. */
  private readonly noted = new Set<string>();
  constructor(private readonly sources: () => { firstTurnNotes?: Notes; turnNotes?: Notes }) {}

  async add(run: Run, session: Session, creating: boolean): Promise<void> {
    if (run.origin?.controllerId || this.noted.has(run.id)) return;
    if (this.noted.size >= 10_000) this.noted.clear();
    this.noted.add(run.id);
    const ask = (notes: Notes | undefined) => notes ? notes(run, session).catch(() => undefined) : Promise.resolve(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { firstTurnNotes, turnNotes } = this.sources();
    const all = Promise.all([creating ? ask(firstTurnNotes) : undefined, ask(turnNotes)]);
    const notes = await Promise.race([all, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), NOTES_MS); })]);
    clearTimeout(timer);
    const text = [run.instructions?.text, ...(notes ?? [])].filter(item => item?.trim()).join('\n\n');
    if (run.status !== 'queued' || !text || text === run.instructions?.text) return;
    if (text.length <= MAX_INSTRUCTIONS) run.instructions = { text, ...(run.instructions?.required ? { required: true } : {}) };
  }
}
