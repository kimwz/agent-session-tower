import type { StorageUpdateInput } from '../link/storage-update.js';
import type { StorageClient } from '../storage/client.js';
import { TriggersRepository } from './storage-repository.js';
import { bootstrapTriggers } from './storage-transfer.js';
import { canonical, logicalBytes, triggerHash, rowCost, projectedJson, ROW_KINDS, type TriggerChange, type TriggerRow, type TriggerRowKind } from './storage-codec.js';
import { consumedSnapshot, isolateConsumed, normalizeOnce } from './once.js';
import { failure } from './errors.js';
import { empty, pruneState, type EngineState } from './state.js';
import type { TriggerAdmissionLink } from './storage-commands.js';

const MAX_STATE_BYTES = 10_000_000;
/** New runs stop being accepted here, so runs already accepted can still record how they end. */
const ACCEPT_STATE_BYTES = 8_000_000;
const FULL = 'Trigger history is full; scheduled times pass without running until old history expires or triggers are deleted.';

/** Business callers name their writable rows before any helper runs. No proxy or serialized state diff. */
export type TriggerMutation =
  | { type: 'definition' | 'fire' | 'cursor'; id: string }
  | { type: 'events'; ids: readonly string[] }
  | { type: 'settings' | 'audit' | 'maintenance' | 'startup' | 'restore' }
  | { type: 'secretGrant'; id: string };

const arrayKinds = new Set<TriggerRowKind>(['triggers','tombstones','events','audit','trustedFolders','recentFires']);
const identityKinds = new Set<TriggerRowKind>(['triggers','tombstones','events','audit']);

/** An isolated business projection; only declared mutable records are copied, never the whole engine. */
export function mutationProjection(current: EngineState, mutation: TriggerMutation): EngineState {
  const all = mutation.type === 'startup' || mutation.type === 'restore';
  const definition = mutation.type === 'definition' || mutation.type === 'fire';
  const id = 'id' in mutation ? mutation.id : undefined;
  const eventIds = new Set(mutation.type === 'events' ? mutation.ids : []);
  const triggerIds = new Set(current.events.filter(event => eventIds.has(event.id)).map(event => event.triggerId));
  if (id) triggerIds.add(id);
  const copy = <T>(value: T, selected: boolean): T => selected ? structuredClone(value) : value;
  const state: EngineState = { ...current,
    triggers: current.triggers.map(item => copy(item,all || definition && item.id === id)),
    tombstones: [...current.tombstones], revisions: { ...current.revisions },
    cursors: Object.fromEntries(Object.entries(current.cursors).map(([key,value]) => [key,copy(value,all || triggerIds.has(key))])),
    events: current.events.map(item => copy(item,mutation.type === 'startup' && item.status === 'claimed' || mutation.type === 'restore' && item.status === 'queued'
      || eventIds.has(item.id) || mutation.type === 'definition' && item.triggerId === id && item.status === 'queued')),
    fired: { ...current.fired }, audit: [...current.audit], settings: current.settings,
    trustedFolders: [...current.trustedFolders], recentFires: [...current.recentFires], secretGrants: { ...current.secretGrants },
  };
  isolateConsumed(state);
  return state;
}

/**
 * SQL owns durability. A read projection becomes current only after its guarded row batch commits.
 */
export class TriggerStore {
  private repository?: TriggersRepository;
  private database = false;
  private bootstrap?: Promise<void>;
  private rows: TriggerRow[] = [];
  private rowLedger: EngineState['onceConsumed'] = {};
  private startupTouched = new Set<string>();
  private revision?: number;
  /** SQL admissions advance the revision outside this owner's write queue. Read before drafting. */
  private async refreshAdmissionState(): Promise<void> {
    if (!this.database) return;
    const head = await this.repository!.head();
    if (head.revision === this.revision) return;
    // The only external domain writer is atomic run admission; it changes events and their logical budget.
    // Read that collection under the same revision fence, without re-exporting definitions/secrets/history.
    const current = await this.repository!.readCurrentRows(['events']);
    if (current.head.logicalBytes === null) throw failure('Trigger admission budget is missing.','unavailable');
    this.rows = [...this.rows.filter(row => row.kind !== 'events'),...current.rows];
    this.current = { ...this.current,events: current.rows.sort((a,b) => a.ordinal - b.ordinal).map(row => JSON.parse(row.json)) };
    this.revision = current.head.revision!; this.stateBytes = current.head.logicalBytes;
  }
  async admissionLink(eventId: string): Promise<TriggerAdmissionLink | undefined> {
    await this.idle();
    if (!this.database) return undefined;
    if (this.locked || this.storageError) throw failure('Trigger storage is held.','unavailable');
    await this.refreshAdmissionState();
    const head = await this.repository!.head(), row = this.rows.find(item => item.kind === 'events' && item.id === eventId);
    if (!row || head.revision !== this.revision || !head.authority) throw failure('Trigger admission fence changed.','conflict');
    const event = JSON.parse(row.json);
    if (event.status !== 'claimed') throw failure('Trigger event is no longer claimed.','conflict');
    return { storageId: head.storageId,generation: head.authority.generation,revision: head.revision!,eventId,requestId: event.requestId,eventSha256: triggerHash(row.json) };
  }
  private current: EngineState = empty();
  private writes: Promise<unknown> = Promise.resolve();
  private pendingCommits = 0;
  private storageError?: string;
  /** Failed startup preserves original state and prevents every subsequent save. */
  private locked?: string;
  private stateBytes = 0;
  private capacityError?: string;

  constructor(private readonly options: { stateDir: string; storage?: StorageClient; now: () => number; limits: () => { acceptBytes?: number; maxBytes?: number } | undefined; changed: () => void }) {
    if (options.storage) this.repository = new TriggersRepository(options.storage);
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
      if (!this.repository || !await bootstrapTriggers(this.repository,this.options.stateDir)) throw new Error('Triggers SQL authority is unavailable.');
      this.database = true;
      const current = await this.repository.exportCurrent(); loaded = current.documents; this.rows = current.rows; this.revision = current.head.revision!;
      this.rowLedger = consumedSnapshot(loaded);
      this.stateBytes = logicalBytes(this.rows);
      this.locked = undefined; this.storageError = undefined;
      const prepared = mutationProjection(loaded,{ type: 'startup' });
      this.startupTouched = new Set([
        ...loaded.triggers.map(item => canonical(['triggers',item.id])),
        ...Object.keys(loaded.cursors).map(id => canonical(['cursors',id])),
        ...loaded.events.filter(item => item.status === 'claimed').map(item => canonical(['events',item.id])),
      ]);
      normalizeOnce(prepared,this.options.now); prepare(prepared); this.current = prepared;
    } catch (error) {
      this.locked = `Trigger state is held; original data is preserved: ${error instanceof Error ? error.message : String(error)}`;
      this.storageError = this.locked; this.options.changed();
      throw failure(this.locked,'unavailable');
    }
  }

  /** Fixed row commands for the declared mutation plus explicit retention removals/ordinal moves.
   * Unchanged projection records retain identity and never enter JSON encoding or SQL staging.
   */
  private rowBatch(mutation: TriggerMutation, draft: EngineState, pruned: ReadonlySet<string>): TriggerChange[] {
    const batch: TriggerChange[] = [];
    const rows = new Map(this.rows.map(row => [canonical([row.kind,row.id]),row]));
    const eventIds = new Set(mutation.type === 'events' ? mutation.ids : []);
    const cursorIds = new Set(draft.events.filter(event => eventIds.has(event.id)).map(event => event.triggerId));
    const selected = (kind: TriggerRowKind,id: string): boolean => {
      if (pruned.has(canonical([kind,id])) || this.startupTouched.has(canonical([kind,id]))) return true;
      switch (mutation.type) {
        case 'startup':
          if (kind === 'events') return this.current.events.some(event => event.id === id && event.status === 'claimed');
          if (kind === 'cursors') return !!this.current.cursors[id]?.polling || this.current.cursors[id]?.nextAt !== draft.cursors[id]?.nextAt;
          if (kind === 'triggers') {
            const old = this.current.triggers.find(item => item.id === id), next = draft.triggers.find(item => item.id === id);
            return old?.enabled !== next?.enabled || old?.archivedAt !== next?.archivedAt || old?.consumed !== next?.consumed;
          }
          return false;
        case 'restore':
          if (kind === 'triggers' || kind === 'cursors') return true;
          if (kind === 'events') return this.current.events.some(event => event.id === id && event.status === 'queued');
          if (kind === 'settings') return this.current.settings !== draft.settings;
          if (kind === 'revisions') return this.current.revisions[id] !== draft.revisions[id];
          if (kind === 'secretGrants') return this.current.secretGrants[id] !== draft.secretGrants[id];
          if (kind === 'trustedFolders') return this.current.trustedFolders[Number(id)] !== draft.trustedFolders[Number(id)];
          return false;
        case 'settings': return kind === 'settings';
        case 'audit': case 'maintenance': return false;
        case 'secretGrant': return kind === 'secretGrants' && id === mutation.id;
        case 'cursor': return kind === 'cursors' && id === mutation.id;
        case 'events': return kind === 'events' && eventIds.has(id) || kind === 'cursors' && cursorIds.has(id);
        case 'definition': case 'fire':
          if (['triggers','revisions','onceConsumed','cursors'].includes(kind)) return id === mutation.id;
          if (kind === 'events') return mutation.type === 'definition' && this.current.events.some(event => event.id === id && event.triggerId === mutation.id && event.status === 'queued');
          if (mutation.type === 'fire') return kind === 'recentFires' && this.current.recentFires[Number(id)] !== draft.recentFires[Number(id)];
          return kind === 'secretGrants' && this.current.secretGrants[id] !== draft.secretGrants[id]
            || kind === 'trustedFolders' && this.current.trustedFolders[Number(id)] !== draft.trustedFolders[Number(id)];
      }
    };
    for (const kind of ROW_KINDS) {
      const before = this.current[kind], after = draft[kind];
      const entries = (value: EngineState[typeof kind]): [string,unknown][] => kind === 'settings' ? [['settings',value]]
        : arrayKinds.has(kind) ? (value as unknown[]).map((item,index) => [identityKinds.has(kind) ? (item as { id: string }).id : String(index),item])
        : Object.entries(value);
      const oldValues = new Map(entries(before));
      const next = entries(after);
      for (const [ordinal,[id,value]] of next.entries()) {
        const old = rows.get(canonical([kind,id]));
        if (!old || old.ordinal !== ordinal || selected(kind,id)) {
          const json = canonical(value);
          if (!old || old.ordinal !== ordinal || old.json !== json) batch.push({ kind,id,ordinal,json,previous: old?.json ?? null,previousOrdinal: old?.ordinal });
        }
        oldValues.delete(id);
      }
      for (const id of oldValues.keys()) {
        const old = rows.get(canonical([kind,id]));
        if (!old) throw new Error(`Missing authoritative trigger row: ${kind}/${id}`);
        batch.push({ ...old,previous: old.json,previousOrdinal: old.ordinal,remove: true });
      }
    }
    // A definition's historical snapshots can keep their own row bytes when only consumption changes.
    // The SQL command recosts those projections inside the same transaction.
    return batch;
  }

  /**
   * `settle` commits record what already-accepted work did (claims, outcomes, cancellations) and may use the
   * reserved space up to the hard limit; everything else stops at the acceptance limit.
   */
  mutate<T>(mutation: TriggerMutation, change: (state: EngineState) => T, kind: 'grow' | 'settle' = 'grow'): Promise<T> {
    this.pendingCommits++;
    const work = this.writes.catch(() => {}).then(async () => {
      await this.refreshAdmissionState();
      if (this.locked || !this.database || !this.repository) throw failure(this.locked ?? 'Triggers SQL authority is unavailable.','unavailable');
      const draft = mutationProjection(this.current,mutation);
      // A new attempt to add something starts without the last capacity warning; the change may set it again.
      if (kind === 'grow') this.capacityError = undefined;
      const result = change(draft);
      const pruned = pruneState(draft, this.options.now);
      const changed = this.rowBatch(mutation,draft,pruned);
      const ledger = consumedSnapshot(draft);
      const byKey = new Map(this.rows.map(row => [canonical([row.kind,row.id]),row]));
      let bytes = this.stateBytes;
      const counts = new Map(ROW_KINDS.map(kind => [kind,this.rows.filter(row => row.kind === kind).length]));
      for (const row of changed) {
        const key = canonical([row.kind,row.id]), old = byKey.get(key);
        if (old) bytes -= rowCost(old,projectedJson(old,this.rowLedger));
        if (row.remove) { byKey.delete(key); counts.set(row.kind,counts.get(row.kind)! - 1); }
        else {
          bytes += rowCost(row,projectedJson(row,ledger)); byKey.set(key,row);
          if (!old) counts.set(row.kind,counts.get(row.kind)! + 1);
        }
      }
      // A ledger write changes legacy costs of retained snapshots without rewriting their immutable row JSON.
      const consumed = new Set(changed.filter(row => row.kind === 'onceConsumed').map(row => row.id));
      for (const old of this.rows) {
        if (!['triggers','tombstones','revisions'].includes(old.kind) || changed.some(row => row.kind === old.kind && row.id === old.id)) continue;
        const affected = old.kind === 'revisions' ? this.current.revisions[old.id]?.some(trigger => consumed.has(trigger.id)) : consumed.has(old.id);
        if (affected) bytes += rowCost(old,projectedJson(old,ledger)) - rowCost(old,projectedJson(old,this.rowLedger));
      }
      for (const rowKind of ROW_KINDS) if (rowKind !== 'settings') bytes += Math.max(0,counts.get(rowKind)! - 1) - Math.max(0,this.rows.filter(row => row.kind === rowKind).length - 1);
      if (bytes > (kind === 'settle' ? this.maxBytes : this.acceptBytes) && bytes > this.stateBytes) {
        if (kind === 'settle') { this.storageError = 'Trigger state is full even after trimming finished history. New runs are not accepted.'; this.options.changed(); }
        throw failure('Trigger history is full. Delete old triggers or wait for finished runs to expire.', 'storage-full');
      }
      if (this.locked) { this.storageError = this.locked; this.options.changed(); throw failure(this.storageError, 'unavailable'); }
      try {
        await this.repository.update(changed,kind,undefined,this.revision);
        if (changed.length) this.revision = (this.revision ?? 0) + 1;
      }
      catch (error) {
        this.storageError = `Cannot save triggers: ${error instanceof Error ? error.message : String(error)}`; this.options.changed();
        const refused = failure(this.storageError,'unavailable');
        if (this.repository?.pending()) Object.assign(refused,{ disposition: 'uncertain',commitDisposition: 'unknown' });
        throw refused;
      }
      this.storageError = undefined;
      this.stateBytes = bytes;
      this.rows = [...byKey.values()];
      this.rowLedger = ledger; this.startupTouched.clear();
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
    await this.mutate({ type: 'maintenance' },() => undefined, 'settle');
  }

  /** Waits for every queued save, whatever it answered. */
  idle(): Promise<unknown> { return this.writes.catch(() => {}); }

}
