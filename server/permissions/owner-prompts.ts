import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/** Enough for long conversations; beyond it a conversation's record is incomplete and the reviewer leaves it to the owner. */
const MAX_SESSION_CHARS = 400_000;
const MAX_SESSIONS = 400;
const MAX_BYTES = 40_000_000;

interface Entry { prompts: { at: string; text: string }[]; complete: boolean; updatedAt: string }
interface State { version: 1; sessions: Record<string, Entry>; forgotten: string[] }

/**
 * What the owner typed in Tower, per conversation, in `<state>/owner-prompts.json`. Run history keeps only the latest
 * runs, so the owner's earlier words (a restriction, say) would fall out of it; Tower's permission reviewer reads them
 * from here. The record of a conversation is whole only when it was kept from the conversation's start in Tower: one
 * started elsewhere or before this record existed, one too long, or one forgotten to make room says it is not.
 */
export class OwnerPromptStore {
  private state: State = { version: 1, sessions: {}, forgotten: [] };
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
      this.state = { version: 1, sessions, forgotten: Array.isArray(saved?.forgotten) ? saved.forgotten.filter((id): id is string => typeof id === 'string') : [] };
    } catch (error) {
      // An unreadable record is started over, with nothing taken as complete for conversations it held.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.state.forgotten = ['*'];
    }
  }

  /** The owner's prompts in a conversation, oldest first, and whether that is all of them. */
  list(sessionId: string): { prompts: { at: string; text: string }[]; complete: boolean } {
    const entry = this.state.sessions[sessionId];
    const forgotten = this.state.forgotten.includes(sessionId) || this.state.forgotten.includes('*');
    return entry ? { prompts: entry.prompts.map(item => ({ ...item })), complete: entry.complete && !forgotten } : { prompts: [], complete: false };
  }

  /** Tower created this conversation: its record starts here, whole, whoever started it. */
  begin(sessionId: string, at: string): Promise<void> {
    return this.change(() => { if (!this.state.sessions[sessionId]) this.state.sessions[sessionId] = { prompts: [], complete: true, updatedAt: at }; });
  }

  add(sessionId: string, at: string, text: string): Promise<void> {
    return this.change(() => {
      // A conversation Tower did not see start may hold earlier words of the owner this record never had.
      const entry = this.state.sessions[sessionId] ?? { prompts: [], complete: false, updatedAt: at };
      entry.prompts.push({ at, text });
      entry.updatedAt = at;
      // Too long: the oldest after the first go, and the record says it is no longer whole.
      while (entry.prompts.reduce((sum, item) => sum + item.text.length, 0) > MAX_SESSION_CHARS && entry.prompts.length > 1) { entry.prompts.splice(1, 1); entry.complete = false; }
      this.state.sessions[sessionId] = entry;
    });
  }

  private change(apply: () => void): Promise<void> {
    const next = this.queue.catch(() => {}).then(async () => {
      apply();
      const ids = Object.keys(this.state.sessions);
      if (ids.length > MAX_SESSIONS) {
        for (const id of ids.sort((a, b) => this.state.sessions[a]!.updatedAt.localeCompare(this.state.sessions[b]!.updatedAt)).slice(0, ids.length - MAX_SESSIONS)) {
          delete this.state.sessions[id];
          this.state.forgotten.push(id);
        }
        this.state.forgotten = this.state.forgotten.slice(-20_000);
      }
      await writePrivateJson(this.path, JSON.stringify(this.state));
    });
    this.queue = next;
    return next;
  }

  async flush(): Promise<void> { await this.queue.catch(() => {}); }
}
