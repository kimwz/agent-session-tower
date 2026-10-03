import { join } from 'node:path';
import { quarantineFile, readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { failure } from './errors.js';
import { empty, parseState, pruneState, serializeState, type EngineState } from './state.js';

const MAX_STATE_BYTES = 10_000_000;
/** New runs stop being accepted here, so runs already accepted can still record how they end. */
const ACCEPT_STATE_BYTES = 8_000_000;
const FULL = 'Trigger history is full; scheduled times pass without running until old history expires or triggers are deleted.';

/**
 * The trigger engine's state and its only way to disk. Every change is computed on a copy, saved, and only then made
 * current; commits run one at a time. Nothing else writes the engine file.
 */
export class TriggerStore {
  private current: EngineState = empty();
  private writes: Promise<unknown> = Promise.resolve();
  private pendingCommits = 0;
  private storageError?: string;
  /** Set when unreadable state could not be moved aside: nothing is saved over it until Tower restarts. */
  private locked?: string;
  private stateBytes = 0;
  private capacityError?: string;
  private readonly path: string;

  constructor(private readonly options: { stateDir: string; now: () => number; limits: () => { acceptBytes?: number; maxBytes?: number } | undefined; changed: () => void }) {
    this.path = join(options.stateDir, 'trigger-engine.json');
  }

  private get acceptBytes() { return this.options.limits()?.acceptBytes ?? ACCEPT_STATE_BYTES; }
  private get maxBytes() { return this.options.limits()?.maxBytes ?? MAX_STATE_BYTES; }

  /** The state as last saved. Read only; changes go through `commit`. */
  get state(): EngineState { return this.current; }
  /** Why saving failed, or why the engine saves nothing (locked). */
  get problem(): string | undefined { return this.storageError; }
  /** Past the acceptance limit: nothing new is accepted. */
  full(): boolean { return this.stateBytes > this.acceptBytes; }
  pending(): number { return this.pendingCommits; }
  /** What the overview shows: a storage problem, then `other` (the secrets'), a full history, a capacity warning. */
  overviewProblem(other: string | undefined): string | undefined { return this.storageError ?? other ?? (this.full() ? FULL : undefined) ?? this.capacityError; }
  get capacity(): string | undefined { return this.capacityError; }
  /** A warning that something could not be recorded for lack of room; a new attempt to add something clears it. */
  noteCapacity(message: string | undefined): void { this.capacityError = message; }

  /**
   * Reads the saved state. An unreadable one is kept aside for inspection and the engine starts empty; one that cannot
   * be moved aside locks the engine. `prepare` changes the loaded state before it becomes current (recovering claims
   * and cut-off polls); nothing is saved until the first commit.
   */
  async load(prepare: (loaded: EngineState) => void): Promise<void> {
    let saved: unknown;
    try { saved = await readPrivateJson(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.quarantine(error); saved = undefined; } }
    let loaded = this.current;
    if (saved !== undefined) {
      const restored = parseState(saved, this.options.now);
      if (!restored) await this.quarantine(new Error('Saved trigger state is invalid.'));
      else loaded = restored;
    }
    prepare(loaded);
    this.current = loaded;
  }

  /**
   * `settle` commits record what already-accepted work did (claims, outcomes, cancellations) and may use the
   * reserved space up to the hard limit; everything else stops at the acceptance limit.
   */
  commit<T>(change: (state: EngineState) => T, kind: 'grow' | 'settle' = 'grow'): Promise<T> {
    this.pendingCommits++;
    const work = this.writes.catch(() => {}).then(async () => {
      const draft = structuredClone(this.current);
      // A new attempt to add something starts without the last capacity warning; the change may set it again.
      if (kind === 'grow') this.capacityError = undefined;
      const result = change(draft);
      pruneState(draft, this.options.now);
      const data = serializeState(draft);
      const bytes = Buffer.byteLength(data);
      if (bytes > (kind === 'settle' ? this.maxBytes : this.acceptBytes) && bytes > this.stateBytes) {
        if (kind === 'settle') { this.storageError = 'Trigger state is full even after trimming finished history. New runs are not accepted.'; this.options.changed(); }
        throw failure('Trigger history is full. Delete old triggers or wait for finished runs to expire.', 'storage-full');
      }
      if (this.locked) { this.storageError = this.locked; this.options.changed(); throw failure(this.storageError, 'unavailable'); }
      try { await writePrivateJson(this.path, data); }
      catch (error) { this.storageError = `Cannot save triggers: ${error instanceof Error ? error.message : String(error)}`; this.options.changed(); throw failure(this.storageError, 'unavailable'); }
      this.storageError = undefined;
      this.stateBytes = bytes;
      this.current = draft;
      this.options.changed();
      return result;
    }).finally(() => { this.pendingCommits--; });
    this.writes = work;
    return work;
  }

  /** Saves again; a locked engine never saves, and a handoff must not wait on it. */
  async flush(): Promise<void> {
    if (this.locked) { await this.writes.catch(() => {}); return; }
    await this.commit(() => undefined, 'settle');
  }

  /** Waits for every queued save, whatever it answered. */
  idle(): Promise<unknown> { return this.writes.catch(() => {}); }

  /**
   * Unreadable state is kept aside for inspection; triggers start empty rather than guess. When it cannot be moved,
   * the engine locks before anything can fire or save, so the file is never written over.
   */
  private async quarantine(error: unknown): Promise<void> {
    console.error('Trigger state could not be read and was moved aside:', error);
    try { await quarantineFile(this.path); }
    catch (moveError) {
      this.locked = 'Trigger state could not be read or moved aside; nothing is saved until Tower restarts.';
      this.storageError = this.locked;
      console.error(this.locked, moveError);
    }
  }
}
