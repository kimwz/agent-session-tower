import { randomUUID } from 'node:crypto';
import type { StorageClient } from '../../storage/client.js';
import type { StorageCommandError } from '../../storage/contract.js';
import { documentsOf, journalOf, retentionHash, RETENTION_CHUNK_BYTES, RETENTION_INTENT_BYTES, rowsOf, type JournalDocument, type RetentionChange, type RetentionDocuments, type RetentionRow, type RetentionRowKind } from './storage-codec.js';
import type { RetentionHead, RetentionWriteIntent } from './storage-commands.js';

/** One shared worker SDK; no domain connection, thread, SQL channel or unknown replay. */
export class RetentionRepository {
  private uncertain?: unknown;
  lastIntent?: { id: string; commandId: string; sha256: string };
  constructor(readonly storage: StorageClient) {}
  async gate(): Promise<void> {
    if (this.uncertain) throw this.uncertain;
    const core = await this.storage.gate('core');
    const domain = await this.storage.gate('retention');
    if (!core.open || !domain.open) throw new Error(`Retention storage held: ${[...core.reasons, ...domain.reasons].join('; ')}`);
  }
  async head(): Promise<RetentionHead> {
    await this.gate();
    const head = await this.storage.read<RetentionHead>('retention', 'head', {});
    if (head.authority && head.authority.authority !== 'database') throw new Error('Retention legacy-exported authority requires explicit owner recovery; never reimport automatically.');
    return head;
  }
  async databaseAuthority(): Promise<boolean> { return (await this.head()).authority?.authority === 'database'; }
  async exportCurrent(): Promise<{ documents: RetentionDocuments; head: RetentionHead; sha256: string }> {
    const { rows, head } = await this.readCurrentRows(['journal', 'observations', 'entry', 'policy', 'observation']);
    const documents = documentsOf(rows);
    return { documents, head, sha256: retentionHash(JSON.stringify(documents)) };
  }
  /** Cold membership must remain available when only observation metadata is malformed. */
  async readCurrentJournal(): Promise<{ journal: JournalDocument; head: RetentionHead }> {
    const { rows, head } = await this.readCurrentRows(['journal', 'entry', 'policy']);
    return { journal: journalOf(rows), head };
  }
  private async readCurrentRows(kinds: RetentionRowKind[]): Promise<{ rows: RetentionRow[]; head: RetentionHead }> {
    const head = await this.head();
    if (!head.authority || head.revision === null) throw new Error('No imported retention authority to export.');
    const fence = { revision: head.revision, generation: head.authority.generation };
    const rows: RetentionRow[] = [];
    for (const kind of kinds) {
      let after = 0;
      while (true) {
        const page = await this.storage.read<{ ordinal: number; idBytes: number; bytes: number }[]>('retention', 'keys', { ...fence, kind, after });
        if (!page.length) break;
        for (const row of page) {
          const read = async (field: 'id' | 'json', size: number) => {
            const chunks: Buffer[] = [];
            for (let offset = 0; offset < size; offset += RETENTION_CHUNK_BYTES) {
              const data = await this.storage.read<string>('retention', 'chunk', { ...fence, kind, ordinal: row.ordinal, field, offset });
              chunks.push(Buffer.from(data, 'base64'));
            }
            const bytes = Buffer.concat(chunks);
            if (bytes.length !== size) throw new Error('Incomplete current retention export.');
            return bytes.toString('utf8');
          };
          rows.push({ kind, id: await read('id', row.idBytes), json: await read('json', row.bytes) });
        }
        after = page[page.length - 1].ordinal + 1;
      }
    }
    const last = await this.head();
    if (last.revision !== head.revision || last.authority?.generation !== head.authority.generation) throw new Error('Current retention export changed while paging.');
    return { rows, head };
  }
  async update(changes: RetentionChange[]): Promise<void> {
    if (!changes.length) { await this.head(); return; }
    const head = await this.head();
    if (!head.authority) throw new Error('Cannot write retention DB without imported authority.');
    await this.writeIntent({ mode: 'update', revision: head.revision, generation: head.authority.generation, changes });
  }
  /** Explicit current DB restore; caller retains existing backup version and owner/hold guards. */
  async restore(documents: RetentionDocuments, commandId = `retention-${randomUUID()}`, expectedGeneration?: number): Promise<void> {
    rowsOf(documents);
    await this.gate();
    const head = await this.head();
    if (!head.authority) throw new Error('Cannot restore retention DB without imported authority.');
    if (expectedGeneration !== undefined && head.authority.generation !== expectedGeneration) throw new Error('Retention restore export belongs to another authority generation.');
    const receipt = await this.storage.receipt(`${commandId}-commit`);
    if (receipt.found) {
      const record = receipt.receipt, result = record.result;
      if (record.scope !== 'retention' || record.command !== 'commit' || result.state !== 'included') throw new Error('Retention restore receipt cannot be verified.');
      const value = result.value as { mode?: string; documentsSha256?: string };
      if (value?.mode !== 'restore' || value.documentsSha256 !== retentionHash(JSON.stringify(documents))) throw new Error('Retention restore command ID conflicts with another intent.');
      return;
    }
    await this.writeIntent({ mode: 'restore', documents, revision: head.revision, generation: head.authority.generation }, commandId);
  }
  /** Prepared B calls this only after the actual update evaluator and private source backup. A refuses at commit. */
  async importPrepared(documents: RetentionDocuments, manifestSha256: string, commandId: string, verifyBeforeCommit?: () => Promise<void>): Promise<void> {
    const head = await this.head();
    if (head.authority) throw new Error('Retention authority exists; JSON reimport is forbidden.');
    await this.writeIntent({ mode: 'import', documents, manifestSha256, revision: null, generation: null }, commandId, verifyBeforeCommit);
  }
  private async writeIntent(input: RetentionWriteIntent, id = `retention-${randomUUID()}`, verifyBeforeCommit?: () => Promise<void>): Promise<void> {
    await this.gate();
    // Keep the exact previous-value guard without retransmitting a potentially
    // 192MB committed row. Null remains the distinct absent-row precondition.
    const transfer = input.changes ? { ...input, changes: input.changes.map(({ previous, ...change }) => ({ ...change, previous: null, ...(previous === null ? {} : { previousSha256: retentionHash(previous) }) })) } : input;
    const bytes = Buffer.from(JSON.stringify(transfer));
    if (bytes.length > RETENTION_INTENT_BYTES) throw new Error('Retention intent exceeds its bounded transfer allowance.');
    const sha256 = retentionHash(bytes);
    this.lastIntent = { id, commandId: `${id}-commit`, sha256 };
    // An intent has one fixed ID per stage and final commit. We do not retry any lost answer.
    const write = async (command: string, payload: unknown, commandId: string) => {
      try { await this.storage.write('retention', command, payload, commandId); }
      catch (error) {
        // A captured fixture SDK can have a different class instance; disposition is part of the public contract.
        const disposition = (error as StorageCommandError)?.disposition;
        if (disposition === 'unknown' || disposition === 'committed') this.uncertain = error;
        throw error;
      }
    };
    await write('begin', { intent: id, bytes: bytes.length, sha256, chunks: Math.ceil(bytes.length / RETENTION_CHUNK_BYTES) }, `${id}-begin`);
    for (let offset = 0, part = 0; offset < bytes.length; offset += RETENTION_CHUNK_BYTES, part++) {
      await write('stage', { intent: id, part, data: bytes.subarray(offset, offset + RETENTION_CHUNK_BYTES).toString('base64') }, `${id}-${part}`);
    }
    await verifyBeforeCommit?.();
    await this.gate();
    await write('commit', { intent: id }, `${id}-commit`);
  }
}
