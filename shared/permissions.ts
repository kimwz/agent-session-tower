import { z } from 'zod';

export type PermissionProvider = 'claude' | 'codex';
/**
 * `command` is a command prefix both providers understand (`gh pr merge`); `claude` is a Claude Code permission rule
 * for anything else (`WebFetch(domain:example.com)`, `mcp__server__tool`). `run` is no rule: a request to run one exact
 * command once, which Tower runs itself when it is allowed.
 */
export type PermissionKind = 'command' | 'claude' | 'run';
/** `conversation`: only the turns of one conversation (`sessionId`) receive it, until it expires. Claude Code only. */
export type PermissionScope = 'global' | 'project' | 'conversation';

export interface PermissionRuleInput {
  kind: PermissionKind;
  value: string;
  providers: PermissionProvider[];
  scope: PermissionScope;
  /** The project folder of a project rule; the conversation's folder of a conversation rule. */
  cwd?: string;
  /** The conversation a conversation rule belongs to. */
  sessionId?: string;
  /** When a conversation rule stops applying. */
  expiresAt?: string;
  note?: string;
}

export interface PermissionRule extends PermissionRuleInput {
  id: string;
  /** `auto`: Tower's reviewer allowed it for a request; such a rule also gets deny rules for its destructive variants (`ruleGuards`). */
  source: 'owner' | 'request' | 'auto';
  requestId?: string;
  createdAt: string;
  updatedAt: string;
}

/** `withdrawn`: the reviewer asked the agent for a narrower request instead. */
export type PermissionRequestStatus = 'pending' | 'approved' | 'denied' | 'withdrawn';

export type PermissionReviewVerdict = 'approve' | 'narrow' | 'owner';
/** What Tower's reviewer made of a request. */
export interface PermissionReview {
  /** `skipped`: not a request the reviewer may decide (`reason` says why); `failed`: the review did not finish. */
  status: 'queued' | 'running' | 'done' | 'skipped' | 'failed';
  verdict?: PermissionReviewVerdict;
  reason?: string;
  /** For `narrow`: what to ask for instead. */
  suggestion?: string;
  model?: string;
  at?: string;
}

/** The owner's setting for reviewing agents' requests automatically, in every project. */
export interface PermissionAutoReview {
  enabled: boolean;
  provider: PermissionProvider;
  model: string;
  /** Send the reviewer's decision to the requesting conversation. */
  resume: boolean;
}
export const AUTO_REVIEW_MODELS: Record<PermissionProvider, readonly string[]> = { claude: ['opus', 'sonnet'], codex: ['gpt-5.6-sol', 'gpt-5.6-terra'] };
export const DEFAULT_AUTO_REVIEW: PermissionAutoReview = { enabled: false, provider: 'claude', model: 'opus', resume: true };

export interface PermissionRequest {
  id: string;
  status: PermissionRequestStatus;
  rule: PermissionRuleInput;
  reason: string;
  sessionId: string;
  runId?: string;
  /** The folder the requesting session works in. */
  cwd: string;
  provider?: PermissionProvider;
  createdAt: string;
  decidedAt?: string;
  /** The rule an approval made, which may differ from what was asked. */
  ruleId?: string;
  /** Who decided it: the owner, or Tower's reviewer. */
  decidedBy?: 'owner' | 'auto';
  review?: PermissionReview;
  /** For a `run` request: the command's run, once allowed. */
  run?: PermissionRun;
  /** For a `run` request: what makes a retry the same request (the agent's key, or the conversation and command). */
  key?: string;
  keyExplicit?: boolean;
  timeoutSeconds?: number;
}

/** One exact command Tower ran for a request. The whole output is kept apart (`permission-runs/<id>.json`). */
export interface PermissionRun {
  status: 'waiting' | 'running' | 'done' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  /** The leader's pid (and process group) and the start time the OS reported, to know it again after a restart. */
  pid?: number;
  started?: string;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  /** The start of each stream, for the panel and a short answer. */
  preview?: { stdout: string; stderr: string };
  truncated?: boolean;
  error?: string;
  /** The result reached the agent (runResult), so no message is sent. */
  delivered?: boolean;
}
export interface PermissionRunOutput { stdout: string; stderr: string; truncated: boolean }
export const MAX_RUN_COMMAND = 4000;
export const MAX_RUN_SECONDS = 600;
export const CONVERSATION_RULE_HOURS = 24;

/** A file Tower writes rules into, and whether the last write worked. */
export interface PermissionTarget {
  provider: PermissionProvider;
  scope: PermissionScope;
  cwd?: string;
  path: string;
  rules: number;
  error?: string;
}

export interface PermissionOverview {
  rules: PermissionRule[];
  requests: PermissionRequest[];
  targets: PermissionTarget[];
  pending: number;
  /** An earlier record Tower could not read and set aside there: rules it added before may remain in the providers' files. */
  lost?: string;
  /** After a decision sent to the requesting conversation: whether it was sent. */
  resumed?: { sent: true } | { error: string };
  /** Absent from older workers. */
  autoReview?: PermissionAutoReview;
  /** After the owner saved a rule: rules Tower's reviewer had allowed that overlapped it and were removed. */
  replaced?: string[];
}

export const MAX_COMMAND_TOKENS = 12;
export const MAX_RULE_LENGTH = 300;
/** Characters that would let a prefix stand for more than one command, or quote around the rule. */
const SHELL_SYNTAX = /[;&|<>$`(){}'"\\*\n\r\t]/;
const CLAUDE_RULE = /^[A-Za-z][\w-]*(\([^\n\r]{1,300}\))?$/;
/** Programs that run whatever follows them: a rule for their bare name allows everything. */
const RUNS_ANYTHING = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'env', 'sudo', 'doas', 'xargs', 'exec', 'eval', 'command', 'nohup', 'timeout', 'time', 'nice',
  'python', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'osascript', 'npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uv', 'uvx', 'pipx', 'make', 'ssh']);

/** Control and invisible format characters, and halves of a character (which no rules file can hold). */
const UNREADABLE = /[\p{Cc}\p{Cf}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export const normalizeCommand = (value: string) => value.trim().split(/\s+/).filter(Boolean).join(' ');

/** Why a rule cannot be saved, or undefined when it can. Korean, like Tower's other server messages. */
export function ruleProblem(rule: Pick<PermissionRuleInput, 'kind' | 'value' | 'providers' | 'scope' | 'cwd'> & { sessionId?: string }): string | undefined {
  if (UNREADABLE.test(rule.value.replace(/[ \t]/g, ' ').replace(/\n/g, ' '))) return '규칙에는 제어 문자나 보이지 않는 문자를 쓸 수 없습니다.';
  if (rule.kind === 'run') {
    if (!rule.value.trim()) return '실행할 명령을 입력하세요.';
    if (rule.value.length > MAX_RUN_COMMAND) return '실행할 명령은 4000자 이하로 입력하세요.';
    return rule.cwd?.startsWith('/') ? undefined : '명령을 실행할 폴더가 필요합니다.';
  }
  if (rule.scope === 'conversation') {
    if (!rule.sessionId) return '대화 한정 규칙에는 대화가 필요합니다.';
    if (rule.providers.some(provider => provider !== 'claude')) return '대화 한정 규칙은 Claude Code에만 줄 수 있습니다.';
  }
  if (rule.kind === 'command') {
    const value = normalizeCommand(rule.value);
    if (!value) return '명령어를 입력하세요.';
    if (value.length > 200) return '명령어는 200자 이하로 입력하세요.';
    if (SHELL_SYNTAX.test(rule.value)) return '명령어에는 따옴표, 와일드카드(*), 파이프·리다이렉트 같은 셸 기호를 쓸 수 없습니다. 명령어 앞부분만 입력하세요.';
    if (value.split(' ').length > MAX_COMMAND_TOKENS) return '명령어는 12단어 이하로 입력하세요.';
  } else {
    const value = rule.value.trim();
    if (!CLAUDE_RULE.test(value)) return 'Claude 규칙은 Tool 또는 Tool(내용) 형식으로 한 줄에 입력하세요. 예: WebFetch(domain:example.com)';
    if (value.length > MAX_RULE_LENGTH) return 'Claude 규칙은 300자 이하로 입력하세요.';
  }
  if (!rule.providers.length) return '적용할 에이전트를 하나 이상 고르세요.';
  if (rule.kind === 'claude' && rule.providers.some(provider => provider !== 'claude')) return 'Claude 규칙은 Claude Code에만 적용됩니다.';
  if ((rule.scope === 'project' || rule.scope === 'conversation') && !rule.cwd?.startsWith('/')) return '프로젝트 규칙에는 프로젝트 폴더가 필요합니다.';
  return undefined;
}

/**
 * Whether a rule allows far more than one kind of action: a bare program that runs other programs, or a whole tool.
 * Such rules are allowed (the owner decides), but the owner is warned first.
 */
export function ruleIsBroad(rule: Pick<PermissionRuleInput, 'kind' | 'value'>): boolean {
  if (rule.kind === 'run') return false;
  if (rule.kind === 'command') {
    const words = normalizeCommand(rule.value).split(' ');
    const program = (words[0] ?? '').split('/').at(-1)!.toLowerCase().replace(/\d+(\.\d+)*$/, '');
    return words.length === 1 || (RUNS_ANYTHING.has(program) && words.length === 2);
  }
  const value = rule.value.trim();
  return !value.includes('(') || /\((\*|domain:\*)\)$/.test(value);
}

/** The rule Claude Code reads for this Tower rule. */
export function claudeRule(rule: Pick<PermissionRuleInput, 'kind' | 'value'>): string {
  return rule.kind === 'command' ? `Bash(${normalizeCommand(rule.value)} *)` : rule.value.trim();
}

/** The Codex `prefix_rule` line for a command rule. */
export function codexRule(rule: Pick<PermissionRuleInput, 'value'>): string {
  const pattern = normalizeCommand(rule.value).split(' ').map(word => JSON.stringify(word)).join(', ');
  return `prefix_rule(pattern=[${pattern}], decision="allow")`;
}

/** Two rules that mean the same thing in the same place. */
export const sameRule = (a: Pick<PermissionRuleInput, 'kind' | 'value' | 'scope' | 'cwd' | 'sessionId'>, b: Pick<PermissionRuleInput, 'kind' | 'value' | 'scope' | 'cwd' | 'sessionId'>) =>
  a.kind === b.kind && a.scope === b.scope && (a.scope === 'global' || a.cwd === b.cwd) && (a.scope !== 'conversation' || a.sessionId === b.sessionId)
  && (a.kind === 'command' ? normalizeCommand(a.value) === normalizeCommand(b.value) : a.value.trim() === b.value.trim());

/**
 * Command prefixes Tower's reviewer never allows, whatever the task: they delete, change the machine, reach secrets or
 * send data out. They always wait for the owner.
 */
export const NEVER_AUTO: readonly string[] = [
  'rm', 'rmdir', 'sudo', 'doas', 'su', 'chmod', 'chown', 'chflags', 'dd', 'mkfs', 'diskutil', 'launchctl', 'systemctl', 'security', 'defaults',
  'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'aws', 'gcloud', 'az',
  'crontab', 'git reset --hard', 'git clean', 'git filter-branch', 'git filter-repo', 'git push --force', 'git push -f', 'git push --mirror',
  'git push --delete', 'git update-ref', 'git reflog expire', 'git gc', 'git stash drop', 'git stash clear', 'git branch -D',
  'gh auth', 'gh secret', 'gh ssh-key', 'gh gpg-key', 'gh repo delete', 'gh api', 'gh release delete', 'gh variable',
  'npm unpublish', 'npm deprecate', 'npm owner', 'npm token', 'npm login', 'npm adduser', 'kubectl delete', 'docker rm', 'docker rmi', 'docker system prune',
  'terraform destroy', 'terraform apply', 'npm exec', 'pnpm dlx', 'pnpm exec', 'yarn dlx', 'git config', 'git update-index', 'git worktree remove',
  'gh run delete', 'gh extension', 'gh alias', 'npm x', 'cargo run', 'git submodule foreach', 'git bisect run', 'truncate', 'shred', 'unlink',
  // Containers and clusters run whatever they are given, often with the host's rights.
  'docker run', 'docker exec', 'docker container run', 'docker container exec', 'docker compose run', 'docker compose exec', 'docker compose down',
  'kubectl exec', 'kubectl run', 'kubectl cp', 'helm uninstall',
  // Secrets and where pushes go.
  'git credential', 'git remote', 'gh repo sync', 'gh cache delete', 'gh label delete', 'gh project delete', 'dropdb', 'redis-cli',
];

/**
 * Continuations that turn an otherwise ordinary command family destructive. A rule allows every command that starts
 * with its prefix, so a rule the reviewer allowed in one of these families is paired with deny rules for them.
 * A token ending in `*` stands for any word starting with what comes before it (`+*`: a forced refspec).
 */
export const DANGEROUS_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  // Any git command: options that run a program or write a file wherever they are pointed.
  'git': ['--upload-pack', '--receive-pack', '--exec', '--output', '--open-files-in-pager', '--ext-diff', '--textconv'],
  'git grep': ['-O'],
  'git switch': ['-f', '--force', '--discard-changes', '-C'],
  'git fetch': ['--force', '-f', '+*'],
  'git pull': ['--force', '-f', '+*'],
  'gh pr merge': ['--admin'],
  'gh pr checkout': ['--force', '-f'],
  'git push': ['--force', '-f', '--force-with-lease', '--force-if-includes', '--delete', '-d', '--mirror', '--prune', '+*', ':*'],
  'git branch': ['-D', '-d', '--delete', '-M', '-m', '--move', '-C', '-f', '--force'],
  'git tag': ['-d', '--delete', '-f', '--force'],
  'git checkout': ['-f', '--force', '-B', '.', './', ':/', '--'],
  'git rebase': ['-x', '--exec'],
  'git difftool': ['-x', '--extcmd'],
  'git mergetool': ['-t', '--tool'],
  'git restore': ['.', './', ':/'],
  'git stash': ['drop', 'clear'],
  'gh pr': ['close'],
  'gh release': ['delete', 'delete-asset'],
  'gh repo': ['delete', 'archive', 'edit', 'rename'],
  'gh issue': ['delete', 'transfer'],
  'npm publish': ['--force'],
  'docker': ['rm', 'rmi', 'system', 'volume', 'network'],
  'kubectl': ['delete'],
};

const words = (value: string) => normalizeCommand(value).split(' ').filter(Boolean);
/** Words compared case-insensitively: macOS finds `/bin/RM` for `RM`. */
const lower = (value: string) => words(value).map(word => word.toLowerCase());
const startsWith = (whole: readonly string[], part: readonly string[]) => part.length <= whole.length && part.every((word, index) => whole[index] === word);
const isOption = (token: string) => /^[-+:.]/.test(token);

/**
 * Every family a command belongs to, with its destructive continuations: `DANGEROUS_EXTENSIONS`, and the last word of
 * each never-allowed command (`git reset` + `--hard`, `git reflog` + `expire`).
 */
const FAMILIES = ((): [string[], string[]][] => {
  const found = Object.entries(DANGEROUS_EXTENSIONS).map(([family, tokens]) => [words(family), [...tokens]] as [string[], string[]]);
  for (const item of NEVER_AUTO) {
    const parts = words(item);
    if (parts.length >= 2) found.push([parts.slice(0, -1), [parts.at(-1)!]]);
  }
  return found;
})();

/** The destructive continuations of a command rule, from every family it belongs to. */
export function dangerousContinuations(value: string): string[] {
  const rule = lower(value);
  const found: string[] = [];
  for (const [prefix, tokens] of FAMILIES) {
    if (!startsWith(rule, prefix)) continue;
    // Options and refspecs can follow anywhere; a subcommand only right after the family (`gh pr` + `close`, not `gh pr merge` + `close`).
    found.push(...tokens.filter(token => !rule.slice(prefix.length).includes(token) && (isOption(token) || rule.length === prefix.length)));
  }
  return [...new Set(found)];
}

/**
 * The deny rules a rule Tower's reviewer allowed is paired with: Claude Code patterns (deny comes before allow, and
 * `*` matches any text anywhere) and Codex `prefix_rule` lines (which can only name what follows the prefix directly).
 */
export function ruleGuards(rule: Pick<PermissionRuleInput, 'kind' | 'value'>): { claude: string[]; codex: string[] } {
  if (rule.kind !== 'command') return { claude: [], codex: [] };
  const value = normalizeCommand(rule.value);
  const claude: string[] = [];
  const codex: string[] = [];
  for (const token of dangerousContinuations(value)) {
    // Options match by their start (`--force` also covers `--force=…` and `--force-with-lease=…`, `-f` also `-fu`), as do
    // refspecs (`+*`, `:*`); subcommands and bare `--` or `.` match as whole words. Combined short options (`-vf`) are not covered.
    const option = /^-[^-]|^--./.test(token);
    // An exact option (`--output`, not `--output-indicator-new`) matches itself and its `=value` form only.
    const start = token.endsWith('*') ? token : option && !EXACT_OPTIONS.has(token) ? `${token}*` : undefined;
    // git also takes any unambiguous start of a long option (`--del` for `--delete`): those spellings are denied as whole
    // words, so other options that merely share a start (`--follow-tags`, `--format`) stay allowed.
    for (const spelling of abbreviations(token)) claude.push(`Bash(${value} ${spelling})`, `Bash(${value} ${spelling} *)`, `Bash(${value} * ${spelling})`, `Bash(${value} * ${spelling} *)`);
    // Claude Code reads a rule ending in `:*` as its older prefix syntax, never as a wildcard, so a `:ref` can only be
    // denied when more follows it; a trailing `:ref` is not blocked for Claude.
    if (start?.endsWith(':*')) claude.push(`Bash(${value} ${start} *)`, `Bash(${value} * ${start} *)`);
    else if (start) claude.push(`Bash(${value} ${start})`, `Bash(${value} * ${start})`);
    else {
      claude.push(`Bash(${value} ${token})`, `Bash(${value} ${token} *)`, `Bash(${value} * ${token})`, `Bash(${value} * ${token} *)`);
      if (option) claude.push(`Bash(${value} ${token}=*)`, `Bash(${value} * ${token}=*)`);
    }
    if (token.endsWith('*')) continue;
    // Codex matches whole words: the option and every abbreviation git would take are named.
    for (const spelling of [...abbreviations(token), token]) codex.push(`prefix_rule(pattern=[${[...words(value), spelling].map(word => JSON.stringify(word)).join(', ')}], decision="forbidden")`);
  }
  return { claude, codex };
}

/** Options whose longer relatives are harmless, so they are denied as themselves rather than by their start. */
const EXACT_OPTIONS = new Set(['--output']);
/** Harmless git options that are also a start of a dangerous one (`--text` of `--textconv`): never denied as an abbreviation. */
const REAL_OPTIONS = new Set(['--text', '--ext', '--out', '--prune-tags']);

/** The shorter spellings git accepts for a long option: any unambiguous start, down to one letter (`--d` for `--delete`). */
function abbreviations(token: string): string[] {
  return /^--./.test(token) ? Array.from({ length: Math.max(0, token.length - 3) }, (_, index) => token.slice(0, index + 3)).filter(spelling => !REAL_OPTIONS.has(spelling)) : [];
}

/** Whether two command rules overlap: one is the other or starts with it. */
export function rulesOverlap(a: string, b: string): boolean {
  const left = lower(a), right = lower(b);
  return startsWith(left, right) || startsWith(right, left);
}

/** Whether `given` allows no more than `asked`: the same kind of rule, the same or a longer prefix, no wider scope, no more agents. */
export function ruleIsNarrower(asked: PermissionRuleInput, given: PermissionRuleInput): boolean {
  if (asked.kind !== given.kind) return false;
  if (!given.providers.every(provider => asked.providers.includes(provider))) return false;
  if (asked.scope === 'project' && (given.scope !== 'project' || given.cwd !== asked.cwd)) return false;
  if (asked.kind === 'command') return startsWith(words(given.value), words(asked.value));
  return given.value.trim() === asked.value.trim();
}

/** Programs that run the command after them: a rule starting with one is really a rule for whatever follows. */
const WRAPPERS = new Set(['env', 'sudo', 'doas', 'xargs', 'exec', 'eval', 'command', 'nohup', 'timeout', 'time', 'nice', 'ionice', 'caffeinate', 'watch',
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'ssh', 'script', 'unbuffer', 'stdbuf', 'find',
  // Code runners: what they run is whatever they are given.
  'npx', 'pnpx', 'bunx', 'uvx', 'uv', 'pipx', 'node', 'tsx', 'ts-node', 'python', 'python3', 'perl', 'ruby', 'php', 'lua', 'deno', 'bun', 'go', 'osascript', 'awk', 'sed']);
/** Never-allowed programs that are dangerous wherever they appear in a rule (`xargs rm`, `docker container rm`). */
const RUN_ANYWHERE = new Set(['rm', 'rmdir', 'sudo', 'doas', 'chmod', 'chown', 'mkfs', 'kill', 'killall', 'pkill', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'prune']);


/** Programs whose options before the subcommand (`git -C dir push`) hide what the rule is for. */
const SUBCOMMAND_PROGRAMS = new Set(['git', 'gh', 'docker', 'kubectl', 'npm', 'pnpm', 'yarn', 'cargo', 'terraform', 'helm']);

/**
 * Whether a word of a rule is a family's dangerous token in any spelling the program accepts: an option with its
 * `=value`, a longer form (`--force-with-lease` of `--force`), an abbreviation (`--del`), a short option among others
 * (`-vf`), or a refspec (`+main`, `:main`). Harmless options (`--squash`, `--follow-tags`) are not.
 */
function dangerousWord(word: string, token: string): boolean {
  if (token.endsWith('*')) return word.length >= token.length && word.startsWith(token.slice(0, -1));
  if (/^--./.test(token)) {
    const name = word.split('=')[0]!;
    if (name === token || (!EXACT_OPTIONS.has(token) && name.startsWith(token))) return true;
    return name.startsWith('--') && name.length >= 3 && token.startsWith(name) && !REAL_OPTIONS.has(name);
  }
  if (/^-[^-]$/.test(token)) return /^-[^-]/.test(word) && word.slice(1).split('=')[0]!.includes(token[1]!);
  return word === token;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS']);
const MCP_TOOL = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const MCP_DANGER = new Set(['send', 'post', 'publish', 'deploy', 'delete', 'remove', 'drop', 'destroy', 'purge', 'truncate', 'exec', 'execute', 'sql', 'transfer', 'pay', 'charge', 'upload', 'invite']);
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);

/**
 * Why Tower's reviewer may not decide this rule for work in `cwd`, or undefined when it may. Broad rules, Bash rules
 * written as Claude rules, file rules outside the project and the never-allowed commands always wait for the owner.
 */
/**
 * Why Tower's reviewer may not allow running this exact command once, or undefined when it may: raising privileges,
 * acting on the whole machine, or running a download straight into a shell always wait for the owner. The rest is the
 * reviewer's to judge, the whole command in view (a specific `kill 13229` or `rm dist/old.log` can be fine).
 */
export function runBlock(command: string): string | undefined {
  const text = command.toLowerCase();
  if (/(^|[\s;&|(`$])(sudo|doas|su)(\s|$)/.test(text)) return '권한을 올리는 명령(sudo 등)은 소유자가 정합니다.';
  if (/(^|[\s;&|(`$])(shutdown|reboot|halt|poweroff|mkfs[\w.]*|diskutil|fdisk)(\s|$)/.test(text)) return '컴퓨터 전체에 영향을 주는 명령은 소유자가 정합니다.';
  if (/(^|[\s;&|(`$])dd(\s|$)[^\n]*\bof=\/dev\//.test(text)) return '장치에 직접 쓰는 명령은 소유자가 정합니다.';
  if (/(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh)\b/.test(text)) return '내려받은 것을 바로 셸로 실행하는 명령은 소유자가 정합니다.';
  return undefined;
}

export function autoReviewBlock(rule: Pick<PermissionRuleInput, 'kind' | 'value'>, cwd: string): string | undefined {
  if (rule.kind === 'run') return runBlock(rule.value);
  if (rule.kind === 'command') {
    const rulewords = lower(rule.value);
    const program = words(rule.value)[0] ?? '';
    if (ruleIsBroad(rule)) return '프로그램 하나 전체를 허용하는 넓은 규칙은 소유자가 정합니다.';
    // Only a program named by itself, in lower case, is classified: a path, a wrapper or options before the subcommand hide it.
    if (!/^[a-z0-9][a-z0-9._+-]*$/.test(program)) return '경로나 대문자로 부른 프로그램의 규칙은 소유자가 정합니다.';
    if (WRAPPERS.has(program) || WRAPPERS.has(program.replace(/\d+(\.\d+)*$/, ''))) return `\`${program}\`처럼 다른 명령이나 코드를 실행하는 프로그램의 규칙은 소유자가 정합니다.`;
    if (rulewords.slice(1).some(word => /[*?[\]{}~]/.test(word))) return '특수 기호가 들어 있는 규칙은 소유자가 정합니다.';
    // Options before the subcommand (`git -C dir push`) hide what the rule is for.
    if (SUBCOMMAND_PROGRAMS.has(program) && rulewords[1]?.startsWith('-')) return '하위 명령 앞에 옵션이 있는 규칙은 소유자가 정합니다.';
    const never = NEVER_AUTO.find(item => startsWith(rulewords, words(item))) ?? rulewords.find(word => RUN_ANYWHERE.has(word));
    if (never) return `\`${never}\`가 들어 있는 명령은 자동으로 허용하지 않습니다.`;
    // A rule whose own words already make it destructive (`git push origin +main`, `git reset HEAD --hard`).
    for (const [prefix, tokens] of FAMILIES) {
      if (!startsWith(rulewords, prefix)) continue;
      // Options keep their case (`-B` is not `-b`, `-X` is not `-x`); long options and subcommands are matched in lower case.
      // A subcommand counts only right after the family (`git stash drop`), never as a later word (`git commit -m drop`).
      const rest = words(rule.value).slice(prefix.length);
      // The subcommand is the first word that is not an option, or an option's value (`gh release --repo o/r delete`).
      const first = rest.findIndex((word, index) => !word.startsWith('-') && !(index > 0 && rest[index - 1]!.startsWith('-') && !rest[index - 1]!.includes('=')));
      const subcommands = new Set(rest.slice(0, first < 0 ? rest.length : first + 1).filter(word => !word.startsWith('-')));
      const found = rest.find(word => tokens.some(token => (/^[-+:.]/.test(token) || subcommands.has(word))
        && (dangerousWord(word, token) || (word.startsWith('--') && dangerousWord(word.toLowerCase(), token)) || (!word.startsWith('-') && dangerousWord(word.toLowerCase(), token)))));
      if (found) return `\`${prefix.join(' ')}\`에 \`${found}\`가 붙은 규칙은 소유자가 정합니다.`;
    }
    return undefined;
  }
  const value = rule.value.trim();
  if (MCP_TOOL.test(value)) {
    // A tool that sends, deletes, runs or pays is the owner's to allow, like its command counterparts. Only the tool's own
    // words count (not the server's name), and only whole ones (`list_deployments` only reads).
    const words = value.split('__').slice(2).join('_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_-]+/);
    if (words.some(word => MCP_DANGER.has(word))) return '보내기·삭제·실행·배포 같은 일을 하는 MCP 도구는 소유자가 정합니다.';
    return undefined;
  }
  if (ruleIsBroad(rule)) return '도구 전체를 허용하는 넓은 규칙은 소유자가 정합니다.';
  const tool = value.slice(0, value.indexOf('('));
  const content = value.slice(value.indexOf('(') + 1, -1);
  if (tool === 'Bash' || tool === 'PowerShell') return '명령 규칙은 command 종류로 요청해야 자동 검토할 수 있습니다.';
  if (FILE_TOOLS.has(tool)) {
    if (!content.startsWith('//') || content.includes('..')) return '파일 규칙은 프로젝트 안의 절대 경로(//…)일 때만 자동 검토합니다.';
    const path = content.slice(1).replace(/\/\*\*?$/, '');
    const folder = cwd.replace(/\/+$/, '') || '/';
    if (!inside(path, folder)) return '프로젝트 밖의 파일 규칙은 소유자가 정합니다.';
    // The whole project (with its .git and agent settings) or a pattern are the owner's to allow; one folder or file in it is not.
    if (path === folder || /[*?[\]{}]/.test(path)) return '프로젝트 전체나 패턴으로 된 파일 규칙은 소유자가 정합니다.';
    // Hidden folders hold hooks, agent settings and keys (`.git/hooks`, `.claude`, `.ssh`): never decided automatically.
    if (/\/\./.test(`/${path.slice(folder.length).replace(/^\/+/, '')}`)) return '숨김 폴더(.git, .claude, .ssh 같은)의 파일 규칙은 소유자가 정합니다.';
  }
  return undefined;
}

const provider = z.enum(['claude', 'codex']);
export const PermissionRuleInputSchema = z.object({
  kind: z.enum(['command', 'claude']),
  value: z.string().min(1).max(MAX_RULE_LENGTH + 20),
  providers: z.array(provider).min(1).max(2),
  scope: z.enum(['global', 'project']),
  cwd: z.string().min(1).max(4096).optional(),
  note: z.string().max(500).optional(),
}).strict();
export const PermissionRequestInputSchema = z.object({
  kind: z.enum(['command', 'claude']),
  value: z.string().min(1).max(MAX_RULE_LENGTH + 20),
  providers: z.array(provider).min(1).max(2).optional(),
  scope: z.enum(['project', 'global', 'conversation']),
  reason: z.string().trim().min(1).max(500),
}).strict();
export const PermissionRunInputSchema = z.object({
  command: z.string().min(1).max(MAX_RUN_COMMAND),
  reason: z.string().trim().min(1).max(500),
  timeoutSeconds: z.number().int().min(1).max(MAX_RUN_SECONDS).optional(),
  key: z.string().trim().min(1).max(200).optional(),
}).strict();
export const PermissionRunResultInputSchema = z.object({
  id: z.string().uuid(),
  waitSeconds: z.number().int().min(0).max(50).optional(),
}).strict();
export const PermissionAutoReviewSchema = z.object({
  enabled: z.boolean(),
  provider,
  model: z.string().min(1).max(64),
  resume: z.boolean(),
}).strict();

/** A request the owner is asked about: pending and not with Tower's reviewer right now. */
export const waitingForOwner = (request: Pick<PermissionRequest, 'status' | 'review'>) => request.status === 'pending' && request.review?.status !== 'queued' && request.review?.status !== 'running';
