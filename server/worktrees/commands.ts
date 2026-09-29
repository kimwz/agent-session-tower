import { basename, isAbsolute, join, normalize, resolve } from 'node:path';

/**
 * Which worktrees a command an agent ran asked git to create. The shell text is read literally and never evaluated:
 * anything whose meaning depends on the shell at run time (`$`, backticks, globs) is not evidence, and a path that cannot
 * be resolved to one absolute folder is left out. Leaving a path out only means Tower keeps that worktree.
 */

interface Word { text: string; dynamic: boolean; quoted: boolean }
type Token = Word | { op: string };
const isWord = (token: Token | undefined): token is Word => Boolean(token && 'text' in token);

/** Splits shell text into words and operators; heredoc bodies and comments are dropped. */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: { delimiter: string; tabs: boolean }[] = [];
  let word = '', active = false, dynamic = false, quoted = false;
  const finish = () => {
    // Brace expansion (`a{b,c}`, `{1..3}`) makes one word many.
    if (active) tokens.push({ text: word, dynamic: dynamic || (!quoted && /\{[^}]*(?:,|\.\.)[^}]*\}/.test(word)), quoted });
    word = ''; active = false; dynamic = false; quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '\n') {
      finish();
      tokens.push({ op: '\n' });
      // A heredoc body starts on the next line and is data, never a command.
      for (const { delimiter, tabs } of heredocs.splice(0)) {
        while (i < command.length) {
          const end = command.indexOf('\n', i + 1);
          const line = command.slice(i + 1, end === -1 ? command.length : end);
          i = end === -1 ? command.length : end;
          if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
        }
      }
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) { word += command.slice(i + 1); i = command.length; active = true; dynamic = true; continue; }
      word += command.slice(i + 1, end); i = end; active = true; quoted = true; continue;
    }
    if (c === '"') {
      active = true; quoted = true;
      for (i++; i < command.length && command[i] !== '"'; i++) {
        const d = command[i]!;
        if (d === '$' || d === '`') dynamic = true;
        if (d === '\\' && i + 1 < command.length && ['$', '`', '"', '\\', '\n'].includes(command[i + 1]!)) { i++; if (command[i] !== '\n') word += command[i]; continue; }
        word += d;
      }
      if (i >= command.length) dynamic = true;
      continue;
    }
    if (c === '\\') { if (i + 1 < command.length && command[i + 1] !== '\n') { word += command[i + 1]; active = true; } i++; continue; }
    if (c === '#' && !active) { const end = command.indexOf('\n', i); i = (end === -1 ? command.length : end) - 1; continue; }
    if (/\s/.test(c)) { finish(); continue; }
    if (c === '$' || c === '`') { dynamic = true; word += c; active = true; continue; }
    if (c === '*' || c === '?' || c === '[') { dynamic = true; word += c; active = true; continue; }
    if (c === '~' && !active) { word += c; active = true; continue; }
    if (';&|()<>'.includes(c)) {
      // `2>&1`: the digits name a file descriptor, not a word.
      if ((c === '<' || c === '>') && active && !quoted && /^\d+$/.test(word)) { word = ''; active = false; }
      finish();
      let op = c;
      const next = command[i + 1];
      if ((c === '&' || c === '|' || c === ';' || c === '<' || c === '>') && next === c) { op += next; i++; }
      else if ((c === '>' || c === '<') && next === '&') { op += next; i++; }
      else if (c === '&' && next === '>') { op += next; i++; }
      if (op === '<<' && command[i + 1] === '<') { op = '<<<'; i++; }
      if (op === '<<') {
        const tabs = command[i + 1] === '-';
        if (tabs) i++;
        let j = i + 1;
        while (command[j] === ' ' || command[j] === '\t') j++;
        const match = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(command.slice(j));
        if (match) { heredocs.push({ delimiter: match[2]!, tabs }); i = j + match[0].length - 1; }
      }
      tokens.push({ op });
      continue;
    }
    word += c; active = true;
  }
  finish();
  return tokens;
}

const SEPARATORS = new Set([';', '&&', '||', '|', '&', '\n', '(', ')', ';;', '|&']);
const REDIRECTS = new Set(['<', '>', '>>', '<&', '>&', '&>', '<<<', '<>']);

/** Expands a word to a static path relative to `cwd`, or undefined when it depends on the shell at run time. */
function pathOf(word: Word, cwd: string | undefined, home: string): string | undefined {
  if (word.dynamic || !word.text) return undefined;
  let text = word.text;
  if (!word.quoted && (text === '~' || text.startsWith('~/'))) text = join(home, text.slice(1));
  else if (text.startsWith('~')) return undefined;
  if (isAbsolute(text)) return normalize(text);
  return cwd ? resolve(cwd, text) : undefined;
}

const GIT_VALUE_OPTIONS = new Set(['-c', '--config-env', '--exec-path', '--namespace', '--super-prefix', '--attr-source']);
const ADD_VALUE_OPTIONS = new Set(['-b', '-B', '--reason']);

/** First words that make the folder depend on how the shell runs what follows (conditions, loops, functions, negation). */
const CONTROL = new Set(['if', 'elif', 'while', 'until', 'for', 'case', 'select', 'function', 'time', 'builtin', '!', 'coproc']);

/**
 * The absolute paths of `git worktree add` commands in `command`, which starts in `cwd` (undefined when unknown).
 * `git -C` is resolved. A `cd` is followed only into a command it is joined to by `&&`, so the next command runs only if it
 * succeeded; a subshell or command substitution (`( … )`, `$( … )`) keeps its `cd` to itself. After a condition, loop or
 * function the folder is unknown. `echo …`, quoted text and heredoc bodies are never commands.
 */
export function worktreeAddPaths(command: string, cwd: string | undefined, home: string): string[] {
  if (command.length > 200_000) return [];
  const tokens = tokenize(command);
  const paths: string[] = [];
  let directory = cwd && isAbsolute(cwd) ? normalize(cwd) : undefined;
  const outer: (string | undefined)[] = [];
  let words: Word[] = [];
  let before: string | undefined;
  const simple = (end: string | undefined) => {
    const all = words; words = [];
    let index = 0;
    // Environment assignments and wrappers that run the rest as a command of its own.
    while (index < all.length) {
      const text = all[index]!.text;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) && !all[index]!.quoted) { index++; continue; }
      if (['env', 'command', 'nohup', 'exec', '{', '}', 'then', 'do', 'else'].includes(text)) { index++; continue; }
      if (text === 'timeout' || text === 'nice') { index++; while (all[index] && /^-/.test(all[index]!.text)) index++; if (text === 'timeout') index++; continue; }
      break;
    }
    const name = all[index];
    if (!name) return;
    if (name.dynamic || CONTROL.has(name.text)) { directory = undefined; return; }
    if (name.text === 'cd' || name.text === 'pushd') {
      const target = all[index + 1];
      // In a pipeline or in the background it runs in a subshell; joined by anything but `&&`, it may have failed.
      const effective = end === '&&' && before !== '|' && before !== '|&';
      directory = effective && target && target.text !== '-' && !target.text.startsWith('-') ? pathOf(target, directory, home) : undefined;
      return;
    }
    if (name.text === 'popd') { directory = undefined; return; }
    if (basename(name.text) !== 'git') return;
    let gitDirectory = directory;
    let i = index + 1;
    for (; i < all.length; i++) {
      const word = all[i]!;
      if (word.text === '-C') {
        const target = all[++i];
        gitDirectory = target ? pathOf(target, gitDirectory, home) : undefined;
        if (!gitDirectory) return;
      } else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(word.text)) return;
      else if (GIT_VALUE_OPTIONS.has(word.text)) i++;
      else if (word.text.startsWith('-')) continue;
      else break;
    }
    if (all[i]?.text !== 'worktree' || all[i + 1]?.text !== 'add') return;
    for (i += 2; i < all.length; i++) {
      const word = all[i]!;
      if (word.dynamic) return;
      if (word.text === '--') { i++; break; }
      if (ADD_VALUE_OPTIONS.has(word.text)) { i++; continue; }
      if (word.text.startsWith('-')) continue;
      break;
    }
    const target = all[i];
    const path = target && pathOf(target, gitDirectory, home);
    if (path) paths.push(path);
  };
  const run = (end: string | undefined) => { simple(end); before = end; };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (isWord(token)) { words.push(token); continue; }
    // A redirection's target is a file, not an argument; a heredoc's delimiter was consumed with its body.
    if (REDIRECTS.has(token.op)) { if (isWord(tokens[index + 1])) index++; continue; }
    if (!SEPARATORS.has(token.op)) continue;
    run(token.op);
    // A subshell or command substitution starts where its parent is and gives its folder back when it ends.
    if (token.op === '(') outer.push(directory);
    else if (token.op === ')') directory = outer.length ? outer.pop() : undefined;
  }
  run(undefined);
  return paths;
}

export interface ShellCall { command: string; cwd?: string }

/** The commands in one Codex tool call: JSON `exec_command`/`shell` arguments, `local_shell_call`, or the JS `exec` wrapper. */
export function codexShellCalls(payload: Record<string, any>, cwd: string | undefined): ShellCall[] {
  if (payload.type === 'local_shell_call') {
    const action = payload.action ?? {};
    const command = shellText(action.command);
    return command ? [{ command, cwd: typeof action.working_directory === 'string' ? action.working_directory : cwd }] : [];
  }
  if (payload.type === 'function_call') {
    let args: any;
    try { args = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments; } catch { return []; }
    if (!args || typeof args !== 'object') return [];
    const command = typeof args.cmd === 'string' ? args.cmd : shellText(args.command);
    const workdir = typeof args.workdir === 'string' ? args.workdir : typeof args.cwd === 'string' ? args.cwd : undefined;
    return command ? [{ command, cwd: workdir ? (isAbsolute(workdir) ? workdir : cwd && resolve(cwd, workdir)) : cwd }] : [];
  }
  if (payload.type === 'custom_tool_call' && typeof payload.input === 'string') return jsExecCalls(payload.input, cwd);
  return [];
}

/** `["bash", "-lc", "script"]` runs the script; any other argument vector is the command itself. */
function shellText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.every(part => typeof part === 'string')) return undefined;
  if (value.length === 3 && /(?:^|\/)(?:ba|z)?sh$/.test(value[0]) && /^-l?c$/.test(value[1])) return value[2];
  return value.map(part => /^[A-Za-z0-9_./:=@%+-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

/**
 * `tools.exec_command({cmd:"…", workdir:"…"})` calls in Codex's JS tool wrapper; string literals are read as JSON strings.
 * Only the object's own keys count, and a call whose `cmd` or `workdir` is not a literal is left out.
 */
function jsExecCalls(source: string, cwd: string | undefined): ShellCall[] {
  const calls: ShellCall[] = [];
  const pattern = /exec_command\(\s*\{/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const fields = objectFields(source, pattern.lastIndex);
    if (!fields || typeof fields.cmd !== 'string' || ('workdir' in fields && typeof fields.workdir !== 'string')) continue;
    const workdir = fields.workdir as string | undefined;
    calls.push({ command: fields.cmd, cwd: workdir ? (isAbsolute(workdir) ? workdir : cwd && resolve(cwd, workdir)) : cwd });
  }
  return calls;
}

/** The top-level keys of the object literal starting after `{` at `start`: string literals as strings, anything else `null`. */
function objectFields(source: string, start: number): Record<string, string | null> | undefined {
  const fields: Record<string, string | null> = {};
  let i = start;
  while (i < source.length) {
    const key = /^\s*(?:"(\w+)"|(\w+))\s*:\s*/.exec(source.slice(i, i + 200));
    if (!key) return /^\s*\}/.test(source.slice(i, i + 200)) ? fields : undefined;
    const name = key[1] ?? key[2]!;
    i += key[0].length;
    if (source[i] === '"') {
      const literal = stringLiteral(source, i);
      if (!literal) return undefined;
      fields[name] = literal.value; i = literal.end;
    } else {
      // Skip any other value up to the `,` or `}` that ends it at this level.
      fields[name] = null;
      for (let depth = 0; i < source.length; i++) {
        const c = source[i];
        if (c === '"') { const literal = stringLiteral(source, i); if (!literal) return undefined; i = literal.end - 1; continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') { if (depth === 0) break; depth--; }
        else if (c === ',' && depth === 0) break;
      }
    }
    const rest = /^\s*([,}])/.exec(source.slice(i, i + 200));
    if (!rest) return undefined;
    i += rest[0].length;
    if (rest[1] === '}') return fields;
  }
  return undefined;
}

function stringLiteral(source: string, start: number): { value: string; end: number } | undefined {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '"') {
      try { return { value: JSON.parse(source.slice(start, i + 1)), end: i + 1 }; } catch { return undefined; }
    }
  }
  return undefined;
}
