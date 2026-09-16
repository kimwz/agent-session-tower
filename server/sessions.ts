import { EventEmitter } from 'node:events';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ChatMessage, Provider, Session, SessionDetail } from '../shared/types.js';
import { sortSessions } from '../shared/session-activity.js';
import { inspectProcesses, type ProcessSnapshot } from './processes.js';
import { claudeContextUsage, claudeInputTokens, contextCapacity as contextWindow, contextTokens as tokenCount } from './session-context.js';

type Json = Record<string, any>;
type Activity = 'working' | 'completed' | 'error';
interface RecordState {
  session: Session;
  offset: number;
  size: number;
  mtimeMs: number;
  ino: number;
  metadataSeen: boolean;
  titleSet: boolean;
  activity: Activity;
  activityAt: number;
  explicitTurn: boolean;
  archived: boolean;
  timestampSeen: boolean;
  internal: boolean;
  ordinal: number;
  historyStartOrdinal?: number;
  historyStartOffset?: number;
}
interface SessionOptions { codexHome?: string; claudeHome?: string; pollIntervalMs?: number; inspectProcesses?: () => Promise<ProcessSnapshot> }

const CHUNK = 128 * 1024;
const MAX_LINE = 16 * 1024 * 1024;
const MAX_TEXT = 100_000;
const FRESH_MS = 120_000;

function text(value: unknown, maximum = MAX_TEXT): string {
  if (typeof value === 'string') return value.length > maximum ? `${value.slice(0, maximum)}\n… [truncated]` : value;
  if (Array.isArray(value)) return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'image' || part.type === 'input_image') return '[Image attachment]';
    return typeof part.text === 'string' ? part.text : '';
  }).filter(Boolean).join('\n').slice(0, maximum);
  return '';
}

function compact(value: string, max = 180): string { return value.replace(/\s+/g, ' ').trim().slice(0, max); }
function time(value: unknown, fallback: string): string {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}
function validTime(value: unknown): string | undefined {
  return time(value, '') || undefined;
}
function latestTime(previous: string | undefined, candidate: string | undefined): string | undefined {
  return candidate && (!previous || candidate > previous) ? candidate : previous;
}
function isInjectedUser(value: string): boolean {
  return /^(?:# AGENTS\.md instructions|<environment_context>|<recommended_plugins>|<INSTRUCTIONS>|<system-reminder>|\[Request interrupted by user)/.test(value.trim());
}
function printJson(value: unknown): string {
  if (typeof value === 'string') return text(value);
  return text(JSON.stringify(value ?? {}, null, 2));
}

/** Parse only messages people can see, excluding internal reasoning and prompt scaffolding. */
export function parseMessages(provider: Provider, row: Json, byteOffset = 0, fallbackTime = new Date(0).toISOString()): ChatMessage[] {
  const timestamp = time(row.timestamp, fallbackTime);
  if (provider === 'codex') {
    if (row.type !== 'response_item') return [];
    const value = row.payload ?? {};
    const id = String(value.id || value.call_id || byteOffset);
    if (value.type === 'agent_message') {
      const content = text(value.content);
      return content ? [{ id, role: 'system', text: content, timestamp }] : [];
    }
    if (value.type === 'message' && ['user', 'assistant'].includes(value.role)) {
      if (value.phase === 'analysis' || value.channel === 'analysis') return [];
      const kinds: string[] = value.internal_chat_message_metadata_passthrough?.content_item_kinds ?? [];
      const parts = Array.isArray(value.content) ? value.content.filter((_: unknown, index: number) =>
        value.role !== 'user' || !kinds[index] || /^(user\.|unknown)/.test(kinds[index]!)) : value.content;
      const content = text(parts);
      if (!content || (value.role === 'user' && isInjectedUser(content))) return [];
      return [{ id, role: value.role, text: content, timestamp }];
    }
    if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(value.type)) {
      const name = value.name || (value.type === 'local_shell_call' ? 'shell' : 'tool');
      return [{ id, role: 'tool', toolName: name, text: printJson(value.arguments ?? value.input ?? value.action), timestamp }];
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(value.type)) {
      return [{ id: `${id}:result`, role: 'tool', toolName: 'result', text: printJson(value.output), timestamp }];
    }
    return [];
  }
  if (!['user', 'assistant'].includes(row.type) || !row.message || row.isMeta) return [];
  const value = row.message;
  const id = String(row.uuid || value.id || byteOffset);
  const blocks: Json[] = Array.isArray(value.content) ? value.content : [{ type: 'text', text: value.content }];
  const messages: ChatMessage[] = [];
  let prose = '';
  const flush = () => {
    if (prose.trim() && !(value.role === 'user' && isInjectedUser(prose))) {
      messages.push({ id: `${id}:${messages.length}`, role: value.role === 'assistant' ? 'assistant' : 'user', text: text(prose.trim()), timestamp });
    }
    prose = '';
  };
  for (const block of blocks) {
    if (block.type === 'text') prose += `${text(block.text)}\n`;
    else if (block.type === 'image') prose += '[Image attachment]\n';
    else if (block.type === 'tool_use') {
      flush();
      messages.push({ id: String(block.id || `${id}:${messages.length}`), role: 'tool', toolName: block.name || 'tool', text: printJson(block.input), timestamp });
    } else if (block.type === 'tool_result') {
      flush();
      messages.push({ id: `${block.tool_use_id || id}:result`, role: 'tool', toolName: 'result', text: text(block.content), timestamp, isError: Boolean(block.is_error) });
    }
  }
  flush();
  return messages;
}

async function walk(directory: string, maxDepth = 6): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string, depth: number): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(path, entry.name));
      else if (entry.isDirectory() && depth < maxDepth) await visit(join(path, entry.name), depth + 1);
      // Do not follow symlinks out of the explicitly selected session roots.
    }
  }
  await visit(directory, 0);
  return files;
}

function initial(path: string, provider: Provider, info: Awaited<ReturnType<typeof stat>>, archived: boolean): RecordState {
  const subagent = provider === 'claude' && basename(dirname(path)) === 'subagents';
  const nativeId = provider === 'codex'
    ? basename(path).match(/([\da-f-]{36})\.jsonl$/i)?.[1] || basename(path, '.jsonl')
    : basename(path, '.jsonl').replace(/^agent-/, '');
  const createdAt = new Date(0).toISOString();
  return {
    session: {
      id: `${provider}:${nativeId}`, nativeId, provider, title: `${provider === 'codex' ? 'Codex' : 'Claude'} session`,
      cwd: '', project: 'Unknown project', parentId: subagent ? `claude:${basename(dirname(dirname(path)))}` : undefined,
      agentName: subagent ? nativeId : undefined, status: 'completed', statusReason: 'No running task detected',
      createdAt, updatedAt: createdAt, lastMessage: '', messageCount: 0, isSubagent: subagent,
      resumable: !subagent, filePath: path,
    },
    offset: 0, size: 0, mtimeMs: 0, ino: Number(info.ino), metadataSeen: false, titleSet: false,
    activity: 'completed', activityAt: 0, explicitTurn: false, archived, timestampSeen: false, internal: false, ordinal: 0,
  };
}

function ownHistory(state: RecordState, row: Json, offset: number): boolean {
  if (!state.session.isSubagent || state.session.provider !== 'codex') return true;
  if (state.historyStartOrdinal !== undefined) return state.historyStartOffset !== undefined && offset >= state.historyStartOffset;
  // Older rollouts preserve the original timestamps when copying parent history.
  return Date.parse(time(row.timestamp, state.session.createdAt)) >= Date.parse(state.session.createdAt);
}

/** Latest native context observation, never the cumulative billing counters. */
function consumeContext(session: Session, row: Json, timestamp: string): void {
  if (row.type === 'compacted' || (row.type === 'event_msg' && row.payload?.type === 'context_compacted')
    || (row.type === 'system' && row.subtype === 'compact_boundary')) {
    delete session.contextUsage;
    return;
  }
  if (session.provider === 'codex') {
    if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') return;
    const info = row.payload.info;
    if (!info) return; // Quota-only events carry no new context observation.
    const usedTokens = info.last_token_usage?.total_tokens;
    if (!tokenCount(usedTokens)) return;
    const capacity = info.model_context_window;
    session.contextUsage = { usedTokens, updatedAt: timestamp,
      ...(contextWindow(capacity) ? { contextWindow: capacity, usedPercent: usedTokens / capacity * 100 } : {}) };
    return;
  }
  if (row.type === 'assistant' && !row.isMeta && !String(row.message?.model || '').includes('synthetic')) {
    const usedTokens = claudeInputTokens(row.message?.usage);
    if (usedTokens === undefined) return;
    // Claude's native used_percentage counts prompt and cache tokens, excluding
    // output. Its capacity depends on native settings and cannot be inferred from
    // a model name. Catalog defaults remain explicitly marked as estimates.
    session.contextUsage = claudeContextUsage(session.model, usedTokens, timestamp, session.contextUsage);
  }
  if (row.type === 'result' && session.model && session.contextUsage) {
    const capacity = row.modelUsage?.[session.model]?.contextWindow;
    if (contextWindow(capacity)) {
      const { capacitySource: _estimated, ...usage } = session.contextUsage;
      session.contextUsage = { ...usage, contextWindow: capacity,
        usedPercent: usage.usedTokens / capacity * 100, updatedAt: timestamp };
    }
  }
}

function consume(state: RecordState, row: Json, offset: number, ordinal: number): void {
  if (state.internal) return;
  const s = state.session;
  const timestamp = time(row.timestamp, s.updatedAt);
  const at = Date.parse(timestamp);
  if (row.timestamp && !state.timestampSeen) {
    state.timestampSeen = true;
    s.createdAt = timestamp;
  }
  if (s.provider === 'codex' && row.type === 'session_meta' && !state.metadataSeen) {
    const value = row.payload ?? {};
    state.metadataSeen = true;
    // Codex's permission assessor is runtime machinery, not a user coding agent.
    // Keep legitimate code-reviewer children; only exclude its exact native source.
    state.internal = value.thread_source === 'guardian_review' || value.source?.subagent?.other === 'guardian';
    if (state.internal) return;
    s.nativeId = value.id || value.session_id || s.nativeId;
    s.id = `codex:${s.nativeId}`;
    s.createdAt = time(value.timestamp ?? row.timestamp, s.createdAt);
    s.updatedAt = s.createdAt;
    s.cwd = typeof value.cwd === 'string' ? value.cwd : s.cwd;
    const spawned = value.source?.subagent?.thread_spawn;
    const parent = value.parent_thread_id || spawned?.parent_thread_id;
    // A user-created fork can also have a parent. Only native spawn metadata makes it a subagent.
    s.isSubagent = Boolean(value.thread_source === 'subagent' || value.source?.subagent);
    s.parentId = parent ? `codex:${parent}` : undefined;
    if (s.isSubagent && Number.isSafeInteger(value.subagent_history_start_ordinal) && value.subagent_history_start_ordinal >= 0) {
      state.historyStartOrdinal = value.subagent_history_start_ordinal;
    }
    s.agentName = value.agent_nickname || spawned?.agent_nickname || value.agent_path?.split('/').pop();
    if (s.agentName) s.title = s.agentName;
  }
  // Current Codex rewrites copied timestamps. Its explicit persisted-record boundary
  // is the source of truth for the child's own messages, events and history cursor.
  if (state.historyStartOrdinal !== undefined && ordinal >= state.historyStartOrdinal && state.historyStartOffset === undefined) {
    state.historyStartOffset = offset;
  }
  if (!ownHistory(state, row, offset)) return;
  const previousModel = s.model;
  if (s.provider === 'claude') {
    if (!state.metadataSeen && row.sessionId) {
      state.metadataSeen = true;
      if (!s.isSubagent) { s.nativeId = row.sessionId; s.id = `claude:${s.nativeId}`; }
      else s.parentId = `claude:${row.sessionId}`;
    }
    if (typeof row.cwd === 'string') s.cwd = row.cwd;
    if (row.message?.model && !String(row.message.model).includes('synthetic')) s.model = row.message.model;
    const title = row.customTitle || row.aiTitle;
    if (typeof title === 'string' && title.trim()) { s.title = compact(title, 120); state.titleSet = true; }
  } else if (row.type === 'turn_context') {
    if (typeof row.payload?.model === 'string') s.model = row.payload.model;
    if (!s.cwd && typeof row.payload?.cwd === 'string') s.cwd = row.payload.cwd;
  }
  if (previousModel && s.model !== previousModel) delete s.contextUsage;
  consumeContext(s, row, timestamp);
  s.project = s.cwd ? basename(s.cwd) || s.cwd : 'Unknown project';

  const messages = parseMessages(s.provider, row, offset, timestamp);
  for (const message of messages) {
    s.messageCount++;
    if (message.role === 'user' && !state.titleSet) {
      s.title = compact(message.text, 100); state.titleSet = true;
    }
    if (['user', 'assistant'].includes(message.role)) s.lastMessage = compact(message.text);
  }
  if (row.timestamp && at > Date.parse(s.updatedAt)) s.updatedAt = timestamp;

  const rowTime = validTime(row.timestamp);
  const createdTime = row.payload?.internal_chat_message_metadata_passthrough?.create_time;
  const requestTime = s.provider === 'codex' && typeof createdTime === 'number' ? validTime(createdTime * 1000) ?? rowTime : rowTime;
  if (messages.some(message => message.role === 'user')) s.lastRequestAt = latestTime(s.lastRequestAt, requestTime);

  const setActivity = (activity: Activity) => { state.activity = activity; state.activityAt = at; };
  const setCompleted = (activity: 'completed' | 'error') => {
    setActivity(activity);
    s.lastCompletedAt = latestTime(s.lastCompletedAt, rowTime);
  };
  if (s.provider === 'codex') {
    const value = row.payload ?? {};
    if (row.type === 'event_msg') {
      if (['task_started', 'task_start', 'turn_started'].includes(value.type)) { state.explicitTurn = true; setActivity('working'); }
      if (['task_complete', 'task_completed', 'turn_complete', 'turn_completed'].includes(value.type)) { state.explicitTurn = false; setCompleted('completed'); }
      if (['turn_aborted', 'task_aborted', 'turn_interrupted', 'task_interrupted'].includes(value.type)) { state.explicitTurn = false; setCompleted('error'); }
      if (value.type === 'error' && !value.will_retry && !value.willRetry) setCompleted('error');
    }
    if (row.type === 'response_item') {
      if (value.type === 'message' && value.role === 'user' && messages.length) setActivity('working');
      if (value.type === 'message' && value.role === 'assistant' && ['final', 'final_answer'].includes(value.phase)) { state.explicitTurn = false; setCompleted('completed'); }
      else if (state.explicitTurn && ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'message'].includes(value.type)) setActivity('working');
    }
  } else {
    if (row.type === 'user' && row.message && !row.isMeta && messages.length) setActivity('working');
    if (row.type === 'assistant' && row.message && !row.isMeta) {
      if (['end_turn', 'stop_sequence'].includes(row.message.stop_reason)) setCompleted('completed');
      else if (row.message.stop_reason === 'max_tokens') setCompleted('error');
      else setActivity('working');
    }
    if (row.type === 'system' && row.subtype === 'turn_duration') setCompleted('completed');
    if (row.type === 'system' && row.subtype === 'stop_hook_summary' && !row.preventedContinuation) setCompleted('completed');
  }
}

/** Stream each file once, then only appended bytes. Keep summaries, never entire transcripts. */
async function appendFile(state: RecordState, end: number): Promise<void> {
  const file = await open(state.session.filePath!, 'r');
  let position = state.offset;
  let fragments: Buffer[] = [];
  let pendingBytes = 0;
  let droppingOversizedLine = false;
  const append = (fragment: Buffer): void => {
    if (droppingOversizedLine) return;
    pendingBytes += fragment.length;
    if (pendingBytes > MAX_LINE) { fragments = []; droppingOversizedLine = true; }
    else fragments.push(fragment);
  };
  try {
    while (position < end) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, end - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const data = buffer.subarray(0, bytesRead);
      let start = 0;
      for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, start)) {
        append(data.subarray(start, newline));
        if (!droppingOversizedLine) {
          try { consume(state, JSON.parse(Buffer.concat(fragments, pendingBytes).toString('utf8')), state.offset, state.ordinal); }
          catch { /* A malformed complete record cannot prevent later valid records. */ }
        }
        fragments = []; pendingBytes = 0; droppingOversizedLine = false;
        state.ordinal++;
        start = newline + 1;
        state.offset = position + start;
      }
      append(data.subarray(start));
      position += bytesRead;
    }
    // A final record without a newline may be in the middle of a write. Re-read it on the next append.
  } finally { await file.close(); }
}

function applyStatus(state: RecordState, processes: ProcessSnapshot, now: number): void {
  const s = state.session;
  const registry = s.provider === 'claude' && !s.isSubagent ? processes.claude.get(s.nativeId) : undefined;
  const active = registry !== undefined || (s.provider === 'codex' && processes.codex.has(s.nativeId));
  s.activeProcess = active;
  const fresh = state.activityAt > 0 && now - state.activityAt < FRESH_MS;
  if (registry?.name && !state.titleSet) s.title = compact(registry.name, 120);
  if (state.archived) {
    s.status = state.activity === 'completed' ? 'completed' : 'error';
    s.statusReason = state.activity === 'completed' ? 'Archived after the last task finished' : 'Archived without a completed last task';
    return;
  }
  // Process discovery is cached. An older idle registry cannot override a newly started
  // log turn, and an older busy registry cannot override a newer recorded completion.
  const registryCurrent = registry && (registry.updatedAt !== undefined ? registry.updatedAt >= state.activityAt : !fresh);
  if (registryCurrent && registry.status === 'busy') { s.status = 'working'; s.statusReason = 'Claude process reports an active task'; return; }
  if (registryCurrent && registry.status === 'idle') { s.status = 'idle'; s.statusReason = 'Claude process is waiting for input'; return; }
  if (state.activity === 'working' && (active || fresh)) {
    s.status = 'working';
    s.statusReason = active ? 'Active process with an unfinished task' : 'Recent unfinished task in session log';
  } else if (state.activity === 'error') {
    s.status = 'error'; s.statusReason = 'The last task was interrupted or failed';
  } else if (active) {
    s.status = 'idle'; s.statusReason = 'Session is open and waiting for input';
  } else if (state.activity === 'working') {
    s.status = 'error'; s.statusReason = 'Session activity stopped without a recorded task completion';
  } else {
    s.status = 'completed';
    s.statusReason = 'The last task finished';
  }
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
