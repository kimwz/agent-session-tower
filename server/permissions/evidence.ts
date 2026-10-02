import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const MAX_BYTES = 120_000;
const MAX_TOTAL = 180_000;
const MAX_FILES = 8;
const SCRIPT = /\.(?:py|mjs|cjs|js|ts|tsx|sh|bash|zsh|rb|pl|php|lua|ps1)$/i;
const PRIVATE = /(?:^|\/)(?:\.credentials(?:\.[^/]*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.kube|\.docker|\.env(?:\.[^/]*)?|\.ssh|\.aws|\.gnupg|auth(?:\.[^/]*)?|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\/|$)/i;

type FileEvidence = { path: string; status: 'read' | 'unavailable' | 'too-large' | 'excluded' | 'not-text'; text?: string };
export interface CommandEvidence { files: FileEvidence[]; notes: string[] }

/** Lexes only literal shell words. It never expands variables, substitutions or shell code. */
function tokens(command: string): string[] {
  return command.replace(/\\\r?\n/g, ' ').match(/\d*[<>]&[\d-]+|&>>?|<<<|<<-?|\d*[<>]{1,2}|(?:[^\s;&|<>(){}"'\\]+|"(?:\\.|[^"\\])*"|'[^']*'|\\.)+|&&|\|\||[;&|<>(){}\n]/g) ?? [];
}
function literal(token: string): string | undefined {
  if (/[$`*?{}~]/.test(token)) return undefined;
  return token.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g, (_, double: string | undefined, single: string | undefined, escaped: string | undefined) => single ?? escaped ?? double!.replace(/\\(["\\])/g, '$1'));
}

/** Direct local code and stdin evidence; contents are context, never instructions or authority. */
export async function commandEvidence(command: string, cwd: string): Promise<CommandEvidence> {
  const evidence: CommandEvidence = { files: [], notes: [] };
  const candidates = new Set<string>();
  const excludedInputs = new Set<string>();
  let folder: string | undefined = cwd;
  let start = true;
  let redirect: '<' | '>' | undefined;
  const parts = tokens(command.trim());
  const credentialInput = parts.some(part => /^(?:--with-token|--password-stdin|--password-file|--token-file|--client-secret-file)(?:=|$)/.test(literal(part) ?? ''));
  if (parts.some(token => token.includes('`') || ['(', ')', '{', '}', '<<', '<<-', '<<<'].includes(token))) {
    evidence.notes.push('Inline shell structure (group/subshell/heredoc) was not interpreted; judge inline code from the exact command and do not assume local file contents.');
    return evidence;
  }
  // Directory effects are sound for a linear AND chain: if a later command executes, every preceding cd succeeded.
  // Other control flow is deliberately not simulated. This is evidence collection, not another shell interpreter.
  const unsupported = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', '!',
    'time', 'chdir', 'pushd', 'popd', 'builtin', 'command', 'eval', 'source', '.', 'env', 'sudo', 'doas', 'nohup', 'exec']);
  if (parts.some(token => literal(token) === 'cd') && parts.some(token => ['||', ';', '|', '\n', '&'].includes(token))) {
    evidence.notes.push('Directory changes outside a linear && chain were not interpreted; no local file contents were assumed.');
    return evidence;
  }
  const separators = new Set(['&&', '||', ';', '|', '\n', '&']);
  const remotes = new Set(['ssh', 'docker', 'podman', 'kubectl', 'nerdctl', 'oc']);
  let nextScript = false;
  let interpreter = false;
  let shell = false;
  let inlineNext = false;
  let remote = false;
  let segmentEnd = parts.length;
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    if (separators.has(token)) { start = true; interpreter = false; inlineNext = false; nextScript = false; remote = false; redirect = undefined; continue; }
    if (start) {
      segmentEnd = i; while (segmentEnd < parts.length && !separators.has(parts[segmentEnd]!)) segmentEnd++;
      remote = parts.slice(i, segmentEnd).some(part => remotes.has(basename(literal(part) ?? '')));
      if (remote) evidence.notes.push('Remote/container command segment was not treated as local file execution.');
    }
    if (/^\d*[<>]&[\d-]+$/.test(token)) continue;
    if (token === '&>' || token === '&>>') { redirect = '>'; continue; }
    if (/^\d*[<>]{1,2}$/.test(token)) {
      if (start) { evidence.notes.push('Leading redirection was not interpreted; no local file contents were assumed.'); return evidence; }
      redirect = token.includes('<') ? '<' : '>'; continue;
    }
    if (redirect === '>') { redirect = undefined; continue; }
    if (start && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const word = literal(token);
    if (start && !word) { evidence.notes.push('Dynamic command name was not interpreted; no local file contents were assumed.'); return evidence; }
    if (start && word && unsupported.has(basename(word))) {
      evidence.notes.push('Shell control flow or command wrapper was not interpreted; no local file contents were assumed.');
      return evidence;
    }
    if (word === 'cd' && !start && !interpreter) { evidence.notes.push('Non-command cd word was not interpreted; no local file contents were assumed.'); return evidence; }
    if (start && word === 'cd') {
      const next = parts[i + 1];
      const target = next && !/^\d*[<>]/.test(next) && !['&&', '||', ';', '|', '\n', '&'].includes(next) ? literal(parts[++i]!) : undefined;
      folder = !target || target.startsWith('-') ? undefined : target.startsWith('/') ? resolve(target) : folder ? resolve(folder, target) : undefined;
      if (!folder) evidence.notes.push('Working directory was not resolved; relative files were not inspected.');
      start = false; continue;
    }
    const directScript = start && Boolean(word?.startsWith('./') || (word?.includes('/') && SCRIPT.test(word)));
    const interpreterFile = nextScript;
    if (start) {
      const program = basename(word ?? '');
      interpreter = /^(?:python[\d.]*|node|bash|sh|zsh|ruby|perl|php|lua|tsx)$/.test(program);
      shell = ['bash', 'sh', 'zsh'].includes(program);
      if (program === 'ruby' && parts.slice(i + 1, segmentEnd).some(part => /^-[^-]*[CXx]/.test(part))) {
        evidence.notes.push('Interpreter directory-changing options were not interpreted; no local file contents were assumed.'); return evidence;
      }
    }
    nextScript = start && interpreter;
    start = false;
    const input = redirect === '<';
    const output = redirect === '>';
    redirect = undefined;
    if (!word) { evidence.notes.push('Dynamic shell word was not expanded for inspection.'); continue; }
    if (inlineNext) { inlineNext = false; evidence.notes.push('Inline code is in the exact command; nested file paths were not interpreted.'); continue; }
    if (interpreter && (shell ? /^-[a-z]*c[a-z]*$/.test(word) : ['-c', '-e', '--eval', '--print'].includes(word))) { inlineNext = true; continue; }
    if (!input && !directScript && !interpreterFile && SCRIPT.test(word) && !interpreter) evidence.notes.push('Code argument for an unknown command runner was not resolved.');
    if (remote || output || word.startsWith('-') || (!input && !directScript && !interpreterFile && !(interpreter && SCRIPT.test(word)))) continue;
    if (!folder && !word.startsWith('/')) { evidence.notes.push(`Relative file not resolved: ${word}`); continue; }
    if (word.split('/').includes('..')) { evidence.notes.push('Parent traversal was not normalized through possible symlink directories.'); continue; }
    const path = resolve(folder ?? cwd, word);
    candidates.add(path);
    if (input && credentialInput) excludedInputs.add(path);
  }
  let total = 0;
  for (const path of candidates) {
    if (evidence.files.length >= MAX_FILES) { evidence.notes.push('Additional referenced files were not inspected (file count limit).'); break; }
    if (excludedInputs.has(path)) { evidence.files.push({ path, status: 'excluded' }); continue; }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const canonical = await realpath(path);
      if (PRIVATE.test(path) || PRIVATE.test(canonical) || /\.(?:pem|key|p12|pfx)$/i.test(basename(canonical))) {
        evidence.files.push({ path, status: 'excluded' }); continue;
      }
      file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile()) { evidence.files.push({ path, status: 'unavailable' }); continue; }
      if (stat.size > MAX_BYTES || total + stat.size > MAX_TOTAL) { evidence.files.push({ path, status: 'too-large' }); continue; }
      // Read at most the budget even if another process grows the file after stat.
      const buffer = Buffer.alloc(Math.min(MAX_BYTES, MAX_TOTAL - total) + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const next = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!next.bytesRead) break;
        bytesRead += next.bytesRead;
      }
      if (bytesRead > MAX_BYTES || total + bytesRead > MAX_TOTAL) { evidence.files.push({ path, status: 'too-large' }); continue; }
      const bytes = buffer.subarray(0, bytesRead);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { evidence.files.push({ path, status: 'not-text' }); continue; }
      if (text.includes('\0')) { evidence.files.push({ path, status: 'not-text' }); continue; }
      total += bytesRead;
      evidence.files.push({ path, status: 'read', text });
    } catch { evidence.files.push({ path, status: 'unavailable' }); }
    finally { await file?.close(); }
  }
  return evidence;
}
