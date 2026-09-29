import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Provider } from '../../shared/types.js';
import { codexShellCalls, worktreeAddPaths } from './commands.js';

/** A `git worktree add` an agent ran: the folder it names and when the call ran (end undefined until its result). */
export interface Creation { path: string; start: number; end?: number }

const MAX_LINE = 16 * 1024 * 1024;
type Json = Record<string, any>;

/**
 * The rows of a transcript from byte `from`, as it is now. `read.end` becomes the end of the last whole line, where a later
 * read of what was appended starts.
 */
async function* rows(file: string, keep: (line: string) => boolean, from = 0, read: { end: number } = { end: 0 }): AsyncGenerator<Json> {
  const size = (await stat(file)).size;
  read.end = Math.min(from, size);
  if (from >= size) return;
  const input = createReadStream(file, { encoding: 'utf8', start: from, end: size - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let offset = from;
  try {
    for await (const line of lines) {
      const next = offset + Buffer.byteLength(line) + 1;
      // A last line without its newline is still being written: it is read again next time.
      if (next <= size) read.end = next;
      offset = next;
      if (line.length > MAX_LINE || !keep(line)) continue;
      try { const row = JSON.parse(line); if (row && typeof row === 'object') yield row; } catch { /* A partial last line is skipped. */ }
    }
  } finally {
    // Closing readline leaves its file open; a search that stops early must close it too.
    lines.close();
    input.destroy();
  }
}

const at = (value: unknown): number | undefined => { const ms = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : undefined; };

/**
 * Every `git worktree add` in one transcript, with the times of its call and result. Only lines that can matter are parsed:
 * those naming a worktree, Codex's context rows (the default folder), and results of calls already found.
 * A missing file throws, so a caller never records a transcript it could not read as scanned.
 */
export async function transcriptCreations(file: string, provider: Provider, home: string, startCwd?: string): Promise<Creation[]> {
  const creations: Creation[] = [];
  const pending = new Map<string, Creation[]>();
  let cwd = startCwd;
  const keep = (line: string) => line.includes('worktree') || line.includes('"turn_context"') || line.includes('"session_meta"')
    || (pending.size > 0 && (line.includes('tool_use_id') || line.includes('call_id')) && [...pending.keys()].some(id => line.includes(id)));
  for await (const row of rows(file, keep)) {
    const time = at(row.timestamp);
    if (provider === 'claude') {
      if (!Array.isArray(row.message?.content) || time === undefined) continue;
      for (const part of row.message.content) {
        if (row.type === 'assistant' && part?.type === 'tool_use' && part.name === 'Bash' && typeof part.input?.command === 'string' && typeof part.id === 'string') {
          // Claude Code records the shell's current folder on every row.
          const found = worktreeAddPaths(part.input.command, typeof row.cwd === 'string' ? row.cwd : startCwd, home).map(path => ({ path, start: time }));
          creations.push(...found);
          if (found.length && part.input.run_in_background !== true) pending.set(part.id, found);
        } else if (row.type === 'user' && part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
          for (const creation of pending.get(part.tool_use_id) ?? []) creation.end = time;
          pending.delete(part.tool_use_id);
        }
      }
      continue;
    }
    const payload = row.payload ?? {};
    if (row.type === 'session_meta' && typeof payload.cwd === 'string') cwd ??= payload.cwd;
    if (row.type === 'turn_context' && typeof payload.cwd === 'string') cwd = payload.cwd;
    if (row.type !== 'response_item' || time === undefined) continue;
    if (['function_call_output', 'custom_tool_call_output'].includes(payload.type) && typeof payload.call_id === 'string') {
      for (const creation of pending.get(payload.call_id) ?? []) creation.end = time;
      pending.delete(payload.call_id);
      continue;
    }
    const found = codexShellCalls(payload, cwd).flatMap(call => worktreeAddPaths(call.command, call.cwd, home)).map(path => ({ path, start: time }));
    creations.push(...found);
    const id = payload.call_id ?? payload.id;
    if (found.length && typeof id === 'string') pending.set(id, found);
  }
  return creations;
}

/**
 * Which of `names` this transcript refers to in what its session did or was told: requests, answers, commands and the
 * folders it worked in. Tool output is left out, so a session that only listed worktrees does not hold them all.
 */
export async function transcriptMentions(file: string, names: readonly string[], from = 0): Promise<{ found: Set<string>; end: number }> {
  const found = new Set<string>();
  // Transcripts are JSON: a name is found as JSON writes it (a quote or backslash in it is escaped there).
  const written = new Map(names.map(name => [name, JSON.stringify(name).slice(1, -1)]));
  const wanted = (line: string) => names.some(name => !found.has(name) && line.includes(written.get(name)!));
  const read = { end: from };
  for await (const row of rows(file, wanted, from, read)) {
    const text = JSON.stringify(withoutOutput(row)) ?? '';
    for (const name of names) if (text.includes(written.get(name)!)) found.add(name);
    if (found.size === names.length) break;
  }
  return { found, end: read.end };
}

/**
 * A row without what the session only saw: tool output, and context the CLI injected by itself (Claude Code's git status
 * and other attachments, meta rows, Codex's workspace state and developer messages). A message queued by the owner stays.
 */
function withoutOutput(row: Json): unknown {
  if (row.type === 'event_msg' || row.type === 'world_state' || row.type === 'system' || row.isMeta === true) return undefined;
  if (row.type === 'attachment' && row.attachment?.type !== 'queued_command') return undefined;
  if (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role !== 'user' && row.payload.role !== 'assistant') return undefined;
  if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(row.payload?.type)) return undefined;
  if (row.type === 'user' && Array.isArray(row.message?.content)) {
    const { toolUseResult: _result, ...rest } = row;
    return { ...rest, message: { ...row.message, content: row.message.content.filter((part: Json) => part?.type !== 'tool_result') } };
  }
  return row;
}
