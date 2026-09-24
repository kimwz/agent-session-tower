import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/** How long a remote request ID is remembered. A retry older than this is refused instead of run again. */
export const REMOTE_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const UUID_V7 = /^[a-f\d]{8}-[a-f\d]{4}-7[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

/** What a remote request produced; replays read it again under the current sharing rules. */
export type RemoteResult =
  | { kind: 'session'; sessionId: string; runId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'autoPrompt'; jobId: string };
interface Entry { key: string; fingerprint: string; at: number; result?: RemoteResult }

const failure = (message: string, statusCode: number, disposition?: 'uncertain' | 'not-admitted') => Object.assign(new Error(message), { statusCode, ...(disposition ? { disposition } : {}) });

/** Identifies a request's content, so a retry can be told apart from a different request reusing its ID. */
export function requestFingerprint(content: unknown): string { return createHash('sha256').update(JSON.stringify(content)).digest('hex'); }

/** Remote request IDs are UUIDv7: their first 48 bits are the controller's clock in milliseconds. */
export function remoteRequestTime(id: string): number | undefined {
  if (!UUID_V7.test(id)) return undefined;
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

/**
 * Makes a remote controller's retry of the same request run once. The entry is written before the work
 * starts, so a crash in between leaves an "uncertain" answer rather than a second run.
 */
export class RemoteRequestLedger {
  private readonly path: string;
  private entries = new Map<string, Entry>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, private readonly now: () => number = Date.now) { this.path = join(stateDir, 'remote-requests.json'); }

  async start(): Promise<void> {
    let saved: unknown;
    try { saved = await readPrivateJson(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!Array.isArray(saved)) throw new Error('Saved remote request records are invalid.');
    for (const value of saved as Entry[]) {
      if (value && typeof value.key === 'string' && typeof value.fingerprint === 'string' && Number.isFinite(value.at)) this.entries.set(value.key, value);
    }
    this.prune();
  }

  /**
   * Runs `execute` once per (controller, operation, request ID). A repeat with the same content answers
   * from `replay`; a repeat with different content, or one whose outcome is unknown, is refused.
   */
  async once<T>(controllerId: string, operation: string, requestId: string, content: unknown, execute: () => Promise<T>,
    record: (value: T) => RemoteResult, replay: (result: RemoteResult) => T | undefined): Promise<T> {
    const issued = remoteRequestTime(requestId);
    const now = this.now();
    if (issued === undefined) throw failure('원격 요청 ID 형식이 올바르지 않습니다.', 400, 'not-admitted');
    if (issued < now - REMOTE_REQUEST_RETENTION_MS || issued > now + FUTURE_SKEW_MS) throw failure('너무 오래된 원격 요청입니다. 상태를 확인한 뒤 새로 보내세요.', 409, 'not-admitted');
    const key = `${controllerId}\n${operation}\n${requestId.toLowerCase()}`;
    const fingerprint = requestFingerprint(content);
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw failure('같은 요청 ID에 다른 내용을 보낼 수 없습니다.', 409, 'not-admitted');
      if (!previous.result) throw failure('이전 요청의 처리 여부가 확실하지 않습니다. 대화 상태를 확인한 뒤 필요하면 새로 보내세요.', 409, 'uncertain');
      const value = replay(previous.result);
      if (value === undefined) throw failure('이미 처리된 요청입니다. 세부 기록은 만료되었습니다.', 409, 'not-admitted');
      return value;
    }
    const entry: Entry = { key, fingerprint, at: now };
    this.entries.set(key, entry);
    try { await this.save(); }
    catch (error) { this.entries.delete(key); throw Object.assign(error as Error, { disposition: 'not-admitted' }); }
    let value: T;
    try { value = await execute(); }
    catch (error) {
      // Refused before admission: nothing ran, so the same ID may be sent again.
      const status = (error as { statusCode?: number }).statusCode;
      const disposition = (error as { disposition?: string }).disposition;
      if ((status !== undefined && status < 500 && disposition !== 'uncertain') || disposition === 'handoff' || disposition === 'not-admitted') {
        this.entries.delete(key);
        await this.save().catch(() => {});
      }
      throw error;
    }
    entry.result = record(value);
    await this.save().catch(() => {});
    return value;
  }

  flush(): Promise<void> { return this.writes.then(() => {}, () => {}); }

  private prune(): void {
    const cutoff = this.now() - REMOTE_REQUEST_RETENTION_MS;
    for (const [key, entry] of this.entries) if (entry.at < cutoff) this.entries.delete(key);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }

  private save(): Promise<void> {
    this.prune();
    const data = JSON.stringify([...this.entries.values()]);
    const write = this.writes.then(() => writePrivateJson(this.path, data));
    this.writes = write.catch(() => {});
    return write;
  }
}
