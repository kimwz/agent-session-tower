import { createHash } from 'node:crypto';
import { TowerError } from '../../shared/errors.js';
import { processStart } from '../instance/process-start.js';
import { readRollbackRecord, rollbackBootstrapCommandId, probeInstalledArtifact, databaseSupported, type RollbackFence, type RollbackPorts, type ServingProof } from '../link/storage-update.js';
import { readStoragePin, readExact } from '../link/storage-transition-lock.js';
import { entryPoint, versionDirectory } from '../link/service.js';
import type { StorageClient } from '../storage/client.js';
import type { SuccessorCommand } from './handoff.js';

/** The durable rollback record is the admission intent; RPC arguments never establish one. */
export function storageControl(options: {
  stateDir: string;
  client(): StorageClient | undefined;
  hold(reason: string): Promise<void>;
  release(): Promise<void>;
  quiet(): boolean;
  handoff(command: SuccessorCommand, fence: RollbackFence): void;
  acceptedFence?(): RollbackFence | undefined;
  successorFence?: RollbackFence;
  prepareRefusal?: ServingProof['prepare'];
}) {
  let accepted: RollbackFence | undefined;
  const requireClient = () => {
    const client = options.client();
    if (!client) throw new TowerError('unavailable', 'The database has not opened; its contents are unknown.');
    return client;
  };
  const fenced = async (value: unknown, action: 'hold' | 'release' | 'handoff') => {
    const fence = value as Partial<RollbackFence> | undefined;
    if (!fence || typeof fence.id !== 'string' || !Number.isSafeInteger(fence.attempt) || fence.attempt! < 1) throw new TowerError('invalid', 'Invalid rollback fence.');
    const read = await readRollbackRecord(options.stateDir);
    if (read.state !== 'present') throw new TowerError('unavailable', 'The durable rollback intent cannot be read.');
    const record = read.record;
    if (record.id !== fence.id || record.attempt?.n !== fence.attempt || record.attempt?.ended && !(action === 'release' && !record.held)) throw new TowerError('conflict', 'The rollback attempt no longer owns this command.');
    if (action === 'hold' && (!record.held || !['holding', 'held', 'waiting', 'switching', 'switched', 'handing-off'].includes(record.state))) throw new TowerError('conflict', 'No durable admission hold intent.');
    if (action === 'handoff' && (!record.held || !record.switched || record.state !== 'handing-off' || record.handoff?.attempt !== fence.attempt || record.handoff?.state !== 'sent')) throw new TowerError('conflict', 'No durable handoff intent.');
    if (action === 'release' && !['completed', 'failed', 'withdrawn'].includes(record.state)) throw new TowerError('conflict', 'The rollback is still active.');
    return { fence: { id: fence.id, attempt: fence.attempt! }, record };
  };
  const proof = async (fence: RollbackFence): Promise<ServingProof> => {
    if (!fence || typeof fence.id !== 'string' || !Number.isSafeInteger(fence.attempt) || fence.attempt < 1) throw new TowerError('invalid', 'Invalid proof fence.');
    const client = requireClient();
    const identity = client.identity;
    const start = await processStart(process.pid);
    if (!identity || !start) throw new TowerError('unavailable', 'The serving worker identity cannot be proven.');
    const before = client.status();
    const inspection = await client.inspect();
    const gate = await client.gate('core');
    const bootstrap = inspection.schema.kind === 'empty' ? undefined : await client.receipt(rollbackBootstrapCommandId(fence));
    const after = client.status();
    if (before.state !== after.state || before.ownerEpoch !== after.ownerEpoch || after.ownerEpoch !== undefined && after.ownerEpoch !== inspection.ownerEpoch) throw new TowerError('unavailable', 'The storage claim changed during its proof.');
    const read = await readRollbackRecord(options.stateDir);
    const same = read.state === 'present' && read.record.id === fence.id && read.record.handoff?.attempt === fence.attempt;
    const successor = options.successorFence;
    const owned = options.acceptedFence?.() ?? accepted;
    const completed = read.state === 'present' && read.record.state === 'completed' && read.record.handoff?.state === 'done' && read.record.target === identity.appVersion && read.record.sourceHash === identity.sourceHash && read.record.manifestDigest === identity.manifestDigest;
    return { worker: { version: identity.appVersion, sourceHash: identity.sourceHash, manifestDigest: identity.manifestDigest, protocol: identity.protocol, pid: process.pid, start },
      status: { state: after.state, ...(after.ownerEpoch === undefined ? {} : { ownerEpoch: after.ownerEpoch }) }, inspection, gate: { open: gate.open }, ...(options.prepareRefusal ? { prepare: options.prepareRefusal } : {}),
      handoff: same && (completed || successor?.id === fence.id && successor.attempt === fence.attempt) ? 'done' : same && owned?.id === fence.id && owned.attempt === fence.attempt ? 'pending' : 'none', ...(bootstrap ? { bootstrap } : {}) };
  };
  return async (action: string, input: Record<string, unknown>): Promise<unknown> => {
    if (action === 'inspect') return requireClient().inspect();
    if (action === 'proof') return proof(input.fence as RollbackFence);
    if (action === 'quiet') {
      const read = await readRollbackRecord(options.stateDir);
      if (read.state !== 'present' || read.record.id !== input.id || !read.record.held) throw new TowerError('conflict', 'No matching held rollback.');
      return options.quiet() ? { state: 'quiet' } : { state: 'pending', reason: 'Providers, approvals, transient calls or a legacy terminal are still active.' };
    }
    if (!['hold', 'release', 'handoff'].includes(action)) throw new TowerError('invalid', 'Unknown storage control operation.');
    const { fence, record } = await fenced(input.fence, action as 'hold' | 'release' | 'handoff');
    if (action === 'hold') { await options.hold(record.reason); return; }
    if (action === 'release') { if (record.held) await options.release(); return; }
    const target = input.target as { version?: unknown; entry?: unknown; sourceHash?: unknown } | undefined;
    const directory = versionDirectory(options.stateDir, record.target);
    const entry = await entryPoint(directory);
    const pin = await readStoragePin(options.stateDir);
    const artifact = await probeInstalledArtifact(directory, record.target);
    if (!target || target.version !== record.target || target.sourceHash !== record.sourceHash || target.entry !== entry || !entry
      || pin.state !== 'present' || pin.pin.pinned !== record.target || pin.pin.rollbackId !== record.id || pin.pin.sourceHash !== record.sourceHash || pin.pin.manifestDigest !== record.manifestDigest || pin.pin.entrySha256 !== record.entrySha256
      || artifact.state !== 'contract' || !artifact.contract.supported || artifact.contract.identity.sourceHash !== record.sourceHash || artifact.contract.identity.manifestDigest !== record.manifestDigest
      || createHash('sha256').update((await readExact(entry, 64 * 1024 * 1024))!).digest('hex') !== record.entrySha256) return { state: 'refused', reason: 'The validated target, artifact or pin changed.' };
    const current = await proof(fence);
    const baseline = record.handoff?.baseline;
    const observed = current.inspection.schema;
    const sameStorage = baseline?.storage.kind === observed.kind && observed.kind === 'empty' || baseline?.storage.kind === 'current' && observed.kind !== 'empty' && baseline.storage.storageId === observed.storageId;
    if (baseline?.worker.pid !== current.worker.pid || baseline.worker.start !== current.worker.start || baseline.worker.sourceHash !== current.worker.sourceHash || !databaseSupported(artifact.contract, current.inspection).ok || !sameStorage || baseline?.ownerEpoch !== current.inspection.ownerEpoch || !current.gate.open && current.inspection.schema.kind !== 'empty') return { state: 'refused', reason: 'The database claim or gate changed since validation.' };
    if (!options.quiet()) return { state: 'refused', reason: 'The worker became busy.' };
    await fenced(fence, 'handoff');
    options.handoff({ execPath: process.execPath, args: [entry, '--runner-worker', options.stateDir] }, fence);
    accepted = fence;
    return { state: 'accepted' };
  };
}

/** Web transports only typed owner commands; all database work stays in the execution worker. */
export function rollbackPorts(call: (action: string, input: Record<string, unknown>) => Promise<unknown>, restartWeb: () => Promise<void>): RollbackPorts {
  return {
    inspectStorage: () => call('inspect', {}) as ReturnType<RollbackPorts['inspectStorage']>,
    holdAdmission: async (fence, reason) => { await call('hold', { fence, reason }); },
    releaseAdmission: async fence => { await call('release', { fence }); },
    waitQuiet: id => call('quiet', { id }) as ReturnType<RollbackPorts['waitQuiet']>,
    restartWeb,
    handoff: (target, fence) => call('handoff', { target, fence }) as ReturnType<RollbackPorts['handoff']>,
    servingProof: fence => call('proof', { fence }) as ReturnType<RollbackPorts['servingProof']>,
  };
}
