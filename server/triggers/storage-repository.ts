import type { EngineState } from './state.js';
import { ROW_KINDS } from './storage-codec.js';
import { randomUUID } from 'node:crypto';
import type { StorageClient } from '../storage/client.js';
import { StorageCommandError, type CommitDisposition } from '../storage/contract.js';
import { canonical, requestHash, transferRow, documentsHash, stateOf, triggerHash, rowsOf, TRIGGER_CHUNK_BYTES, TRIGGER_INTENT_BYTES, type TriggerChange, type TriggerRow } from './storage-codec.js';
import type { TriggerIntentHeader, TriggersHead, TriggerWriteMode } from './storage-commands.js';

export interface TriggerWriteIdentity { id: string; commandId: string; sha256: string }
export interface TriggerPendingWrite extends TriggerWriteIdentity { attemptedCommandId: string; attemptedPayloadSha256: string; finalSent: boolean; error: unknown }
/** One owner on the worker's common SDK. Unknown writes stay here across SDK reopen; never replayed. */
export class TriggersRepository {
  private uncertain?: TriggerPendingWrite;
  private resolved?: 'committed' | 'not-committed';
  lastIntent?: TriggerWriteIdentity;
  constructor(readonly storage: StorageClient) {}
  pending(): Readonly<TriggerPendingWrite> | undefined { return this.uncertain; }
  private async storageGate(): Promise<void> {
    const core = await this.storage.gate('core'), domain = await this.storage.gate('triggers');
    if (!core.open || !domain.open) throw new Error(`Triggers storage held: ${[...core.reasons,...domain.reasons].join('; ')}`);
  }
  async gate(): Promise<void> { if (this.uncertain) throw this.uncertain.error; await this.storageGate(); }
  async head(): Promise<TriggersHead> {
    await this.gate();
    const head = await this.storage.read<TriggersHead>('triggers','head',{});
    if (head.authority && head.authority.authority !== 'database') throw new StorageCommandError({ phase: 'command',code: 'authority-missing',message: 'Triggers legacy-exported authority requires explicit owner recovery; never reimport JSON.',disposition: 'not-committed',retryable: false });
    return head;
  }
  async databaseAuthority(): Promise<boolean> { return (await this.head()).authority?.authority === 'database'; }
  async exportCurrent(): Promise<{ documents: EngineState; rows: TriggerRow[]; head: TriggersHead; sha256: string }> {
    const head = await this.head();
    if (!head.authority || head.revision === null) throw new Error('No imported triggers authority to export.');
    const fence = { revision: head.revision, generation: head.authority.generation }, rows: TriggerRow[] = [];
    let total = 0;
    for (const kind of ROW_KINDS) {
      let after = 0;
      while (true) {
        const page = await this.storage.read<{ ordinal: number; idBytes: number; bytes: number }[]>('triggers','keys',{ ...fence, kind, after });
        if (!page.length) break;
        for (const row of page) {
          const read = async (field: 'id' | 'json', size: number) => {
            total += size;
            if (!Number.isSafeInteger(size) || size < 0 || total > TRIGGER_INTENT_BYTES) throw new Error('Current triggers export exceeds its bounded allowance.');
            const chunks: Buffer[] = [];
            for (let offset = 0; offset < size; offset += TRIGGER_CHUNK_BYTES) chunks.push(Buffer.from(await this.storage.read<string>('triggers','chunk',{ ...fence, kind, ordinal: row.ordinal, field, offset }), 'base64'));
            const bytes = Buffer.concat(chunks);
            if (bytes.length !== size || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('Incomplete or malformed current triggers export.');
            return bytes.toString('utf8');
          };
          rows.push({ kind, ordinal: row.ordinal, id: await read('id',row.idBytes), json: await read('json',row.bytes) });
        }
        after = page[page.length - 1].ordinal + 1;
      }
    }
    const last = await this.head();
    if (last.revision !== head.revision || last.authority?.generation !== head.authority.generation) throw new Error('Triggers changed while paging current export.');
    let documents: EngineState;
    try { documents = stateOf(rows); }
    catch (error) { throw new StorageCommandError({ phase: 'command',code: 'domain-failed',message: `Current triggers data is malformed: ${(error as Error).message}`,disposition: 'not-committed',retryable: false }); }
    return { documents, rows, head, sha256: documentsHash(documents) };
  }
  /** The R6-removable compatibility adapter is in TriggerStore; future owners send individual row commands here. */
  async update(changes: TriggerChange[], mode: Exclude<TriggerWriteMode,'import' | 'restore'> = 'grow', id = `triggers-${randomUUID()}`): Promise<TriggerWriteIdentity | undefined> {
    if (!changes.length) { await this.head(); return undefined; }
    await this.gate();
    const receipt = await this.storage.receipt(`${id}-commit`);
    if (receipt.found) {
      const record = receipt.receipt;
      if (record.scope !== 'triggers' || record.command !== 'commit' || record.result.state !== 'included') throw new Error('Triggers receipt cannot be verified.');
      const result = record.result.value as { requestSha256?: string; intentSha256?: string };
      if (result?.requestSha256 !== requestHash(mode,changes) || typeof result.intentSha256 !== 'string') throw new Error('Triggers command ID conflicts with another canonical payload.');
      return { id,commandId: `${id}-commit`,sha256: result.intentSha256 };
    }
    const head = await this.head();
    if (!head.authority) throw new Error('Cannot write triggers DB without imported authority.');
    return this.writeIntent({ mode, revision: head.revision, generation: head.authority.generation }, changes, id);
  }
  async restore(documents: EngineState, id: string, expectedGeneration?: number): Promise<TriggerWriteIdentity | undefined> {
    const rows = rowsOf(documents), digest = documentsHash(documents), head = await this.head();
    if (!head.authority || (expectedGeneration !== undefined && head.authority.generation !== expectedGeneration)) throw new Error('Triggers restore belongs to another authority generation.');
    const receipt = await this.storage.receipt(`${id}-commit`);
    if (receipt.found) {
      const record = receipt.receipt;
      if (record.scope !== 'triggers' || record.command !== 'commit' || record.result.state !== 'included') throw new Error('Triggers restore receipt cannot be verified.');
      const result = record.result.value as { mode?: string; documentsSha256?: string };
      if (result?.mode !== 'restore' || result.documentsSha256 !== digest) throw new Error('Triggers restore command ID conflicts with another intent.');
      return;
    }
    return this.writeIntent({ mode: 'restore', revision: head.revision, generation: head.authority.generation, documentsSha256: digest }, rows, id);
  }
  /** A refuses before staging. B must additionally supply sealed evidence and the common update evaluator. */
  async importPrepared(documents: EngineState, manifestSha256: string, id: string, verifyBeforeCommit?: () => Promise<void>): Promise<TriggerWriteIdentity> {
    if (!this.storage.context?.manifest.domains.find(domain => domain.scope === 'triggers')?.cutover) throw new Error('Triggers preparation has no cutover contract.');
    const head = await this.head();
    if (head.authority) throw new Error('Triggers authority exists; JSON reimport is forbidden.');
    return this.writeIntent({ mode: 'import', revision: null, generation: null, manifestSha256, documentsSha256: documentsHash(documents) }, rowsOf(documents), id, verifyBeforeCommit);
  }
  /** Explicit receipt resolution, available while this owner's normal commands remain held. No replay/new ID. */
  async resolvePending(): Promise<CommitDisposition> {
    const pending = this.uncertain;
    if (!pending) { if (this.resolved) return this.resolved; throw new Error('No uncertain triggers intent to resolve.'); }
    await this.storageGate();
    const receipt = await this.storage.receipt(pending.attemptedCommandId);
    if (receipt.found) {
      const record = receipt.receipt;
      if (record.scope !== 'triggers' || record.payloadSha256 !== pending.attemptedPayloadSha256) throw new Error('Triggers receipt identity/hash conflict.');
      if (pending.finalSent) {
        if (record.command !== 'commit' || record.result.state !== 'included' || (record.result.value as { intentSha256?: string })?.intentSha256 !== pending.sha256) throw new Error('Triggers commit receipt cannot be verified.');
        this.uncertain = undefined; this.resolved = 'committed';
        return 'committed';
      }
    }
    // The SDK gate must be reopened/prepared after lost transport before absence is read.
    // A stage receipt cannot change authoritative rows: final commit was never submitted.
    this.uncertain = undefined; this.resolved = 'not-committed';
    return 'not-committed';
  }
  private async writeIntent(header: TriggerIntentHeader, rows: readonly (TriggerRow | TriggerChange)[], id: string, verifyBeforeCommit?: () => Promise<void>): Promise<TriggerWriteIdentity> {
    await this.gate();
    const parts: Buffer[] = [Buffer.from(canonical({ ...header,requestSha256: requestHash(header.mode,rows) }) + '\n')];
    let size = parts[0].length;
    for (const row of rows) {
      const line = Buffer.from(transferRow(row,header.mode === 'import' || header.mode === 'restore'));
      size += line.length;
      if (size > TRIGGER_INTENT_BYTES) throw new Error('Triggers intent exceeds its bounded lossless transfer allowance.');
      parts.push(line);
    }
    const bytes = Buffer.concat(parts), identity = { id, commandId: `${id}-commit`, sha256: triggerHash(bytes) };
    this.resolved = undefined; this.lastIntent = identity;
    const write = async (command: string, payload: unknown, commandId: string) => {
      try { await this.storage.write('triggers',command,payload,commandId); }
      catch (error) {
        const disposition = (error as StorageCommandError)?.disposition;
        if (disposition === 'unknown' || disposition === 'committed') this.uncertain = { ...identity, attemptedCommandId: commandId, attemptedPayloadSha256: triggerHash(JSON.stringify(payload)), finalSent: command === 'commit', error };
        throw error;
      }
    };
    await write('begin',{ intent: id, bytes: bytes.length, sha256: identity.sha256, chunks: Math.ceil(bytes.length / TRIGGER_CHUNK_BYTES) },`${id}-begin`);
    for (let offset = 0, part = 0; offset < bytes.length; offset += TRIGGER_CHUNK_BYTES, part++) await write('stage',{ intent: id, part, data: bytes.subarray(offset,offset + TRIGGER_CHUNK_BYTES).toString('base64') },`${id}-${part}`);
    await verifyBeforeCommit?.();
    await this.gate();
    await write('commit',{ intent: id },identity.commandId);
    return identity;
  }
}
