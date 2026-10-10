import { createHash } from 'node:crypto';
import { RemoteRepository } from './storage-repository.js';
import { bootstrapExternal } from './storage-transfer.js';
import type { RemoteEntry } from './storage-codec.js';
import { TowerError, type ErrorKind } from '../../shared/errors.js';

/** How long a remote request ID is remembered. A retry older than this is refused instead of run again. */
export const REMOTE_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20_000;
const UUID_V7 = /^[a-f\d]{8}-[a-f\d]{4}-7[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

/** What a remote request produced; replays read it again under the current sharing rules. */
export type RemoteResult =
  | { kind: 'session'; sessionId: string; runId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'autoPrompt'; jobId: string }
  | { kind: 'compaction'; sessionId: string; jobId: string };
/** `at` is when this machine received it; `issued` is the controller's time inside the ID. */
type Entry = RemoteEntry;

/**
 * Only a definite non-admission permits deleting the durable intent. Error classes/status alone prove nothing.
 */
function refusedBeforeAdmission(error: unknown): boolean {
  const disposition = (error as { disposition?: string } | null)?.disposition;
  if (disposition === 'uncertain' || disposition === 'unknown' || disposition === 'committed') return false;
  return disposition === 'not-admitted' || disposition === 'not-committed';
}

const failure = (message: string, kind: ErrorKind, disposition?: 'uncertain' | 'not-admitted') => new TowerError(kind, message, disposition ? { disposition } : {});

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
  private readonly ordinals = new Map<string, number>();
  private nextOrdinal = 0;
  private entries = new Map<string, Entry>();
  /** Requests still running here: a retry that arrives meanwhile waits for the same outcome. */
  private readonly running = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now, private readonly capacity = MAX_ENTRIES, private readonly repository?: RemoteRepository, private readonly effectGate?: () => Promise<void>) {}

  async start(): Promise<void> {
    if (!this.repository) throw new Error('RemoteRequestLedger requires its worker SQL repository.');
    await bootstrapExternal(this.repository, this.stateDir);
    for (const { entry, ordinal } of await this.repository.load()) {
      this.entries.set(entry.key, entry); this.ordinals.set(entry.key, ordinal);
      this.nextOrdinal = Math.max(this.nextOrdinal, ordinal + 1);
    }
    await this.prune();
  }

  /**
   * Runs `execute` once per (controller, operation, request ID). A repeat with the same content answers
   * from `replay`; a repeat with different content, or one whose outcome is unknown, is refused.
   */
  async once<T>(controllerId: string, operation: string, requestId: string, content: unknown, execute: () => Promise<T>,
    record: (value: T) => RemoteResult, replay: (result: RemoteResult) => T | undefined): Promise<T> {
    const issued = remoteRequestTime(requestId);
    const now = this.now();
    if (issued === undefined) throw failure('원격 요청 ID 형식이 올바르지 않습니다.', 'invalid', 'not-admitted');
    if (issued > now + FUTURE_SKEW_MS) throw failure('요청 시각이 이 컴퓨터의 시계보다 너무 앞서 있습니다. 두 컴퓨터의 시계를 확인하세요.', 'conflict', 'not-admitted');
    // It may have run before its record expired; only a look at the conversation can tell.
    if (issued < now - REMOTE_REQUEST_RETENTION_MS) throw failure('너무 오래된 원격 요청입니다. 대화 상태를 확인한 뒤 필요하면 새로 보내세요.', 'conflict', 'uncertain');
    if (!controllerId || !operation || /[\n\r]/.test(controllerId + operation)) throw failure('원격 요청 범위가 올바르지 않습니다.', 'invalid', 'not-admitted');
    await this.repository!.gate();
    await this.prune();
    const key = `${controllerId}\n${operation}\n${requestId.toLowerCase()}`;
    const fingerprint = requestFingerprint(content);
    const inFlight = this.running.get(key);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) throw failure('같은 요청 ID에 다른 내용을 보낼 수 없습니다.', 'conflict', 'not-admitted');
      return inFlight.promise as Promise<T>;
    }
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw failure('같은 요청 ID에 다른 내용을 보낼 수 없습니다.', 'conflict', 'not-admitted');
      if (!previous.result) throw failure('이전 요청의 처리 여부가 확실하지 않습니다. 대화 상태를 확인한 뒤 필요하면 새로 보내세요.', 'conflict', 'uncertain');
      const value = replay(previous.result);
      // It ran; sending it again would run it twice.
      if (value === undefined) throw failure('이미 처리된 요청입니다. 세부 기록은 만료되었습니다.', 'conflict', 'uncertain');
      return value;
    }
    // A record still inside its window is never dropped to make room: forgetting it would let a retry run again.
    if (this.entries.size >= this.capacity) throw failure('이 컴퓨터가 최근 원격 요청을 너무 많이 받았습니다. 잠시 후 다시 보내세요.', 'unavailable', 'not-admitted');
    const promise = this.admit(key, fingerprint, now, issued, execute, record);
    this.running.set(key, { fingerprint, promise });
    try { return await promise; } finally { this.running.delete(key); }
  }

  private async admit<T>(key: string, fingerprint: string, at: number, issued: number, execute: () => Promise<T>, record: (value: T) => RemoteResult): Promise<T> {
    const entry: Entry = { key, fingerprint, at, issued };
    this.entries.set(key, entry);
    const ordinal = this.nextOrdinal++; this.ordinals.set(key, ordinal);
    try { await this.queue(() => this.repository!.put(entry, ordinal, null)); }
    catch (error) {
      if ((error as { disposition?: string }).disposition === 'not-committed') { this.entries.delete(key); this.ordinals.delete(key); throw Object.assign(error as Error, { disposition: 'not-admitted' }); }
      throw error;
    }
    let value: T;
    try { if (!this.effectGate) throw new Error('Remote effects require the worker effect gate.'); await this.effectGate(); await this.repository!.gate(); value = await execute(); }
    catch (error) {
      if (refusedBeforeAdmission(error)) {
        // Nothing ran, so the same ID may be sent again; the controller is told so.
        await this.queue(() => this.repository!.remove(entry, ordinal));
        this.entries.delete(key); this.ordinals.delete(key);
        if (error && typeof error === 'object' && !(error as { disposition?: string }).disposition) Object.assign(error, { disposition: 'not-admitted' });
      }
      throw error;
    }
    const completed = { ...entry, result: record(value) };
    await this.queue(() => this.repository!.put(completed, ordinal, entry));
    this.entries.set(key, completed);
    return value;
  }

  flush(): Promise<void> { return this.writes.then(() => this.repository!.gate()); }

  private async prune(): Promise<void> {
    const cutoff = this.now() - REMOTE_REQUEST_RETENTION_MS;
    for (const [key, entry] of this.entries) if (Math.max(entry.at, entry.issued) < cutoff) {
      await this.queue(async () => {
        if (this.entries.get(key) !== entry) return;
        await this.repository!.remove(entry, this.ordinals.get(key)!);
        this.entries.delete(key); this.ordinals.delete(key);
      });
    }
  }
  private queue(write: () => Promise<void>): Promise<void> {
    const pending = this.writes.then(write); this.writes = pending.catch(() => {}); return pending;
  }
}
