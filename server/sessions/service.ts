import { resolveExecLineage } from './exec-lineage.js';
import { EventEmitter } from 'node:events';
import { open, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { ChatMessage, Provider, Session, SessionDetail } from '../../shared/types.js';
import { sortSessions } from '../../shared/session-activity.js';
import { inspectProcesses, type ProcessSnapshot } from './processes.js';
import { appendFile, applyStatus, initial, ownHistory, parseMessages, walk, CHUNK, MAX_LINE, type RecordState } from './parser.js';

/**
 * Every term is lowercase; times are milliseconds, `until` excluded. Tool calls and results are searched only with `tools`.
 * `from` is a line start an earlier search stopped at; `maxBytes` and `deadline` bound one call.
 */
export interface SessionSearch { terms: string[]; since?: number; until?: number; tools?: boolean; keep: number; from?: number; maxBytes?: number; deadline?: number }
export interface SessionSearchResult { count: number; matches: Array<{ message: ChatMessage; cursor: number }>; bytes: number; next?: number }

/** A term as the JSONL writers store it inside a string: JSON-escaped, ASCII letters lowercased like the line it is looked for in. */
function rawNeedle(term: string): Buffer {
  const needle = Buffer.from(JSON.stringify(term).slice(1, -1));
  for (let index = 0; index < needle.length; index++) { const byte = needle[index]!; if (byte >= 65 && byte <= 90) needle[index] = byte + 32; }
  return needle;
}

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
  /** Launching sessions seen while a child's process was alive. The proof outlives the process. */
  private readonly launchers = new Map<string, string[]>();
  /** Non-interactive sessions whose process was already looked at once after they appeared. */
  private readonly checked = new Set<string>();

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
      if (Date.now() - this.lastProcesses > 8000) await this.inspect();
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
      // A run started by another agent may finish within seconds. Look at its process as soon as
      // its file appears instead of waiting for the regular process interval.
      const unchecked = [...this.records.values()].filter(state => !state.session.parentId && !state.session.isSubagent
        && (state.execOrigin || state.programmatic) && !this.checked.has(state.session.id));
      if (unchecked.some(state => Date.now() - Date.parse(state.session.createdAt) < 120_000) && Date.now() - this.lastProcesses > 1000) await this.inspect();
      for (const state of unchecked) this.checked.add(state.session.id);
      const live = new Set([...this.records.values()].map(state => state.session.id));
      for (const id of this.launchers.keys()) if (!live.has(id)) this.launchers.delete(id);
      for (const id of this.checked) if (!live.has(id)) this.checked.delete(id);
      this.index.clear();
      for (const state of this.records.values()) {
        if (state.internal) continue;
        if (!state.metadataSeen && !state.session.messageCount) continue;
        const duplicate = this.index.get(state.session.id);
        if (!duplicate || (duplicate.archived && !state.archived) || (duplicate.archived === state.archived && state.session.updatedAt > duplicate.session.updatedAt)) this.index.set(state.session.id, state);
      }
      if (resolveExecLineage(this.index.values(), this.launchers)) changed = true;
      this.scanning = false;
      if (changed) this.emit('change', this.list());
    } finally { this.scanning = false; }
  }

  private async inspect(): Promise<void> {
    this.processes = await this.readProcesses();
    this.lastProcesses = Date.now();
    // The first observation is the proof: it is taken while the run is young and its launcher alive.
    for (const [id, parents] of this.processes.launchers ?? []) if (!this.launchers.has(id)) this.launchers.set(id, parents);
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
      const previousUser = hasMore ? await this.previousUser(file, state, nextBefore, historyStart) : undefined;
      return { session: { ...state.session }, messages: collected.reverse().flat(), hasMore, nextBefore: hasMore ? nextBefore : undefined, ...(previousUser ? { previousUser } : {}) };
    } finally { await file.close(); }
  }

  /**
   * The messages of one conversation that contain every term (lowercase), read forward from its start or from `from`.
   * Only lines whose raw bytes could hold a term are parsed, so a search costs little more than reading the file. Keeps
   * the last `keep` matches, each with the cursor that pages `detail` back to just after it. Stops at a line boundary
   * once `maxBytes` or the `deadline` is reached, and says where to go on (`next`).
   */
  async search(id: string, query: SessionSearch): Promise<SessionSearchResult | undefined> {
    const state = this.index.get(id);
    if (!state) return undefined;
    const result: SessionSearchResult = { count: 0, matches: [], bytes: 0 };
    if (state.historyStartOrdinal !== undefined && state.historyStartOffset === undefined) return result;
    // A term whose letters outside ASCII have case cannot be found in the raw bytes; any other can.
    const plain = query.terms.find(term => ![...term].some(letter => letter > '\x7f' && letter.toUpperCase() !== letter));
    const needle = plain === undefined ? undefined : rawNeedle(plain);
    const escapes = plain !== undefined && /[^\x00-\x7f]/.test(plain) ? Buffer.from('\\u') : undefined;
    const file = await open(state.session.filePath!, 'r');
    let lowered = Buffer.alloc(0);
    const test = (line: Buffer, start: number): void => {
      if (needle) {
        if (line.length < needle.length) return;
        if (lowered.length < line.length) lowered = Buffer.allocUnsafe(Math.max(line.length, lowered.length * 2));
        for (let index = 0; index < line.length; index++) { const byte = line[index]!; lowered[index] = byte >= 65 && byte <= 90 ? byte + 32 : byte; }
        const view = lowered.subarray(0, line.length);
        if (view.indexOf(needle) === -1 && !(escapes && view.indexOf(escapes) !== -1)) return;
      }
      let row: Record<string, any>;
      try { row = JSON.parse(line.toString('utf8')); } catch { return; }
      if (!ownHistory(state, row, start)) return;
      for (const message of parseMessages(state.session.provider, row, start, state.session.createdAt)) {
        if (message.role === 'tool' && !query.tools) continue;
        const at = Date.parse(message.timestamp);
        if ((query.since !== undefined && !(at >= query.since)) || (query.until !== undefined && !(at < query.until))) continue;
        const text = message.text.toLowerCase();
        if (!query.terms.every(term => text.includes(term))) continue;
        result.count++;
        result.matches.push({ message, cursor: start + line.length + 1 });
        if (result.matches.length > query.keep) result.matches.shift();
      }
    };
    try {
      const first = Math.max(state.historyStartOffset ?? 0, query.from ?? 0);
      let position = first;
      let fragments: Buffer[] = [];
      let pending = 0;
      let lineStart = position;
      let oversized = false;
      while (position < state.offset) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK, state.offset - position));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        const data = buffer.subarray(0, bytesRead);
        let from = 0;
        for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, from)) {
          if (!oversized && pending + newline - from <= MAX_LINE) test(pending ? Buffer.concat([...fragments, data.subarray(from, newline)]) : data.subarray(from, newline), lineStart);
          fragments = []; pending = 0; oversized = false;
          from = newline + 1;
          lineStart = position + from;
        }
        const rest = data.subarray(from);
        if (!oversized && rest.length) {
          pending += rest.length;
          if (pending > MAX_LINE) { fragments = []; oversized = true; } else fragments.push(rest);
        }
        position += bytesRead;
        result.bytes += bytesRead;
        // Past the first line, so going on from here always moves forward.
        if (position < state.offset && lineStart > first && ((query.maxBytes !== undefined && result.bytes >= query.maxBytes) || (query.deadline !== undefined && Date.now() >= query.deadline))) {
          result.next = lineStart;
          break;
        }
      }
    } finally { await file.close(); }
    return result;
  }

  /**
   * Your last message before `from`, which what follows answers: the chat keeps it in view even when a long piece of
   * work pushed it off the page. Looked for within a bounded read, like a page.
   */
  private async previousUser(file: Awaited<ReturnType<typeof open>>, state: RecordState, from: number, historyStart: number): Promise<ChatMessage | undefined> {
    const userOn = (line: Buffer, start: number): ChatMessage | undefined => {
      try {
        const row = JSON.parse(line.toString('utf8'));
        return ownHistory(state, row, start) ? parseMessages(state.session.provider, row, start, state.session.createdAt).filter(message => message.role === 'user').at(-1) : undefined;
      } catch { return undefined; }
    };
    let position = from;
    let tail = Buffer.alloc(0);
    for (let scanned = 0; position > historyStart && scanned < 32 * 1024 * 1024;) {
      const length = Math.min(CHUNK, position - historyStart);
      const start = position - length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(chunk, 0, length, start);
      if (!bytesRead) return undefined;
      const data = Buffer.concat([chunk.subarray(0, bytesRead), tail]);
      let end = data.length;
      for (let newline = data.lastIndexOf(10, end - 1); newline !== -1; newline = end > 0 ? data.lastIndexOf(10, end - 1) : -1) {
        const found = userOn(data.subarray(newline + 1, end), start + newline + 1);
        if (found) return found;
        end = newline;
      }
      // The part before the first line break continues in the chunk before; a line too long to be chat is given up on.
      tail = data.subarray(0, end);
      if (tail.length > MAX_LINE) return undefined;
      position = start;
      scanned += bytesRead;
      if (position === historyStart) return userOn(tail, historyStart);
    }
    return undefined;
  }
}
