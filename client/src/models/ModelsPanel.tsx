import { useEffect, useState } from 'react';
import { LoaderCircle, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { BUILTIN_ROLES, EFFORT_OFF, builtinRole, initialModelSettings, type BuiltinRole, type CustomRole, type ModelPick, type ModelProvider, type ModelSettings, type RoleKind, type RoleSetting } from '../../../shared/models';
import type { ProviderHealth } from '../../../shared/types';
import { translateMessage, useI18n } from '../i18n/i18n';
import { effortLabel, modelEfforts } from '../chat/ModelPicker';
import { SettingsPane, useSettingsGuard } from '../settings/SettingsPane';
import type { TriggerComputer } from '../triggers/TriggerPanel';
import { saveModelSettings, useModelSettings } from './model-settings';

const GROUPS: { kind: RoleKind; title: string; description: string }[] = [
  { kind: 'auto', title: '자동 판단', description: 'Tower가 스스로 여는 호출입니다. 도구 없이 한 번 판단하고 끝납니다.' },
  { kind: 'start', title: '시작할 때', description: '새 세션을 시작할 때 적용합니다.' },
  { kind: 'default', title: '새 항목 기본값', description: '만들 때 미리 선택되는 값입니다. 이미 만든 항목은 각자 고른 모델을 그대로 씁니다.' },
];
const PROVIDER_LABEL: Record<ModelProvider, string> = { claude: 'Claude', codex: 'Codex' };
/** The model select's entry that opens a text field for a model the list does not have. */
const CUSTOM = '__custom__';

/**
 * Settings › Models: which provider, model and reasoning effort each of Tower's own calls uses, what new items start
 * with, and the roles skills name instead of a model. A joined computer's settings are its own; they are edited here
 * and followed there.
 */
export function ModelsPanel({ token, providers: ownProviders, computers }: { token: string; providers: ProviderHealth[]; computers: TriggerComputer[] }) {
  const { t } = useI18n();
  const [node, setNode] = useState('');
  const computer = node ? computers.find(item => item.node === node) : undefined;
  const providers = node ? computer?.providers ?? [] : ownProviders;
  const target = node || undefined;
  const { settings, problem, error: loadError, reload } = useModelSettings(token, target);
  const [draft, setDraft] = useState<ModelSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { setDraft(settings ? structuredClone(settings) : undefined); }, [settings]);
  const dirty = !!draft && !!settings && JSON.stringify(draft) !== JSON.stringify(settings);
  useSettingsGuard({ leave: () => !dirty || window.confirm(t('저장하지 않은 모델 설정을 버릴까요?')) });
  const choose = (next: string) => { if (dirty && !window.confirm(t('저장하지 않은 모델 설정을 버릴까요?'))) return; setNode(next); setError(''); setNotice(''); };
  const setRole = (id: string, setting: RoleSetting) => setDraft(value => value && ({ ...value, roles: { ...value.roles, [id]: setting } }));
  const setCustom = (index: number, role: CustomRole | undefined) => setDraft(value => value && ({ ...value, custom: role ? value.custom.map((item, at) => at === index ? role : item) : value.custom.filter((_, at) => at !== index) }));
  const save = async () => {
    if (!draft) return;
    setBusy(true); setError(''); setNotice('');
    try { await saveModelSettings(token, draft, target); setNotice(t('모델 설정을 저장했습니다. 다음 호출부터 적용됩니다.')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const name = computer?.name ?? t('연결된 컴퓨터');
  const ready = !node || computer?.models;
  return <SettingsPane title={t('모델')} scope="models-scope"
    description={target ? t('{0}의 모델 설정입니다. 그 컴퓨터에서 열리는 세션은 그 컴퓨터의 설정을 따릅니다.', { 0: name }) : t('Tower가 스스로 여는 Claude/Codex 세션과 새로 만드는 항목의 제공자·모델·추론 강도를 정합니다.')}
    actions={computers.length > 0 && <label className="trigger-computer">{t('컴퓨터')}<select value={node} onChange={event => choose(event.target.value)}>
      <option value="">{t('이 컴퓨터')}</option>{computers.map(item => <option key={item.node} value={item.node} disabled={!item.models && item.node !== node}>
        {item.models ? item.name : !item.connected ? t('{0} (오프라인)', { 0: item.name }) : t('{0} (Tower 업데이트 필요)', { 0: item.name })}</option>)}</select></label>}>
    <div className="models-body">
      {!ready ? <p className="slack-empty">{computer?.connected ? t('{0}의 Tower를 업데이트하면 여기서 모델을 정할 수 있습니다.', { 0: name }) : t('{0}에 지금 연결되어 있지 않습니다.', { 0: name })}</p>
        : !draft ? (loadError ? <p role="alert" className="slack-error">{translateMessage(loadError)} <button type="button" className="secondary-button" onClick={reload}>{t('다시 시도')}</button></p> : <LoaderCircle className="spin" aria-label={t('연결 중')} />)
        : <>
          <SettingsProblem problem={problem} />
          {GROUPS.map(group => <section key={group.kind} className="models-group">
            <h3>{t(group.title)}</h3>
            <p className="auth-hint">{t(group.description)}</p>
            {(BUILTIN_ROLES as readonly BuiltinRole[]).filter(role => role.kind === group.kind).map(role => draft.roles[role.id as keyof ModelSettings['roles']] ? <RoleRow key={role.id} role={role} setting={draft.roles[role.id as keyof ModelSettings['roles']]} providers={providers} disabled={busy}
              onChange={setting => setRole(role.id, setting)} /> : <div className="models-role" key={role.id}><div className="models-role-text"><strong>{t(role.label)}</strong><code>{role.id}</code></div><p className="auth-hint">{t('실행 워커가 업데이트되면 이 역할을 설정할 수 있습니다.')}</p></div>)}
          </section>)}
          <section className="models-group">
            <h3>{t('스킬용 역할')}</h3>
            <p className="auth-hint">{t('스킬 문서에 모델 이름 대신 역할 이름(예: review.codex)을 적으면, Tower가 턴마다 이 표를 알려 주고 models_get 도구와 agent-session-tower models args 명령으로도 같은 모델을 알려 줍니다.')}</p>
            {draft.custom.map((role, index) => <CustomRow key={index} role={role} providers={providers} disabled={busy} onChange={next => setCustom(index, next)} />)}
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(value => value && ({ ...value, custom: [...value.custom, { id: '', provider: 'codex', claude: {}, codex: {} }] }))}><Plus size={14} />{t('역할 추가')}</button>
          </section>
          {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}
          {notice && <p role="status" className="notification-notice">{notice}</p>}
          <div className="models-actions">
            <button type="button" className="primary-button" disabled={busy || !dirty} onClick={() => void save()}>{busy && <LoaderCircle className="spin" size={14} />}{t('저장')}</button>
            <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => settings && setDraft(structuredClone(settings))}>{t('되돌리기')}</button>
          </div>
        </>}
    </div>
  </SettingsPane>;
}

function RoleRow({ role, setting, providers, disabled, onChange }: { role: BuiltinRole; setting: RoleSetting; providers: ProviderHealth[]; disabled: boolean; onChange: (setting: RoleSetting) => void }) {
  const { t } = useI18n();
  const initial = initialModelSettings().roles[role.id as keyof ModelSettings['roles']];
  const changed = JSON.stringify(initial) !== JSON.stringify(setting);
  return <div className="models-role">
    <div className="models-role-text"><strong>{t(role.label)}</strong><small>{t(role.description)}</small><code>{role.id}</code></div>
    <div className="models-role-controls">
      <ProviderSelect value={setting.provider} follow={!!role.follow} providers={role.providers} disabled={disabled} onChange={provider => onChange({ ...setting, provider })} />
      {(setting.provider === 'follow' ? ['claude', 'codex'] as const : [setting.provider]).map(provider => <PickRow key={provider} provider={provider} labelled={setting.provider === 'follow'}
        pick={setting[provider]} health={providers.find(item => item.provider === provider)} off={role.kind === 'auto' && provider === 'claude'} disabled={disabled}
        verified={initial[provider].model} onChange={pick => onChange({ ...setting, [provider]: pick })} />)}
      {changed && <button type="button" className="icon-button" title={t('초기값으로')} aria-label={t('초기값으로')} disabled={disabled} onClick={() => onChange(structuredClone(initial))}><RotateCcw size={14} /></button>}
    </div>
  </div>;
}

function CustomRow({ role, providers, disabled, onChange }: { role: CustomRole; providers: ProviderHealth[]; disabled: boolean; onChange: (role: CustomRole | undefined) => void }) {
  const { t } = useI18n();
  const clash = role.id && builtinRole(role.id);
  return <div className="models-role">
    <div className="models-role-text">
      <input value={role.id} disabled={disabled} maxLength={120} placeholder="review.codex" aria-label={t('역할 이름')} onChange={event => onChange({ ...role, id: event.target.value.trim() })} />
      <input value={role.label ?? ''} disabled={disabled} maxLength={80} placeholder={t('설명 (선택)')} aria-label={t('역할 설명')} onChange={event => onChange({ ...role, label: event.target.value || undefined })} />
      {clash && <small className="auth-error">{t('기본 역할과 같은 이름은 쓸 수 없습니다.')}</small>}
    </div>
    <div className="models-role-controls">
      <ProviderSelect value={role.provider} follow={false} disabled={disabled} onChange={provider => provider !== 'follow' && onChange({ ...role, provider })} />
      <PickRow key={role.provider} provider={role.provider} labelled={false} pick={role[role.provider]} health={providers.find(item => item.provider === role.provider)} off={false} disabled={disabled}
        onChange={pick => onChange({ ...role, [role.provider]: pick })} />
      <button type="button" className="icon-button" title={t('역할 삭제')} aria-label={t('역할 삭제')} disabled={disabled} onClick={() => onChange(undefined)}><Trash2 size={14} /></button>
    </div>
  </div>;
}

function ProviderSelect({ value, follow, providers = ['claude', 'codex'], disabled, onChange }: { value: RoleSetting['provider']; follow: boolean; providers?: readonly ModelProvider[]; disabled: boolean; onChange: (provider: RoleSetting['provider']) => void }) {
  const { t } = useI18n();
  return <select className="model-picker" value={value} disabled={disabled} aria-label={t('제공자')} onChange={event => onChange(event.target.value as RoleSetting['provider'])}>
    {follow && <option value="follow">{t('작업과 같은 제공자')}</option>}
    {providers.map(provider => <option key={provider} value={provider}>{PROVIDER_LABEL[provider]}</option>)}
  </select>;
}

/** A model picked from that computer's list (empty for the CLI's default), or typed when it is not listed, and an effort it supports. */
/** Why this computer's settings are the defaults, from its own Tower; older ones send nothing. */
export function SettingsProblem({ problem }: { problem?: string }) {
  return problem ? <p role="alert" className="slack-error">{translateMessage(problem)}</p> : null;
}

/** `verified`: the role's initial model, which Tower ships as one the CLI takes even when its list names only aliases. */
export function PickRow({ provider, labelled, pick, health, off, disabled, verified, onChange }: { provider: ModelProvider; labelled: boolean; pick: ModelPick; health?: ProviderHealth; off: boolean; disabled: boolean; verified?: string; onChange: (pick: ModelPick) => void }) {
  const { t } = useI18n();
  const models = health?.models ?? [];
  const listed = !pick.model || models.some(model => model.id === pick.model);
  // Typing stays open once chosen, even while the typed text happens to match a listed model.
  const [typing, setTyping] = useState(!listed);
  const { efforts, defaultEffort } = modelEfforts(health, pick.model);
  const choices = [...(off ? [{ id: EFFORT_OFF }] : []), ...efforts];
  const unknownModel = !!pick.model && pick.model !== verified && models.length > 0 && !models.some(model => model.id === pick.model);
  const unknownEffort = !!pick.effort && !choices.some(effort => effort.id === pick.effort);
  const set = (next: ModelPick) => onChange({ ...(next.model ? { model: next.model } : {}), ...(next.effort ? { effort: next.effort } : {}) });
  const name = PROVIDER_LABEL[provider];
  return <div className="models-pick">
    {labelled && <span className="models-pick-label">{name}</span>}
    <select className="model-picker" value={typing ? CUSTOM : pick.model ?? ''} disabled={disabled} aria-label={t('{0} 모델', { 0: name })}
      onChange={event => {
        if (event.target.value === CUSTOM) { setTyping(true); return; }
        setTyping(false);
        const model = event.target.value || undefined;
        // An effort the new model does not list is dropped, as in the chat pickers.
        set({ model, effort: pick.effort && (pick.effort === EFFORT_OFF ? off : modelEfforts(health, model).efforts.some(effort => effort.id === pick.effort)) ? pick.effort : undefined });
      }}>
      <option value="">{t('{0} 기본값', { 0: name })}</option>
      {models.map(model => <option key={model.id} value={model.id}>{model.label === model.id ? model.id : `${model.label} (${model.id})`}</option>)}
      <option value={CUSTOM}>{t('직접 입력…')}</option>
    </select>
    {typing && <input className="model-picker" value={pick.model ?? ''} disabled={disabled} maxLength={160} autoFocus={!pick.model} aria-label={t('{0} 모델 이름', { 0: name })}
      placeholder={t('모델 이름')} onChange={event => set({ ...pick, model: event.target.value.trim() || undefined })} />}
    <select className="model-picker effort-picker" value={pick.effort ?? ''} disabled={disabled} aria-label={t('추론 수준')} onChange={event => set({ ...pick, effort: event.target.value || undefined })}>
      <option value="">{defaultEffort ? t('기본 추론 ({0})', { 0: effortLabel(defaultEffort) }) : t('기본 추론')}</option>
      {choices.map(effort => <option key={effort.id} value={effort.id}>{effort.id === EFFORT_OFF ? t('생각 끔') : effortLabel(effort.id)}</option>)}
      {unknownEffort && <option value={pick.effort}>{effortLabel(pick.effort!)}</option>}
    </select>
    {(unknownModel || unknownEffort) && <small className="models-warning">{unknownModel ? t('이 컴퓨터의 {0} 목록에 없는 모델입니다. 그대로 쓰면 실패할 수 있습니다.', { 0: name }) : t('이 모델이 알리는 추론 수준이 아닙니다.')}</small>}
  </div>;
}
