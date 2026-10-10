import { join } from 'node:path';
import { readPrivateBytes, writePrivateJson } from '../stores/private-json.js';
import type { StorageUpdateInput } from '../link/storage-update.js';
import type { StorageClient } from '../storage/client.js';
import { TriggersRepository } from './storage-repository.js';
import { bootstrapTriggers, holdTriggersEvidence } from './storage-transfer.js';
import { changesOf, logicalBytes, rowsOf, type TriggerRow } from './storage-codec.js';
import { normalizeOnce } from './once.js';
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
  private repository?: TriggersRepository;
  private database = false;
  private bootstrap?: Promise<void>;
  private rows: TriggerRow[] = [];
  private current: EngineState = empty();
  private writes: Promise<unknown> = Promise.resolve();
  private pendingCommits = 0;
  private storageError?: string;
  /** Failed startup preserves original state and prevents every subsequent save. */
  private locked?: string;
  private stateBytes = 0;
  private capacityError?: string;
  private readonly path: string;

  constructor(private readonly options: { stateDir: string; storage?: StorageClient; now: () => number; limits: () => { acceptBytes?: number; maxBytes?: number } | undefined; changed: () => void }) {
    if (options.storage) this.repository = new TriggersRepository(options.storage);
    this.path = join(options.stateDir, 'trigger-engine.json');
  }

  /** The worker parks its existing startup continuation here, before load/recovery or secret/native effects. */
  bootstrapStorage(update: () => Promise<StorageUpdateInput>): Promise<void> {
    if (!this.repository) return Promise.reject(new Error('Triggers storage is unavailable.'));
    return this.bootstrap ??= bootstrapTriggers(this.repository,this.options.stateDir,{ update,now: this.options.now })
      .then(() => undefined).finally(() => { this.bootstrap = undefined; });
  }

  /** Reopen/prepare the common SDK first. Resolution never retries the staged command. */
  async resolveStorage(): Promise<'committed' | 'not-committed'> {
    if (!this.repository?.pending()) throw new Error('No uncertain trigger write to resolve.');
    const disposition = await this.repository.resolvePending();
    if (disposition === 'unknown') throw new Error('Trigger receipt remains unknown.');
    return disposition;
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
   * Reads the authoritative saved state. Unreadable state holds startup and stays untouched. `prepare` changes the loaded state before it becomes current (recovering claims
   * and cut-off polls); nothing is saved until the first commit.
   */
  async load(prepare: (loaded: EngineState) => void): Promise<void> {
    let loaded: EngineState;
    try {
      this.database = this.repository ? await bootstrapTriggers(this.repository,this.options.stateDir) : false;
      if (this.database) {
        const current = await this.repository!.exportCurrent(); loaded = current.documents; this.rows = current.rows; normalizeOnce(loaded,this.options.now);
      } else {
        // Standalone owners keep the same seal guard even without an injected SDK.
        if (!this.repository) await holdTriggersEvidence(this.options.stateDir);
        let saved: unknown;
        try { const bytes = await readPrivateBytes(this.path); if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('Trigger state is not lossless UTF-8.'); saved = JSON.parse(bytes.toString('utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        loaded = saved === undefined ? empty() : parseState(saved,this.options.now)!;
        if (!loaded) throw new Error('Saved trigger state is invalid.');
      }
      this.stateBytes = this.database ? logicalBytes(this.rows) : Buffer.byteLength(serializeState(loaded));
      this.locked = undefined; this.storageError = undefined;
      prepare(loaded); this.current = loaded;
    } catch (error) {
      this.locked = `Trigger state is held; original data is preserved: ${error instanceof Error ? error.message : String(error)}`;
      this.storageError = this.locked; this.options.changed();
      throw failure(this.locked,'unavailable');
    }
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
      // R6 debt: callback drafts become typed row diffs only at this owner boundary.
      const rows = this.database ? rowsOf(draft) : undefined;
      const data = this.database ? undefined : serializeState(draft);
      const bytes = rows ? logicalBytes(rows) : Buffer.byteLength(data!);
      if (bytes > (kind === 'settle' ? this.maxBytes : this.acceptBytes) && bytes > this.stateBytes) {
        if (kind === 'settle') { this.storageError = 'Trigger state is full even after trimming finished history. New runs are not accepted.'; this.options.changed(); }
        throw failure('Trigger history is full. Delete old triggers or wait for finished runs to expire.', 'storage-full');
      }
      if (this.locked) { this.storageError = this.locked; this.options.changed(); throw failure(this.storageError, 'unavailable'); }
      try {
        if (this.database) await this.repository!.update(changesOf(this.rows,rows!),kind);
        else await writePrivateJson(this.path,data!);
      }
      catch (error) {
        this.storageError = `Cannot save triggers: ${error instanceof Error ? error.message : String(error)}`; this.options.changed();
        const refused = failure(this.storageError,'unavailable');
        if (this.repository?.pending()) Object.assign(refused,{ disposition: 'uncertain',commitDisposition: 'unknown' });
        throw refused;
      }
      this.storageError = undefined;
      this.stateBytes = bytes;
      if (rows) this.rows = rows;
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

}
