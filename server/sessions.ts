import { EventEmitter } from 'node:events';
import { open, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { ChatMessage, Provider, Session, SessionDetail } from '../shared/types.js';
import { sortSessions } from '../shared/session-activity.js';
import { inspectProcesses, type ProcessSnapshot } from './processes.js';
import { appendFile, applyStatus, initial, ownHistory, parseMessages, walk, CHUNK, MAX_LINE, type RecordState } from './sessions-parser.js';

interface SessionOptions { codexHome?: string; claudeHome?: string; pollIntervalMs?: number; inspectProcesses?: () => Promise<ProcessSnapshot> }

export class SessionService extends EventEmitter {
  readonly codexHome: string;
  readonly claudeHome: string;
  scanning = false;
  diagnostics: { provider: Provider; message: string }[] = [];
  private readonly interval: number;
  private readonly readProcesses: () => Promise<ProcessSnapshot>;
  private timer?: ReturnType<typeof setInterval>;
  private records = new Map<string, RecordState>();
  private index = new Map<string, RecordState>();
  private pendingRefresh?: Promise<void>;
  private lastProcesses = 0;
  private processes: ProcessSnapshot = { claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false } };

  constructor(options: SessionOptions = {}) {
    super();
    this.codexHome = options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
    this.claudeHome = options.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    this.interval = Math.max(250, options.pollIntervalMs ?? 1500);
    this.readProcesses = options.inspectProcesses ?? (() => inspectProcesses(this.claudeHome, this.codexHome));
  }

  async start(): Promise<void> {
    await this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.interval);
      this.timer.unref();
    }
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  list(): Session[] { return [...this.index.values()].map((record) => ({ ...record.session })).sort(sortSessions); }
  get(id: string): Session | undefined { const state = this.index.get(id); return state ? { ...state.session } : undefined; }

  refresh(forceProcesses = false): Promise<void> {
    if (this.pendingRefresh) return forceProcesses ? this.pendingRefresh.then(() => this.refresh(true)) : this.pendingRefresh;
    if (forceProcesses) this.lastProcesses = 0;
    this.pendingRefresh = this.scan().finally(() => { this.pendingRefresh = undefined; });
    return this.pendingRefresh;
  }

  private async scan(): Promise<void> {
    this.scanning = true;
    try {
      const [codex, archived, claude] = await Promise.all([
        walk(join(this.codexHome, 'sessions')), walk(join(this.codexHome, 'archived_sessions')), walk(join(this.claudeHome, 'projects')),
      ]);
      if (Date.now() - this.lastProcesses > 8000) {
        this.processes = await this.readProcesses();
        this.lastProcesses = Date.now();
      }
      const files = [...codex.map((path) => ({ path, provider: 'codex' as const, archived: false })),
        ...archived.map((path) => ({ path, provider: 'codex' as const, archived: true })),
        ...claude.map((path) => ({ path, provider: 'claude' as const, archived: false }))];
      const existing = new Set(files.map(({ path }) => path));
      let changed = false;
      this.diagnostics = [];
      let cursor = 0;
      // Limit concurrent giant JSONL records to keep startup memory bounded.
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (cursor < files.length) {
          const entry = files[cursor++]!;
          try {
            const info = await stat(entry.path);
            let state = this.records.get(entry.path);
            const before = state ? JSON.stringify(state.session) : '';
            if (!state || state.ino !== Number(info.ino) || info.size < state.size || (info.size === state.size && info.mtimeMs !== state.mtimeMs)) {
              state = initial(entry.path, entry.provider, info, entry.archived);
              this.records.set(entry.path, state);
            }
            if (info.size !== state.size || info.mtimeMs !== state.mtimeMs) await appendFile(state, info.size);
            state.size = info.size; state.mtimeMs = info.mtimeMs;
            applyStatus(state, this.processes, Date.now());
            if (before !== JSON.stringify(state.session)) changed = true;
          } catch (error) {
            if (this.diagnostics.length < 20) this.diagnostics.push({ provider: entry.provider, message: `Could not read ${basename(entry.path)}: ${(error as NodeJS.ErrnoException).code || 'read error'}` });
          }
        }
      }));
      for (const path of this.records.keys()) if (!existing.has(path)) { this.records.delete(path); changed = true; }
      this.index.clear();
      for (const state of this.records.values()) {
        if (state.internal) continue;
        if (!state.metadataSeen && !state.session.messageCount) continue;
        const duplicate = this.index.get(state.session.id);
        if (!duplicate || (duplicate.archived && !state.archived) || (duplicate.archived === state.archived && state.session.updatedAt > duplicate.session.updatedAt)) this.index.set(state.session.id, state);
      }
      this.scanning = false;
      if (changed) this.emit('change', this.list());
    } finally { this.scanning = false; }
  }

  /** `before` is an opaque byte cursor, stable when new messages are appended. */
  async detail(id: string, before?: number, limit = 60): Promise<SessionDetail | undefined> {
    const state = this.index.get(id);
    if (!state) return undefined;
    if (state.historyStartOrdinal !== undefined && state.historyStartOffset === undefined) {
      return { session: { ...state.session }, messages: [], hasMore: false };
    }
    const count = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 60));
    const file = await open(state.session.filePath!, 'r');
    const collected: ChatMessage[][] = [];
    let messageCount = 0;
    let position = Math.min(state.offset, before !== undefined && Number.isFinite(before) ? Math.max(0, Math.floor(before)) : state.offset);
    let fragments: Buffer[] = [];
    let pendingBytes = 0;
    let droppingOversizedLine = false;
    let bytesScanned = 0;
    let nextBefore = position;
    const historyStart = state.historyStartOffset ?? 0;
    const append = (fragment: Buffer): void => {
      if (droppingOversizedLine) return;
      pendingBytes += fragment.length;
      if (pendingBytes > MAX_LINE) { fragments = []; droppingOversizedLine = true; }
      else fragments.push(fragment);
    };
    const finishLine = (start: number): void => {
      if (!droppingOversizedLine && pendingBytes) {
        try {
          const line = Buffer.concat(fragments.reverse(), pendingBytes).toString('utf8');
          const row = JSON.parse(line);
          const messages = ownHistory(state, row, start) ? parseMessages(state.session.provider, row, start, state.session.createdAt) : [];
          if (messages.length) { collected.push(messages); messageCount += messages.length; }
        } catch { /* Ignore malformed or oversized lines. */ }
      }
      fragments = []; pendingBytes = 0; droppingOversizedLine = false;
      nextBefore = start;
    };
    try {
      // Bound work per request even for files filled with huge non-chat metadata records.
      while (position > historyStart && messageCount < count && bytesScanned < 32 * 1024 * 1024) {
        const length = Math.min(CHUNK, position - historyStart);
        const start = position - length;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(buffer, 0, length, start);
        if (!bytesRead) break;
        const data = buffer.subarray(0, bytesRead);
        let end = bytesRead;
        for (let newline = data.lastIndexOf(10, end - 1); newline !== -1; newline = end > 0 ? data.lastIndexOf(10, end - 1) : -1) {
          append(data.subarray(newline + 1, end));
          finishLine(start + newline + 1);
          end = newline;
          if (messageCount >= count) break;
        }
        if (messageCount >= count) break;
        append(data.subarray(0, end));
        position = start;
        bytesScanned += bytesRead;
        if (position === historyStart) finishLine(historyStart);
      }
      // If one oversized record exhausts the page budget, move through its bytes.
      // Without this, a >32 MB metadata line returns the same empty page forever.
      if (droppingOversizedLine && messageCount < count) nextBefore = position;
      const hasMore = nextBefore > historyStart;
      return { session: { ...state.session }, messages: collected.reverse().flat(), hasMore, nextBefore: hasMore ? nextBefore : undefined };
    } finally { await file.close(); }
  }
}
