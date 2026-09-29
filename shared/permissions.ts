import { z } from 'zod';

export type PermissionProvider = 'claude' | 'codex';
/**
 * `command` is a command prefix both providers understand (`gh pr merge`); `claude` is a Claude Code permission rule
 * for anything else (`WebFetch(domain:example.com)`, `mcp__server__tool`).
 */
export type PermissionKind = 'command' | 'claude';
export type PermissionScope = 'global' | 'project';

export interface PermissionRuleInput {
  kind: PermissionKind;
  value: string;
  providers: PermissionProvider[];
  scope: PermissionScope;
  /** The project folder of a project rule. */
  cwd?: string;
  note?: string;
}

export interface PermissionRule extends PermissionRuleInput {
  id: string;
  source: 'owner' | 'request';
  requestId?: string;
  createdAt: string;
  updatedAt: string;
}

export type PermissionRequestStatus = 'pending' | 'approved' | 'denied';

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
}

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
export function ruleProblem(rule: Pick<PermissionRuleInput, 'kind' | 'value' | 'providers' | 'scope' | 'cwd'>): string | undefined {
  if (UNREADABLE.test(rule.value.replace(/[ \t]/g, ' ').replace(/\n/g, ' '))) return '규칙에는 제어 문자나 보이지 않는 문자를 쓸 수 없습니다.';
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
  if (rule.scope === 'project' && !rule.cwd?.startsWith('/')) return '프로젝트 규칙에는 프로젝트 폴더가 필요합니다.';
  return undefined;
}

/**
 * Whether a rule allows far more than one kind of action: a bare program that runs other programs, or a whole tool.
 * Such rules are allowed (the owner decides), but the owner is warned first.
 */
export function ruleIsBroad(rule: Pick<PermissionRuleInput, 'kind' | 'value'>): boolean {
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
export const sameRule = (a: Pick<PermissionRuleInput, 'kind' | 'value' | 'scope' | 'cwd'>, b: Pick<PermissionRuleInput, 'kind' | 'value' | 'scope' | 'cwd'>) =>
  a.kind === b.kind && a.scope === b.scope && (a.scope === 'global' || a.cwd === b.cwd)
  && (a.kind === 'command' ? normalizeCommand(a.value) === normalizeCommand(b.value) : a.value.trim() === b.value.trim());

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
  scope: z.enum(['project', 'global']),
  reason: z.string().trim().min(1).max(500),
}).strict();
