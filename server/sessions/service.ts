import { resolveExecLineage } from './exec-lineage.js';
import { EventEmitter } from 'node:events';
import { open, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { ChatMessage, Provider, Session, SessionDetail } from '../../shared/types.js';
import { sortSessions } from '../../shared/session-activity.js';
import { LaunchProofFile } from './launch-proofs.js';
import { matchLaunchMarks, readLaunchMarks, type LaunchMark } from './launch-marks.js';
import { inspectProcesses, type ProcessSnapshot } from './processes.js';
import { appendFile, applyStatus, initial, ownHistory, parseMessages, walk, CHUNK, MAX_LINE, type RecordState } from './parser.js';

/**
 * Every term is lowercase; times are milliseconds, `until` excluded. Tool calls and results are searched only with `tools`.
 * `from` is where an earlier search of the same `file` stopped; `maxBytes` and `deadline` bound one call.
 */
export interface SessionSearch { terms: string[]; since?: number; until?: number; tools?: boolean; keep: number; from?: number; file?: number; maxBytes?: number; deadline?: number }
export interface SessionSearchResult { count: number; matches: Array<{ message: ChatMessage; cursor: number }>; bytes: number; file?: number; next?: number }

/** A term as the JSONL writers store it inside a string: JSON-escaped, ASCII letters lowercased like the line it is looked for in. */
function rawNeedle(term: string): Buffer {
  const needle = Buffer.from(JSON.stringify(term).slice(1, -1));
  for (let index = 0; index < needle.length; index++) { const byte = needle[index]!; if (byte >= 65 && byte <= 90) needle[index] = byte + 32; }
  return needle;
}

const GENERATION_BASE = Math.floor(Math.random() * 2 ** 31) * 2 ** 20;

interface SessionOptions {
  codexHome?: string; claudeHome?: string; pollIntervalMs?: number; inspectProcesses?: () => Promise<ProcessSnapshot>;
  /** Where proofs of agent-launched runs are kept, so they outlive this process. Without it they live only in memory. */
  launchProofs?: string;
  /** Where helper runs started inside Tower's turns leave marks naming who started them (see launch-marks.ts). */
  launchMarks?: string;
}

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
  /** Launching sessions seen while a child's process was alive. The proof outlives the process, and this process too when saved. */
  private readonly launchers = new Map<string, string[]>();
  private readonly proofFile?: LaunchProofFile;
  private readonly launchMarks?: string;
  private markRead: { changedAt: number; at: number; marks: LaunchMark[] } = { changedAt: -1, at: 0, marks: [] };
  private processesAt = 0;
  private proofsLoaded = false;
  private proofsChanged = false;
  /** Another worker is taking over: this one neither looks at sessions nor saves proofs until it resumes. */
  private quiesced = false;
  /** Non-interactive sessions whose process was already looked at once after they appeared. */
  private readonly checked = new Set<string>();
  private readonly generations = new WeakMap<RecordState, number>();
  private generationCount = 0;

  constructor(options: SessionOptions = {}) {
    super();
    this.codexHome = options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
    this.claudeHome = options.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    this.interval = Math.max(250, options.pollIntervalMs ?? 1500);
    this.readProcesses = options.inspectProcesses ?? (() => inspectProcesses(this.claudeHome, this.codexHome));
    if (options.launchProofs) this.proofFile = new LaunchProofFile(options.launchProofs);
    this.launchMarks = options.launchMarks;
  }

  async start(): Promise<void> {
    await this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.interval);
      this.timer.unref();
    }
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.proofFile?.close(); }
  /**
   * Before another worker takes over: no new scan starts, and once this resolves everything proved so far is on disk and nothing
   * more is written, so a successor that has read the file is never overwritten. It fails when the proofs could not be saved, so the
   * handover does not happen; `resume()` undoes it then.
   */
  async quiesce(): Promise<void> {
    this.quiesced = true;
    await this.pendingRefresh?.catch(() => {});
    // A write already queued may still fail; only once it settled is it known whether one more is needed.
    await this.proofFile?.flush();
    if ((this.proofsChanged || this.proofFile?.failed) && this.proofFile?.save(this.launchers, true)) this.proofsChanged = false;
    await this.proofFile?.flush();
    if (this.proofFile?.failed) throw new Error('Proofs of agent-launched runs could not be saved.');
  }
  resume(): void { this.quiesced = false; }
  list(): Session[] { return [...this.index.values()].map((record) => ({ ...record.session })).sort(sortSessions); }
  get(id: string): Session | undefined { const state = this.index.get(id); return state ? { ...state.session } : undefined; }
  /** A conversation's latest user requests, newest first, each shortened to 300 characters. */
  recentRequests(id: string): string[] { return [...(this.index.get(id)?.recentRequests ?? [])]; }

  refresh(forceProcesses = false): Promise<void> {
    if (this.quiesced) return this.pendingRefresh ?? Promise.resolve();
    if (this.pendingRefresh) return forceProcesses ? this.pendingRefresh.then(() => this.refresh(true)) : this.pendingRefresh;
    if (forceProcesses) this.lastProcesses = 0;
    this.pendingRefresh = this.scan().finally(() => { this.pendingRefresh = undefined; });
    return this.pendingRefresh;
  }

  private async scan(): Promise<void> {
    this.scanning = true;
    try {
      // Saved proofs come first: nothing is written before them, so a save can never drop what an earlier worker proved.
      if (this.proofFile && !this.proofsLoaded) {
        for (const [id, parents] of await this.proofFile.load()) if (!this.launchers.has(id)) this.launchers.set(id, parents);
        this.proofsLoaded = true;
      }
      // A provider whose history could not be listed completely (a folder unreadable or missing) proves no conversation of it is gone.
      const incomplete = new Set<Provider>();
      const [codex, archived, claude] = await Promise.all([
        walk(join(this.codexHome, 'sessions'), 6, () => incomplete.add('codex')), walk(join(this.codexHome, 'archived_sessions'), 6, () => incomplete.add('codex')),
        walk(join(this.claudeHome, 'projects'), 6, () => incomplete.add('claude')),
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
            incomplete.add(entry.provider);
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
      // A helper that was detached from its launcher, so the process tree no longer shows who started it, left a mark.
      if (this.launchMarks) {
        // The folder is read again only when it changed, or a minute later for expiry; matching runs on every scan.
        const changedAt = (await stat(this.launchMarks).catch(() => undefined))?.mtimeMs ?? 0;
        if (changedAt !== this.markRead.changedAt || Date.now() - this.markRead.at > 60_000) this.markRead = { changedAt, at: Date.now(), marks: await readLaunchMarks(this.launchMarks) };
        // A run that left a mark since the processes were last looked at is looked at now, while it may still be running.
        if (this.markRead.marks.some(mark => mark.at >= this.lastProcesses - 2000) && Date.now() - this.lastProcesses > 1000) await this.inspect();
        const { proofs, used } = matchLaunchMarks(this.markRead.marks, this.processes.owners ?? new Map(), this.processes.started ?? new Map(), live, this.processes.parents ?? new Map(), this.processesAt);
        let fresh = false;
        for (const [id, launcher] of proofs) if (!this.launchers.has(id)) { this.launchers.set(id, [launcher]); this.proofsChanged = true; fresh = true; }
        // A mark goes only once its proof is on disk: until then it is the only record of who started the run.
        if (fresh && this.proofFile && this.proofFile.save(this.launchers, true)) { this.proofsChanged = false; await this.proofFile.flush(); }
        if (!this.proofFile?.failed && used.length) {
          for (const mark of used) await rm(mark.file, { force: true }).catch(() => {});
          this.markRead.marks = this.markRead.marks.filter(mark => !used.includes(mark));
        }
      }
      // A history folder that lists nothing at all (renamed, not mounted) proves nothing is gone either.
      if (!codex.length && !archived.length) incomplete.add('codex');
      if (!claude.length) incomplete.add('claude');
      for (const id of this.launchers.keys()) {
        if (live.has(id) || incomplete.has(id.startsWith('codex:') ? 'codex' : 'claude')) continue;
        this.launchers.delete(id); this.proofsChanged = true;
      }
      for (const id of this.checked) if (!live.has(id)) this.checked.delete(id);
      this.index.clear();
      for (const state of this.records.values()) {
        if (state.internal) continue;
        if (!state.metadataSeen && !state.session.messageCount) continue;
        const duplicate = this.index.get(state.session.id);
        if (!duplicate || (duplicate.archived && !state.archived) || (duplicate.archived === state.archived && state.session.updatedAt > duplicate.session.updatedAt)) this.index.set(state.session.id, state);
      }
      if (resolveExecLineage(this.index.values(), this.launchers)) changed = true;
      if ((this.proofsChanged || this.proofFile?.failed) && this.proofFile?.save(this.launchers)) this.proofsChanged = false;
      this.scanning = false;
      if (changed) this.emit('change', this.list());
    } finally { this.scanning = false; }
  }

  private async inspect(): Promise<void> {
    // When the listing began: a process started after that may be missing from it.
    const began = Date.now();
    this.processes = await this.readProcesses();
    this.processesAt = began;
    this.lastProcesses = Date.now();
    // The first observation is the proof: it is taken while the run is young and its launcher alive.
    for (const [id, parents] of this.processes.launchers ?? []) if (!this.launchers.has(id)) { this.launchers.set(id, parents); this.proofsChanged = true; }
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
    let skipped = 0;
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
      if (droppingOversizedLine) skipped += 1;
      if (!droppingOversizedLine && pendingBytes) {
        try {
          const line = Buffer.concat(fragments.reverse(), pendingBytes).toString('utf8');
          const row = JSON.parse(line);
          const messages = ownHistory(state, row, start) ? parseMessages(state.session.provider, row, start, state.session.createdAt) : [];
          if (messages.length) { collected.push(messages); messageCount += messages.length; }
        } catch { skipped += 1; /* Malformed or oversized lines are left out, and counted. */ }
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
      return { session: { ...state.session }, messages: collected.reverse().flat(), hasMore, nextBefore: hasMore ? nextBefore : undefined, ...(previousUser ? { previousUser } : {}),
        ...(skipped ? { skipped } : {}) };
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
    const result: SessionSearchResult = { count: 0, matches: [], bytes: 0, file: this.generation(state) };
    if (state.historyStartOrdinal !== undefined && state.historyStartOffset === undefined) return result;
    // A term whose letters outside ASCII have case cannot be found in the raw bytes; any other can.
    const plain = query.terms.find(term => ![...term].some(letter => letter > '\x7f' && letter.toUpperCase() !== letter));
    const needle = plain === undefined ? undefined : rawNeedle(plain);
    const escapes = plain !== undefined && /[^\x00-\x7f]/.test(plain) ? Buffer.from('\\u') : undefined;
    // The only letters outside ASCII whose lowercase holds ASCII letters: İ (i̇) and the Kelvin sign (k).
    const folding = plain !== undefined && /[ik]/.test(plain) ? [Buffer.from('\u0130'), Buffer.from('\u212a')] : [];
    const file = await open(state.session.filePath!, 'r');
    let lowered = Buffer.alloc(0);
    const test = (line: Buffer, start: number): void => {
      if (needle) {
        if (line.length < needle.length) return;
        if (lowered.length < line.length) lowered = Buffer.allocUnsafe(Math.max(line.length, lowered.length * 2));
        for (let index = 0; index < line.length; index++) { const byte = line[index]!; lowered[index] = byte >= 65 && byte <= 90 ? byte + 32 : byte; }
        const view = lowered.subarray(0, line.length);
        if (view.indexOf(needle) === -1 && !(escapes && view.indexOf(escapes) !== -1) && !folding.some(letter => view.indexOf(letter) !== -1)) return;
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
      // A place in a file that was replaced since means nothing there: it is read again from its start.
      const first = Math.max(state.historyStartOffset ?? 0, query.from !== undefined && query.file === result.file && query.from <= state.offset ? query.from : 0);
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
        // Going on moves forward: from the line being read, or from inside a line too long to hold chat, which is never parsed
        // (its rest reads as a malformed line).
        if (position < state.offset && (lineStart > first || oversized) && ((query.maxBytes !== undefined && result.bytes >= query.maxBytes) || (query.deadline !== undefined && Date.now() >= query.deadline))) {
          result.next = oversized ? position : lineStart;
          break;
        }
      }
    } finally { await file.close(); }
    return result;
  }

  /**
   * Which reading of a file a state is: a file rewritten or replaced gets a new state, and so a new number. Numbers start
   * from a random base in each process, so a search resumed after a restart almost surely reads the conversation again.
   */
  private generation(state: RecordState): number {
    let number = this.generations.get(state);
    if (number === undefined) this.generations.set(state, number = GENERATION_BASE + ++this.generationCount);
    return number;
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
