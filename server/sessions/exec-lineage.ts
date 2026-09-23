import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import type { RecordState } from './parser.js';

export interface ExecLaunch { toolId: string; cwd: string; prompt: string; startedAt: number; endedAt?: number; background?: boolean }
export const promptDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A deliberately small literal shell grammar. Never evaluates shell text. */
function words(command: string): string[] | undefined {
  const result: string[] = [];
  let word = '', quote = '', active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") { if (c === "'") quote = ''; else word += c; continue; }
    if (c === '$' || c === '`') return;
    if (c === '\\') { const next = command[++i]; if (!next) return; if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) word += '\\';
      if (next !== '\n') word += next; active = true; continue; }
    if (quote === '"') { if (c === '"') quote = ''; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === '\n' || c === '\r' || c === '#') return;
    if (/\s/.test(c)) { if (active) { result.push(word); word = ''; active = false; } continue; }
    if (';&|<>'.includes(c)) {
      if (active) { result.push(word); word = ''; active = false; }
      let op = c;
      if (command[i + 1] === c || (c === '>' && command[i + 1] === '&')) op += command[++i];
      result.push(op); continue;
    }
    if ('(){}*?~'.includes(c)) return;
    word += c; active = true;
  }
  if (quote) return;
  if (active) result.push(word);
  return result;
}

export function parseExecLaunch(command: unknown, originalCwd: string): { cwd: string; prompt: string } | undefined {
  if (typeof command !== 'string' || command.length > 200_000) return;
  // Accept only the observed status append, to the same literal output file.
  // All other expansions and command suffixes remain outside this grammar.
  const statusAppend = /;\s*echo exit=\$\? >> (\/[A-Za-z0-9_./-]+)\s*$/.exec(command);
  const tokens = words(statusAppend ? command.slice(0, statusAppend.index) : command);
  if (!tokens) return;
  let cwd = originalCwd;
  if (tokens[0] === 'cd') {
    if (!tokens[1] || !isAbsolute(tokens[1]) || tokens[2] !== '&&') return;
    cwd = tokens[1]; tokens.splice(0, 3);
  }
  if (tokens[0] === 'timeout' && /^\d+(?:[smh])?$/.test(tokens[1] ?? '')) tokens.splice(0, 2);
  if (tokens.shift() !== 'codex' || tokens.shift() !== 'exec') return;
  let prompt: string | undefined;
  let outputPath: string | undefined;
  while (tokens.length) {
    const token = tokens.shift()!;
    if (token === '-C' || token === '--cd') { const path = tokens.shift(); if (!path || !isAbsolute(path)) return; cwd = path; }
    else if (['-m', '--model', '-c', '--config', '-s', '--sandbox', '-o', '--output-last-message'].includes(token)) { if (!tokens.shift()) return; }
    else if (['--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', '--ephemeral'].includes(token)) continue;
    else if (token === '2' && tokens[0] === '>&' && tokens[1] === '1') tokens.splice(0, 2);
    else if (token === '>' && prompt !== undefined && outputPath === undefined && /^\/[A-Za-z0-9_./-]+$/.test(tokens[0] ?? '')) {
      outputPath = tokens.shift();
      if (tokens.join(' ') === '2 >& 1') tokens.length = 0;
      else if (tokens.length) return;
    }
    else if (token === '|' && tokens.join(' ').match(/^tail (?:-\d+|-n \d+)$/)) { tokens.length = 0; }
    else if (token === '--' && prompt === undefined && tokens.length === 1) prompt = tokens.shift();
    else if (!token.startsWith('-') && !['resume', 'review', '|', ';', '&&', '>', '<'].includes(token) && prompt === undefined) prompt = token;
    else return;
  }
  if (!prompt || !isAbsolute(cwd)) return;
  if (statusAppend && outputPath !== statusAppend[1]) return;
  return { cwd: normalize(cwd), prompt: promptDigest(prompt) };
}

export function resolveExecLineage(records: Iterable<RecordState>): boolean {
  const states = [...records];
  const before = states.map(s => `${s.session.parentId}:${s.session.parentLink}`);
  for (const { session } of states) if (session.parentLink === 'exec') {
    delete session.parentId; delete session.parentLink; session.isSubagent = false;
  }
  const launches = states.filter(parent => parent.session.provider === 'claude').flatMap(parent => (parent.execLaunches ?? []).map(launch => ({ parent, launch })));
  const candidates = states.filter(s => s.execOrigin && s.firstPrompt && !s.session.parentId && !s.session.isSubagent);
  const matches = candidates.map(child => ({ child, matches: launches.filter(({ parent, launch }) => {
    const created = Date.parse(child.session.createdAt);
    return parent !== child && Date.parse(parent.session.createdAt) <= created && normalize(child.session.cwd) === launch.cwd && child.firstPrompt === launch.prompt &&
      created >= launch.startedAt && created <= Math.min(launch.endedAt ?? Infinity, launch.startedAt + 30 * 60_000);
  }) }));
  for (const { child, matches: matched } of matches) {
    if (matched.length !== 1) continue;
    const match = matched[0]!;
    if (matches.filter(m => m.matches.includes(match)).length !== 1) continue;
    child.session.parentId = match.parent.session.id;
    child.session.parentLink = 'exec'; child.session.isSubagent = true;
  }
  return states.some((s, i) => before[i] !== `${s.session.parentId}:${s.session.parentLink}`);
}
