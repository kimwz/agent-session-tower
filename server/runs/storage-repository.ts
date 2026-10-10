import { randomUUID } from 'node:crypto';
import type { TriggerAdmissionLink } from '../triggers/storage-commands.js';
import type { StorageClient } from '../storage/client.js';
import { StorageCommandError, type CommitDisposition } from '../storage/contract.js';
import { canonical, requestHash, transferRow, documentsHash, documentsOf, runHash, rowsOf, RUN_CHUNK_BYTES, RUN_INTENT_BYTES, type RunChange, type RunDocuments, type RunRow, type RunRowKind } from './storage-codec.js';
import type { RunIntentHeader, RunsHead, RunWriteMode } from './storage-commands.js';

export interface RunWriteIdentity { id: string; commandId: string; sha256: string }
export interface RunPendingWrite extends RunWriteIdentity { attemptedCommandId: string; attemptedPayloadSha256: string; finalSent: boolean; error: unknown }
/** One owner on the worker's common SDK. Unknown writes stay here across SDK reopen; never replayed. */
export class RunsRepository {
  private uncertain?: RunPendingWrite;
  private resolved?: 'committed' | 'not-committed';
  lastIntent?: RunWriteIdentity;
  constructor(readonly storage: StorageClient) {}
  pending(): Readonly<RunPendingWrite> | undefined { return this.uncertain; }
  private async storageGate(): Promise<void> {
    const core = await this.storage.gate('core'), domain = await this.storage.gate('runs');
    if (!core.open || !domain.open) throw new Error(`Runs storage held: ${[...core.reasons,...domain.reasons].join('; ')}`);
  }
  async gate(): Promise<void> { if (this.uncertain) throw this.uncertain.error; await this.storageGate(); }
  private async triggerGate(links?: readonly TriggerAdmissionLink[]): Promise<void> {
    if (!links?.length) return;
    const gate = await this.storage.gate('triggers');
    if (!gate.open) throw new Error(`Trigger admission storage held: ${gate.reasons.join('; ')}`);
  }
  async head(): Promise<RunsHead> {
    await this.gate();
    const head = await this.storage.read<RunsHead>('runs','head',{});
    if (head.authority && head.authority.authority !== 'database') throw new StorageCommandError({ phase: 'command',code: 'authority-missing',message: 'Runs legacy-exported authority requires explicit owner recovery; never reimport JSON.',disposition: 'not-committed',retryable: false });
    return head;
  }
  async databaseAuthority(): Promise<boolean> { return (await this.head()).authority?.authority === 'database'; }
  async exportCurrent(): Promise<{ documents: RunDocuments; rows: RunRow[]; head: RunsHead; sha256: string }> {
    const head = await this.head();
    if (!head.authority || head.revision === null) throw new Error('No imported runs authority to export.');
    const fence = { revision: head.revision, generation: head.authority.generation }, rows: RunRow[] = [];
    let total = 0;
    for (const kind of ['created','run','instruction'] as RunRowKind[]) {
      let after = 0;
      while (true) {
        const page = await this.storage.read<{ ordinal: number; idBytes: number; bytes: number }[]>('runs','keys',{ ...fence, kind, after });
        if (!page.length) break;
        for (const row of page) {
          const read = async (field: 'id' | 'json', size: number) => {
            total += size;
            if (!Number.isSafeInteger(size) || size < 0 || total > RUN_INTENT_BYTES) throw new Error('Current runs export exceeds its bounded allowance.');
            const chunks: Buffer[] = [];
            for (let offset = 0; offset < size; offset += RUN_CHUNK_BYTES) chunks.push(Buffer.from(await this.storage.read<string>('runs','chunk',{ ...fence, kind, ordinal: row.ordinal, field, offset }), 'base64'));
            const bytes = Buffer.concat(chunks);
            if (bytes.length !== size || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('Incomplete or malformed current runs export.');
            return bytes.toString('utf8');
          };
          rows.push({ kind, id: await read('id',row.idBytes), json: await read('json',row.bytes) });
        }
        after = page[page.length - 1].ordinal + 1;
      }
    }
    const last = await this.head();
    if (last.revision !== head.revision || last.authority?.generation !== head.authority.generation) throw new Error('Runs changed while paging current export.');
    let documents: RunDocuments;
    try { documents = documentsOf(rows); }
    catch (error) { throw new StorageCommandError({ phase: 'command',code: 'domain-failed',message: `Current runs data is malformed: ${(error as Error).message}`,disposition: 'not-committed',retryable: false }); }
    return { documents, rows, head, sha256: documentsHash(documents) };
  }
  /** Guarded touched rows from one owner operation; the final receipt commits all dependencies together. */
  async update(changes: RunChange[], mode: Exclude<RunWriteMode,'import' | 'restore'> = 'update', id = `runs-${randomUUID()}`, triggerLinks?: readonly TriggerAdmissionLink[]): Promise<RunWriteIdentity | undefined> {
    if (!changes.length) { await this.head(); return undefined; }
    await this.gate();
    await this.triggerGate(triggerLinks);
    const receipt = await this.storage.receipt(`${id}-commit`);
    if (receipt.found) {
      const record = receipt.receipt;
      if (record.scope !== 'runs' || record.command !== 'commit' || record.result.state !== 'included') throw new Error('Runs receipt cannot be verified.');
      const result = record.result.value as { requestSha256?: string; intentSha256?: string };
      if (result?.requestSha256 !== requestHash(mode,changes,triggerLinks) || typeof result.intentSha256 !== 'string') throw new Error('Runs command ID conflicts with another canonical payload.');
      return { id,commandId: `${id}-commit`,sha256: result.intentSha256 };
    }
    const head = await this.head();
    if (!head.authority) throw new Error('Cannot write runs DB without imported authority.');
    return this.writeIntent({ mode, revision: head.revision, generation: head.authority.generation,...(triggerLinks ? { triggerLinks } : {}) }, changes, id);
  }
  /** A single admission includes its placeholder/provenance and required instructions in the final receipt TX. */
  async admit(input: { run: RunDocuments['runs'][number]; created?: RunDocuments['created'][number]; instructions?: RunDocuments['instructions'][string] }, id: string): Promise<RunWriteIdentity | undefined> {
    const documents: RunDocuments = { runs: [input.run], created: input.created ? [input.created] : [], instructions: input.instructions ? { [input.run.id]: input.instructions } : {} };
    if (input.created && input.created.runId !== input.run.id || (input.run as unknown as Record<string,unknown>).needsInstructions === true && !input.instructions) throw new Error('Admission dependencies are incomplete.');
    return this.update(rowsOf(documents).map(row => ({ ...row, previous: null })),'admission',id);
  }
  async transition(previous: RunDocuments['runs'][number], next: RunDocuments['runs'][number], id: string): Promise<RunWriteIdentity | undefined> {
    if (previous.id !== next.id) throw new Error('Run identity cannot change.');
    return this.update([{ kind: 'run', id: next.id, json: canonical(next), previous: canonical(previous) }],'transition',id);
  }
  async output(previous: RunDocuments['runs'][number], output: string, id: string): Promise<RunWriteIdentity | undefined> {
    return this.update([{ kind: 'run', id: previous.id, json: canonical({ ...previous, output }), previous: canonical(previous) }],'output',id);
  }
  async markers(previous: RunDocuments['runs'][number], markers: { needsInstructions?: true; keepQueued?: true; retain?: true }, instructions: RunDocuments['instructions'][string] | null | undefined, previousInstructions: RunDocuments['instructions'][string] | null, id: string): Promise<RunWriteIdentity | undefined> {
    const value = { ...previous } as unknown as Record<string,unknown>;
    for (const key of ['needsInstructions','keepQueued','retain']) delete value[key];
    Object.assign(value,markers);
    if (markers.needsInstructions && !instructions) throw new Error('Required run instructions are missing.');
    const changes: RunChange[] = [{ kind: 'run', id: previous.id, json: canonical(value), previous: canonical(previous) }];
    if (instructions === null && previousInstructions === null) throw new Error('Cannot delete absent instructions.');
    if (instructions !== undefined) changes.push({ kind: 'instruction', id: previous.id, json: canonical(instructions ?? previousInstructions), previous: previousInstructions === null ? null : canonical(previousInstructions), ...(instructions === null ? { remove: true } : {}) });
    return this.update(changes,'markers',id);
  }
  /** Explicit dependency deletion; no generic foreign-domain SQL or provider object. */
  async deleteRows(rows: readonly RunRow[], id: string): Promise<RunWriteIdentity | undefined> {
    return this.update(rows.map(row => ({ ...row, previous: row.json, remove: true })),'delete',id);
  }
  async restore(documents: RunDocuments, id: string, expectedGeneration?: number): Promise<RunWriteIdentity | undefined> {
    const rows = rowsOf(documents), digest = documentsHash(documents), head = await this.head();
    if (!head.authority || (expectedGeneration !== undefined && head.authority.generation !== expectedGeneration)) throw new Error('Runs restore belongs to another authority generation.');
    const receipt = await this.storage.receipt(`${id}-commit`);
    if (receipt.found) {
      const record = receipt.receipt;
      if (record.scope !== 'runs' || record.command !== 'commit' || record.result.state !== 'included') throw new Error('Runs restore receipt cannot be verified.');
      const result = record.result.value as { mode?: string; documentsSha256?: string };
      if (result?.mode !== 'restore' || result.documentsSha256 !== digest) throw new Error('Runs restore command ID conflicts with another intent.');
      return;
    }
    return this.writeIntent({ mode: 'restore', revision: head.revision, generation: head.authority.generation, documentsSha256: digest }, rows, id);
  }
  /** A refuses before staging. B must additionally supply sealed evidence and the common update evaluator. */
  async importPrepared(documents: RunDocuments, manifestSha256: string, id: string, verifyBeforeCommit?: () => Promise<void>): Promise<RunWriteIdentity> {
    if (!this.storage.context?.manifest.domains.find(domain => domain.scope === 'runs')?.cutover) throw new Error('Runs preparation has no cutover contract.');
    const head = await this.head();
    if (head.authority) throw new Error('Runs authority exists; JSON reimport is forbidden.');
    return this.writeIntent({ mode: 'import', revision: null, generation: null, manifestSha256, documentsSha256: documentsHash(documents) }, rowsOf(documents), id, verifyBeforeCommit);
  }
  /** Explicit receipt resolution, available while this owner's normal commands remain held. No replay/new ID. */
  async resolvePending(): Promise<CommitDisposition> {
    const pending = this.uncertain;
    if (!pending) { if (this.resolved) return this.resolved; throw new Error('No uncertain runs intent to resolve.'); }
    await this.storageGate();
    const receipt = await this.storage.receipt(pending.attemptedCommandId);
    if (receipt.found) {
      const record = receipt.receipt;
      if (record.scope !== 'runs' || record.payloadSha256 !== pending.attemptedPayloadSha256) throw new Error('Runs receipt identity/hash conflict.');
      if (pending.finalSent) {
        if (record.command !== 'commit' || record.result.state !== 'included' || (record.result.value as { intentSha256?: string })?.intentSha256 !== pending.sha256) throw new Error('Runs admission receipt cannot be verified.');
        this.uncertain = undefined; this.resolved = 'committed';
        return 'committed';
      }
    }
    // The SDK gate must be reopened/prepared after lost transport before absence is read.
    // A stage receipt cannot admit a run: final commit was never submitted.
    this.uncertain = undefined; this.resolved = 'not-committed';
    return 'not-committed';
  }
  private async writeIntent(header: RunIntentHeader, rows: readonly (RunRow | RunChange)[], id: string, verifyBeforeCommit?: () => Promise<void>): Promise<RunWriteIdentity> {
    await this.gate();
    await this.triggerGate(header.triggerLinks);
    const parts: Buffer[] = [Buffer.from(canonical({ ...header,requestSha256: requestHash(header.mode,rows,header.triggerLinks) }) + '\n')];
    let size = parts[0].length;
    for (const row of rows) {
      const line = Buffer.from(transferRow(row,header.mode === 'import' || header.mode === 'restore'));
      size += line.length;
      if (size > RUN_INTENT_BYTES) throw new Error('Runs intent exceeds its bounded lossless transfer allowance.');
      parts.push(line);
    }
    const bytes = Buffer.concat(parts), identity = { id, commandId: `${id}-commit`, sha256: runHash(bytes) };
    this.resolved = undefined; this.lastIntent = identity;
    const write = async (command: string, payload: unknown, commandId: string) => {
      try { await this.storage.write('runs',command,payload,commandId); }
      catch (error) {
        const disposition = (error as StorageCommandError)?.disposition;
        if (disposition === 'unknown' || disposition === 'committed') this.uncertain = { ...identity, attemptedCommandId: commandId, attemptedPayloadSha256: runHash(JSON.stringify(payload)), finalSent: command === 'commit', error };
        throw error;
      }
    };
    await write('begin',{ intent: id, bytes: bytes.length, sha256: identity.sha256, chunks: Math.ceil(bytes.length / RUN_CHUNK_BYTES) },`${id}-begin`);
    for (let offset = 0, part = 0; offset < bytes.length; offset += RUN_CHUNK_BYTES, part++) await write('stage',{ intent: id, part, data: bytes.subarray(offset,offset + RUN_CHUNK_BYTES).toString('base64') },`${id}-${part}`);
    await verifyBeforeCommit?.();
    await this.gate();
    await this.triggerGate(header.triggerLinks);
    await write('commit',{ intent: id },identity.commandId);
    return identity;
  }
}
