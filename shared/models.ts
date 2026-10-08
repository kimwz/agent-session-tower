import { TowerError } from './errors.js';
/**
 * Which provider, model and reasoning effort each kind of Claude/Codex call uses. Every call Tower starts by itself
 * gets its model from these roles (server/models/settings.ts), and the forms that create items start from them.
 * Initial values are what each call used before the roles existed, so an update changes no model.
 */
export type ModelProvider = 'claude' | 'codex';
/** A model and effort for one provider. Absent values leave the choice to the CLI's own configuration. */
export interface ModelPick { model?: string; effort?: string }
/**
 * `follow`: the call runs on the provider of the work it judges (a Slack rule's, a public agent's intake provider),
 * with that provider's pick. Both picks are kept so switching the provider loses neither.
 * For `master.heartbeat` only, `follow` inherits the whole `master.session` role at each call; its own picks are unused.
 */
export interface RoleSetting { provider: ModelProvider | 'follow'; claude: ModelPick; codex: ModelPick }
/** A role the owner adds for skills to name instead of a model, such as `review.codex`. */
export interface CustomRole { id: string; label?: string; provider: ModelProvider; claude: ModelPick; codex: ModelPick }
export interface ModelSettings { version: 1; roles: Record<BuiltinRoleId, RoleSetting>; custom: CustomRole[] }
export interface ResolvedModel { provider: ModelProvider; model?: string; effort?: string }

/**
 * `auto`: a call Tower makes by itself. `start`: what a form that starts work right away uses.
 * `default`: what a form creating an item that keeps its own model starts with.
 */
export type RoleKind = 'auto' | 'start' | 'default';
export interface BuiltinRole {
  id: string;
  kind: RoleKind;
  label: string;
  description: string;
  /** Whether the role may follow the provider of the work it judges. */
  follow?: boolean;
  /** Providers the call can run on; both when absent. */
  providers?: readonly ModelProvider[];
  /** The initial Claude model is a full ID checked against Claude Code, which lists only aliases. */
  verifiedClaudeModel?: true;
  initial: RoleSetting;
}

/** Claude only: no `--effort`, and thinking turned off (MAX_THINKING_TOKENS=0). */
export const EFFORT_OFF = 'off';

const STRONG: Pick<RoleSetting, 'claude' | 'codex'> = { claude: { model: 'opus' }, codex: { model: 'gpt-5.6-sol' } };
const follow = (): RoleSetting => ({ provider: 'follow', ...structuredClone(STRONG) });
const cliDefault = (provider: ModelProvider): RoleSetting => ({ provider, claude: {}, codex: {} });

export const BUILTIN_ROLES = [
  { id: 'autoPrompt.router', kind: 'auto', label: 'Auto Prompt 라우팅', description: '요청을 보낼 폴더와 세션을 고릅니다.', follow: true, initial: follow() },
  { id: 'permissions.reviewer', kind: 'auto', label: '권한 자동 리뷰어', description: '에이전트의 권한 요청을 검토합니다.', initial: { provider: 'claude', ...structuredClone(STRONG) } },
  { id: 'skills.advisor', kind: 'auto', label: '스킬 제안', description: '세션을 요약해 스킬을 제안합니다.', initial: { provider: 'claude', claude: { model: 'sonnet' }, codex: { model: 'gpt-5.6-terra' } } },
  { id: 'slack.match', kind: 'auto', label: 'Slack 멘션 매칭', description: '멘션에 맞는 규칙을 고릅니다.', follow: true, initial: follow() },
  { id: 'slack.replyIntent', kind: 'auto', label: 'Slack 답장 의도', description: '소유자 답장이 무엇을 원하는지 판단합니다. 규칙에 모델이 있으면 그 모델을 씁니다.', follow: true, initial: follow() },
  { id: 'slack.replyDraft', kind: 'auto', label: 'Slack 답장 초안', description: '스레드에 남길 답장 초안을 씁니다.', follow: true, initial: follow() },
  { id: 'slack.toneGuide', kind: 'auto', label: 'Slack 말투 가이드', description: '소유자의 메시지로 말투 가이드를 만듭니다.', follow: true, initial: follow() },
  { id: 'github.replyIntent', kind: 'auto', label: 'GitHub 답장 의도', description: '코디네이터에서 소유자 답장이 무엇을 원하는지 판단합니다. 규칙에 모델이 있으면 그 모델을 씁니다.', follow: true, initial: follow() },
  { id: 'publicAgents.judge', kind: 'auto', label: '공개 에이전트 판단', description: '방문자 대화 접수, 요약, 요청·결과 검토를 합니다.', follow: true, initial: follow() },
  { id: 'sessions.summarizer', kind: 'auto', label: '세션 작업 요약', description: '턴이 끝날 때마다 세션의 작업 제목과 단계를 요약합니다.', initial: { provider: 'claude', claude: { model: 'haiku', effort: EFFORT_OFF }, codex: { model: 'gpt-5.6-terra' } } },
  // Claude Haiku 5.5 by its pinned ID, so a later move of the `haiku` alias never changes it unasked.
  { id: 'sessions.compactor', kind: 'auto', label: '세션 압축', description: '압축 버튼을 누르면 세션 전체를 읽고 이어갈 내용을 요약해 새 세션을 엽니다.', verifiedClaudeModel: true, initial: { provider: 'claude', claude: { model: 'claude-haiku-5-5' }, codex: { model: 'gpt-5.6-terra' } } },
  { id: 'voice.firstReply', kind: 'auto', label: '음성 첫 답변', description: '음성으로 말하면 바로 짧게 답합니다.', providers: ['claude'], initial: { provider: 'claude', claude: { model: 'haiku', effort: EFFORT_OFF }, codex: {} } },
  { id: 'master.session', kind: 'start', label: '마스터 에이전트', description: '마스터 에이전트를 시작할 때 씁니다.', initial: cliDefault('claude') },
  { id: 'master.heartbeat', kind: 'auto', label: '마스터 heartbeat', description: '기본값은 master.session의 제공자·모델·추론 강도 전체를 매 점검마다 따릅니다. 현재 대화에서 고른 모델과는 별개입니다. 전용 제공자를 고르면 빈 모델·강도는 그 CLI 기본값입니다.', follow: true, initial: { provider: 'follow', claude: {}, codex: {} } },
  { id: 'master.worker', kind: 'start', label: '마스터 작업 에이전트', description: '마스터가 새 작업 세션을 열 때 생략한 모델 선택에 적용됩니다. 기존 세션은 유지합니다.', initial: { provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol' } } },
  { id: 'issues.register', kind: 'start', label: '이슈 등록', description: '폴더의 이슈 버튼으로 이슈를 등록할 때 씁니다.', initial: cliDefault('claude') },
  { id: 'chat.new', kind: 'default', label: '새 채팅', description: '새 세션을 만들 때 미리 선택됩니다.', initial: cliDefault('claude') },
  { id: 'autoPrompt.new', kind: 'default', label: 'Auto Prompt 작업', description: 'Auto Prompt로 보낼 때 미리 선택됩니다.', initial: cliDefault('claude') },
  { id: 'triggers.new', kind: 'default', label: '새 트리거', description: '트리거를 만들 때 미리 선택됩니다.', initial: cliDefault('codex') },
  { id: 'slack.newRule', kind: 'default', label: '새 Slack 규칙', description: 'Slack 규칙을 만들 때 미리 선택됩니다.', initial: cliDefault('codex') },
  { id: 'github.newRule', kind: 'default', label: '새 GitHub 규칙', description: 'GitHub 코디네이터 규칙을 만들 때 미리 선택됩니다.', initial: cliDefault('codex') },
  { id: 'publicAgents.new', kind: 'default', label: '새 공개 에이전트', description: '공개 에이전트를 만들 때 미리 선택됩니다.', initial: cliDefault('claude') },
] as const satisfies readonly BuiltinRole[];

export type BuiltinRoleId = typeof BUILTIN_ROLES[number]['id'];
export const MAX_CUSTOM_ROLES = 50;
export const ROLE_ID = /^[a-z][a-zA-Z0-9-]{0,39}(\.[a-zA-Z0-9-]{1,40}){1,3}$/;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/;
const EFFORT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
/** Claude Code's `--effort` levels, and `off`. Codex advertises its own per model. */
const CLAUDE_ROLE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max', EFFORT_OFF];

export const builtinRole = (id: string): BuiltinRole | undefined => (BUILTIN_ROLES as readonly BuiltinRole[]).find(role => role.id === id);
export const isBuiltinRole = (id: string): id is BuiltinRoleId => builtinRole(id) !== undefined;

export function initialModelSettings(): ModelSettings {
  return { version: 1, roles: Object.fromEntries(BUILTIN_ROLES.map(role => [role.id, structuredClone(role.initial)])) as Record<BuiltinRoleId, RoleSetting>, custom: [] };
}

/** Whether a pick is one Tower can pass to the CLI: argv-safe ids, and `off` only for Claude. */
export function pickProblem(pick: unknown, provider: ModelProvider): string | undefined {
  if (!pick || typeof pick !== 'object' || Array.isArray(pick)) return '모델 선택이 올바르지 않습니다.';
  const { model, effort, ...rest } = pick as Record<string, unknown>;
  if (Object.keys(rest).length) return '모델 선택에 알 수 없는 값이 있습니다.';
  if (model !== undefined && (typeof model !== 'string' || model.length > 160 || !MODEL_ID.test(model))) return '모델 이름이 올바르지 않습니다.';
  if (effort !== undefined && (typeof effort !== 'string' || !EFFORT_ID.test(effort) || (provider === 'claude' ? !CLAUDE_ROLE_EFFORTS.includes(effort) : effort === EFFORT_OFF))) return '추론 강도가 올바르지 않습니다.';
  return undefined;
}

function settingProblem(value: unknown, role: Partial<Pick<BuiltinRole, 'follow' | 'providers' | 'kind'>>): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '역할 설정이 올바르지 않습니다.';
  const setting = value as Record<string, unknown>;
  const providers = role.providers ?? ['claude', 'codex'];
  if (!(providers as readonly unknown[]).includes(setting.provider) && !(role.follow && setting.provider === 'follow')) return '제공자가 올바르지 않습니다.';
  // Thinking off exists only for Tower's own one-shot calls; sessions and skill roles have no such level.
  if (role.kind !== 'auto' && (setting.claude as ModelPick | undefined)?.effort === EFFORT_OFF) return '생각 끔은 자동 판단에만 쓸 수 있습니다.';
  return pickProblem(setting.claude, 'claude') ?? pickProblem(setting.codex, 'codex');
}

const cleanPick = (pick: ModelPick): ModelPick => ({ ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}) });

/**
 * Reads saved or submitted settings. `strict` rejects anything invalid (a save); otherwise an invalid role falls back to
 * its value in `base` and an invalid custom role is dropped, so one bad entry never breaks every call.
 */
export function parseModelSettings(value: unknown, strict = false, base: ModelSettings = initialModelSettings()): ModelSettings {
  const fail = (message: string) => { throw new TowerError('invalid', message); };
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : strict ? fail('모델 설정이 올바르지 않습니다.') : {};
  // Roles left out keep `base` (a page of another version saves only the roles it knows); roles it does not know are ignored.
  const result: ModelSettings = { ...structuredClone(base), custom: [] };
  const roles = input.roles && typeof input.roles === 'object' && !Array.isArray(input.roles) ? input.roles as Record<string, unknown> : {};
  for (const role of BUILTIN_ROLES as readonly (BuiltinRole & { id: BuiltinRoleId })[]) {
    const saved = roles[role.id];
    if (saved === undefined) continue;
    const problem = settingProblem(saved, role);
    if (problem) { if (strict) fail(`${role.label}: ${problem}`); continue; }
    const setting = saved as RoleSetting;
    result.roles[role.id] = { provider: setting.provider, claude: cleanPick(setting.claude), codex: cleanPick(setting.codex) };
  }
  const custom = Array.isArray(input.custom) ? input.custom : input.custom === undefined ? [] : strict ? fail('스킬용 역할 목록이 올바르지 않습니다.') : [];
  if (custom.length > MAX_CUSTOM_ROLES) { if (strict) fail(`스킬용 역할은 ${MAX_CUSTOM_ROLES}개까지 만들 수 있습니다.`); }
  const seen = new Set<string>();
  for (const entry of custom.slice(0, MAX_CUSTOM_ROLES)) {
    const id = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).id : undefined;
    const label = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).label : undefined;
    // This formerly available custom name is now built in. A legacy read promotes it; an old page saving its
    // custom copy must not overwrite the current builtin (which `base` already read and migrated).
    if (id === 'master.worker' && !settingProblem(entry, { kind: 'start' })) {
      if (!strict && roles[id] === undefined) {
        const old = entry as CustomRole;
        result.roles[id] = { provider: old.provider, claude: cleanPick(old.claude), codex: cleanPick(old.codex) };
      }
      continue;
    }
    const problem = typeof id !== 'string' || !ROLE_ID.test(id) ? '역할 이름은 review.codex처럼 점으로 나눈 영문 이름이어야 합니다.'
      : isBuiltinRole(id) ? `${id}는 기본 역할의 이름입니다.`
      : seen.has(id) ? `${id} 역할이 두 번 있습니다.`
      : label !== undefined && (typeof label !== 'string' || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) ? '역할 설명이 올바르지 않습니다.'
      : settingProblem(entry, {});
    if (problem) { if (strict) fail(problem); continue; }
    seen.add(id as string);
    const role = entry as CustomRole;
    result.custom.push({ id: role.id, ...(role.label?.trim() ? { label: role.label.trim() } : {}), provider: role.provider, claude: cleanPick(role.claude), codex: cleanPick(role.codex) });
  }
  return result;
}

/**
 * The provider, model and effort a role gives. `provider` is the provider of the work a `follow` role judges;
 * without one a follow role runs on Claude.
 */
export function resolveRole(settings: ModelSettings, id: string, context: { provider?: ModelProvider } = {}): ResolvedModel {
  const setting: RoleSetting | undefined = isBuiltinRole(id) ? settings.roles[id] : settings.custom.find(role => role.id === id);
  if (!setting) throw new TowerError('not-found', `알 수 없는 모델 역할입니다: ${id}`);
  if (id === 'master.heartbeat' && setting.provider === 'follow') return resolveRole(settings, 'master.session');
  const provider = setting.provider === 'follow' ? context.provider ?? 'claude' : setting.provider;
  return { provider, ...cleanPick(setting[provider]) };
}

/** A new delegated session: explicit fields win independently, using only the selected provider's pick. */
export function masterWorkerModel(settings: ModelSettings, explicit: Partial<ResolvedModel> = {}): ResolvedModel {
  const role = settings.roles['master.worker'];
  const provider = explicit.provider === undefined ? role.provider : explicit.provider;
  if (provider !== 'claude' && provider !== 'codex') throw new TowerError('invalid', 'Invalid worker provider.');
  return { provider, ...role[provider], ...(explicit.model !== undefined ? { model: explicit.model } : {}),
    ...(explicit.effort !== undefined ? { effort: explicit.effort } : {}) };
}

/** Command-line flags that select a resolved model: for `codex exec` or `claude -p`. */
export function modelArgs(resolved: ResolvedModel): string[] {
  const args = resolved.model ? [resolved.provider === 'codex' ? '-m' : '--model', resolved.model] : [];
  if (!resolved.effort) return args;
  if (resolved.provider === 'codex') return [...args, '-c', `model_reasoning_effort=${resolved.effort}`];
  return resolved.effort === EFFORT_OFF ? args : [...args, '--effort', resolved.effort];
}

/** One line per skill role, as agents read it in their turn instructions. */
export function customRoleLines(settings: ModelSettings): string[] {
  return settings.custom.map(role => {
    const resolved = resolveRole(settings, role.id);
    return `- ${role.id} = ${resolved.provider} / ${resolved.model ?? 'default'} / ${resolved.effort ?? 'default'}${role.label ? ` — ${role.label}` : ''}`;
  });
}
