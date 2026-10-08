import type { RollbackFence, RollbackPorts, ServingProof } from '../../../../server/link/storage-update.js';
import type { StorageInspection } from '../../../../server/storage/contract.js';
import { CORE_MIGRATIONS, migrationChecksum } from '../../../../server/storage/schema.js';
import { B, identityOf, retentionA } from './storage-builds.js';

/**
 * The worker side of an owner's rollback as one fake world, standing for what W0I connects (the real worker's actuator,
 * StorageClient and handoff): which worker serves (the build rolled back from until a handoff takes effect, then the
 * target as a new process), the storage (its ID, owner epoch and the serving worker's claim), the admission holds by
 * rollback ID, and the handoffs the serving worker knows by ID and attempt. Like the real actuator must, it refuses a
 * hold, release or handoff whose attempt is older than the newest it saw for that ID. The serving proof is read-only.
 */

export const STORAGE_ID = '00000000-0000-4000-8000-000000000000';
const at = '2026-10-08T00:00:00.000Z';
export const appliedFor = (scopes: Array<[string, string[]]>, storageId = STORAGE_ID): StorageInspection['schema'] => ({
  kind: 'current', storageId,
  applied: scopes.flatMap(([scope, sqls]) => sqls.map((sql, index) => ({ scope, version: index + 1, checksum: migrationChecksum(scope, { version: index + 1, sql }), appliedAt: at, appVersion: B, sourceHash: 'b'.repeat(64), ownerEpoch: 1 }))),
});
/** B's database: core and the retention domain it imported, authoritative in the database. */
export const databaseOfB = (ownerEpoch = 1, storageId = STORAGE_ID): Pick<StorageInspection, 'schema' | 'authority' | 'ownerEpoch'> => ({
  schema: appliedFor([['core', CORE_MIGRATIONS.map(migration => migration.sql)], ['retention', retentionA.migrations.map(migration => migration.sql)]], storageId),
  authority: [{ domain: 'retention', authority: 'database', generation: 1, manifestSha256: 'c'.repeat(64), readerContract: 1, writerContract: 1, committedAt: at, appVersion: B, sourceHash: 'b'.repeat(64), ownerEpoch: 1 }],
  ownerEpoch,
});
export const workerOf = (version: string, pid: number): ServingProof['worker'] => {
  const identity = identityOf(version);
  return { version, sourceHash: identity.sourceHash, manifestDigest: identity.manifestDigest, protocol: identity.protocol, pid, start: `started-${pid}` };
};

export interface WorldOptions {
  /** The storage before anything is handed over: B's database (default), or an empty one. */
  storage?: 'current' | 'empty';
  /**
   * What the lower worker does with a handoff: `take` it (default); `refuse` it before any effect; take it and `lose`
   * the answer; lose the answer `before` anything happened; leave it `pending`; or accept it and do nothing (`ignore`).
   */
  handoff?: 'take' | 'refuse' | 'lose' | 'before' | 'pending' | 'ignore';
  /** The target claims an existing storage at once (default), or only once claim() is called. */
  claim?: 'at-once' | 'later';
}

export function rollbackWorld(options: WorldOptions = {}) {
  /** Mutating calls and inspections, in order ('hold', 'release', 'handoff', 'inspect', 'quiet', 'restart'); serving proofs are counted apart. */
  const calls: string[] = [];
  const holds = new Set<string>();
  const holdIds: string[] = [];
  const fences: string[] = [];
  /** Calls the actuator refused for an older attempt. */
  const stale: string[] = [];
  const newest = new Map<string, number>();
  let proofs = 0;
  const empty = options.storage === 'empty';
  const state = {
    serving: workerOf(B, 100),
    storage: (empty ? { kind: 'empty' } : { kind: 'current', storageId: STORAGE_ID }) as { kind: 'empty' } | { kind: 'current'; storageId: string },
    epoch: empty ? 0 : 1,
    claim: (empty ? undefined : 1) as number | undefined,
    gate: !empty,
    prepareRefused: false,
    handoffs: new Map<string, 'pending' | 'done'>(),
  };
  const key = (fence: RollbackFence) => `${fence.id}#${fence.attempt}`;
  const fenced = (name: string, fence: RollbackFence) => {
    fences.push(`${name}#${fence.attempt}`);
    if (fence.attempt < (newest.get(fence.id) ?? 0)) { stale.push(`${name}#${fence.attempt}`); throw new Error(`The actuator refused ${name} for attempt ${fence.attempt}: a newer attempt of ${fence.id} acts.`); }
    newest.set(fence.id, fence.attempt);
  };
  const inspection = (): Pick<StorageInspection, 'schema' | 'authority' | 'ownerEpoch'> => state.storage.kind === 'empty'
    ? { schema: { kind: 'empty' }, authority: [], ownerEpoch: state.epoch } : databaseOfB(state.epoch, state.storage.storageId);
  /** The target's worker runs as a new process: on an existing storage it claims it (now or later); on an empty one it does not, and says why. */
  const takeOver = (target: { version: string }) => {
    state.serving = workerOf(target.version, state.serving.pid + 100);
    if (state.storage.kind === 'empty') { state.claim = undefined; state.gate = false; state.prepareRefused = true; return; }
    state.claim = undefined;
    state.gate = false;
    if ((options.claim ?? 'at-once') === 'at-once') claim();
  };
  const claim = () => { state.epoch += 1; state.claim = state.epoch; state.gate = true; };
  const ports: RollbackPorts = {
    inspectStorage: async () => { calls.push('inspect'); return inspection(); },
    holdAdmission: async fence => { calls.push('hold'); fenced('hold', fence); holds.add(fence.id); holdIds.push(fence.id); },
    releaseAdmission: async fence => { calls.push('release'); fenced('release', fence); holds.delete(fence.id); },
    waitQuiet: async () => { calls.push('quiet'); return { state: 'quiet' }; },
    restartWeb: async () => { calls.push('restart'); },
    handoff: async (target, fence) => {
      calls.push('handoff');
      fenced('handoff', fence);
      switch (options.handoff ?? 'take') {
        case 'refuse': return { state: 'refused', reason: 'The lower worker refused the handoff before anything changed.' };
        case 'before': throw new Error('No answer: the request never reached the worker.');
        case 'pending': state.handoffs.set(key(fence), 'pending'); return { state: 'accepted' };
        case 'ignore': return { state: 'accepted' };
        default: break;
      }
      takeOver(target);
      state.handoffs.set(key(fence), 'done');
      if (options.handoff === 'lose') throw new Error('The answer was lost after the handoff took effect.');
      return { state: 'accepted' };
    },
    servingProof: async fence => {
      proofs++;
      return {
        worker: { ...state.serving }, status: { state: 'ready', ...(state.claim !== undefined ? { ownerEpoch: state.claim } : {}) }, inspection: inspection(), gate: { open: state.gate },
        ...(state.prepareRefused ? { prepare: { code: 'migration-required' as const, disposition: 'not-committed' as const } } : {}),
        handoff: state.handoffs.get(key(fence)) ?? 'none',
      };
    },
  };
  return {
    ports, calls, holds, holdIds, fences, stale, state, proofs: () => proofs,
    /** The target claims the existing storage it serves (it had not yet). */
    claim,
    /** A pending handoff finishes: the target takes over. */
    finish: (target: { version: string }) => { for (const [id, value] of state.handoffs) if (value === 'pending') state.handoffs.set(id, 'done'); takeOver(target); },
    /** The serving worker opens its storage again: the epoch grows and its claim follows. */
    reopen: () => { state.epoch += 1; if (state.claim !== undefined) state.claim = state.epoch; },
    /** Another worker claims the storage after the serving one. */
    otherClaim: () => { state.epoch += 1; },
    /** The storage is another one than before (replaced, or created where it was empty). */
    replaceStorage: (storageId = 'another-storage') => { state.storage = { kind: 'current', storageId }; if (state.epoch === 0) state.epoch = 1; },
    /** The target's normal bootstrap on an empty storage once its hold went: it creates the storage and claims it. */
    bootstrap: () => { state.storage = { kind: 'current', storageId: 'created-by-target' }; state.epoch = 1; state.claim = 1; state.gate = true; state.prepareRefused = false; },
  };
}
