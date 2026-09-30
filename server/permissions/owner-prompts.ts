import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/** Enough for long conversations; beyond it a conversation's record is incomplete and the reviewer leaves it to the owner. */
const MAX_SESSION_CHARS = 400_000;
const MAX_SESSIONS = 400;
const MAX_BYTES = 40_000_000;

interface Entry { prompts: { at: string; text: string }[]; complete: boolean; updatedAt: string }
interface State { version: 1; sessions: Record<string, Entry> }

/**
 * What the owner typed in Tower, per conversation, in `<state>/owner-prompts.json`. Run history keeps only the latest
 * runs, so the owner's earlier words (a restriction, say) would fall out of it; Tower's permission reviewer reads them
 * from here. The record of a conversation is whole only when it was kept from the conversation's start in Tower: one
 * started elsewhere or before this record existed, one too long, or one forgotten to make room says it is not.
 */
export class OwnerPromptStore {
  private state: State = { version: 1, sessions: {} };
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) { this.path = join(stateDir, 'owner-prompts.json'); }

  async start(): Promise<void> {
    try {
      const saved = await readPrivateJson(this.path, MAX_BYTES) as Partial<State>;
      const sessions: Record<string, Entry> = {};
      for (const [id, entry] of Object.entries(saved?.sessions ?? {})) {
        if (!entry || !Array.isArray(entry.prompts)) continue;
        sessions[id] = { prompts: entry.prompts.filter(item => item && typeof item.text === 'string' && typeof item.at === 'string'), complete: entry.complete !== false,
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '' };
      }
      this.state = { version: 1, sessions };
    } catch (error) {
      // An unreadable record starts over: the conversations it held are unknown (not whole); those begun from now on are.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Owner prompt record was unreadable and starts over: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The owner's prompts in a conversation, oldest first, and whether that is all of them. */
  list(sessionId: string): { prompts: { at: string; text: string }[]; complete: boolean } {
    const entry = this.state.sessions[sessionId];
    return entry ? { prompts: entry.prompts.map(item => ({ ...item })), complete: entry.complete } : { prompts: [], complete: false };
  }

  /**
   * The owner's words for one run, at once: the conversation's start (Tower created it), what the owner typed, or that
   * owner work arrived which was not typed here. A record that could not be saved is not whole from then on.
   */
  record(sessionId: string, at: string, input: { begin?: boolean; text?: string; taint?: boolean }): Promise<void> {
    return this.change(state => {
      if (input.begin && !state.sessions[sessionId]) state.sessions[sessionId] = { prompts: [], complete: true, updatedAt: at };
      const entry = state.sessions[sessionId] ?? { prompts: [], complete: false, updatedAt: at };
      if (input.text !== undefined) entry.prompts.push({ at, text: input.text });
      if (input.taint) entry.complete = false;
      entry.updatedAt = at;
      while (entry.prompts.reduce((sum, item) => sum + item.text.length, 0) > MAX_SESSION_CHARS && entry.prompts.length > 1) { entry.prompts.splice(1, 1); entry.complete = false; }
      state.sessions[sessionId] = entry;
    }).catch(error => {
      // Kept in memory at least, and saved with the next record that succeeds.
      const entry = this.state.sessions[sessionId] ?? { prompts: [], complete: false, updatedAt: at };
      entry.complete = false;
      this.state.sessions[sessionId] = entry;
      throw error;
    });
  }

  /** A change is kept only once saved. */
  private change(apply: (state: State) => void): Promise<void> {
    const next = this.queue.catch(() => {}).then(async () => {
      const state = structuredClone(this.state);
      apply(state);
      // Room is made by forgetting whole conversations (they are then not whole, so the owner decides there): first those
      // the owner never typed in, then the oldest.
      const order = () => Object.keys(state.sessions).sort((a, b) => Number(state.sessions[a]!.prompts.length > 0) - Number(state.sessions[b]!.prompts.length > 0)
        || state.sessions[a]!.updatedAt.localeCompare(state.sessions[b]!.updatedAt));
      for (const id of order().slice(0, Math.max(0, Object.keys(state.sessions).length - MAX_SESSIONS))) delete state.sessions[id];
      let text = JSON.stringify(state);
      while (Buffer.byteLength(text) > MAX_BYTES / 2 && Object.keys(state.sessions).length > 1) {
        delete state.sessions[order()[0]!];
        text = JSON.stringify(state);
      }
      await writePrivateJson(this.path, text);
      this.state = state;
    });
    this.queue = next;
    return next;
  }

  async flush(): Promise<void> { await this.queue.catch(() => {}); }
}
