import type { RunnerCapability, SessionHistoryPage } from '../runs/runner-protocol.js';
import { SessionService } from './service.js';

interface Runner {
  supports(capability: RunnerCapability): boolean;
  sessionHistory(nativeId: string, before?: number, limit?: number): Promise<SessionHistoryPage | undefined>;
}
export interface NativeHistory {
  read(nativeId: string, before?: number, limit?: number): Promise<SessionHistoryPage | undefined>;
  start(): Promise<void>;
  stop(): void;
  /** True while this process is still building its own index of native history. */
  readonly indexing: boolean;
}

/**
 * The execution worker already indexes native history and serves it. Only a worker that
 * predates `sessionHistory` makes the web process keep its own index, and that index is used
 * solely to read conversations.
 */
export function nativeHistory(runner: Runner, createIndex: () => SessionService = () => new SessionService()): NativeHistory {
  if (runner.supports('sessionHistory')) {
    return { indexing: false, read: (nativeId, before, limit) => runner.sessionHistory(nativeId, before, limit), start: async () => {}, stop: () => {} };
  }
  const index = createIndex();
  let indexing = true;
  return {
    get indexing() { return indexing; },
    read: async (nativeId, before, limit) => {
      const detail = await index.detail(nativeId, before, limit);
      return detail && { messages: detail.messages, hasMore: detail.hasMore, ...(detail.nextBefore !== undefined ? { nextBefore: detail.nextBefore } : {}), ...(detail.previousUser ? { previousUser: detail.previousUser } : {}) };
    },
    start: async () => { try { await index.start(); } finally { indexing = false; } },
    stop: () => index.stop(),
  };
}
