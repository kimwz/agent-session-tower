import type { EffortOption, ProviderHealth } from '../../../shared/types';
import { translate, useI18n } from '../i18n/i18n';

export function modelChoices(provider?: ProviderHealth, observedModel?: string, selectedModel?: string) {
  const choices = new Map((provider?.models || []).map(model => [model.id, model]));
  for (const id of [observedModel, selectedModel]) {
    if (id && !choices.has(id)) choices.set(id, { id, label: id });
  }
  return [...choices.values()];
}

/** Efforts of the model a request would use. Claude session IDs such as `claude-opus-…` match their alias.
 * The default is the native configured effort when the model supports it, otherwise the model's own default. */
export function modelEfforts(provider?: ProviderHealth, model = provider?.defaultModel): { efforts: EffortOption[]; defaultEffort?: string } {
  const models = provider?.models || [];
  const option = models.find(item => item.id === model)
    || (provider?.provider === 'claude' && model ? models.find(item => model.includes(item.id)) : undefined);
  const efforts = option?.efforts ?? provider?.efforts ?? [];
  const configured = efforts.some(effort => effort.id === provider?.defaultEffort) ? provider?.defaultEffort : undefined;
  const defaultEffort = configured ?? option?.defaultEffort;
  return { efforts, ...(defaultEffort ? { defaultEffort } : {}) };
}

/** Keep an effort only while the chosen model still supports it. */
export function supportedEffort(provider: ProviderHealth | undefined, model: string | undefined, effort: string | undefined): string | undefined {
  return effort && modelEfforts(provider, model).efforts.some(option => option.id === effort) ? effort : undefined;
}

const effortLabels: Record<string, string> = { none: '없음', minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대', ultra: '울트라' };
export const effortLabel = (id: string) => effortLabels[id] ? translate(effortLabels[id]) : id;

export function ModelPicker({ provider, observedModel, value, disabled, onChange }: {
  provider?: ProviderHealth; observedModel?: string; value?: string; disabled?: boolean; onChange: (model?: string) => void;
}) {
  const { t } = useI18n();
  const choices = modelChoices(provider, observedModel, value);
  const current = observedModel || provider?.defaultModel;
  const currentLabel = provider?.models?.find(model => model.id === current)?.label || current || t('에이전트 기본값');
  const selectedLabel = choices.find(model => model.id === value)?.label || currentLabel;
  const explicitCurrent = !!value && value === current;
  return <select className="model-picker" value={value || ''} disabled={disabled} onChange={event => onChange(event.target.value || undefined)} aria-label={t('모델')} title={`${selectedLabel} · ${value ? t('다음 요청에 적용') : t('에이전트 기본값 (변경 없음)')}`}>
    <option value="">{explicitCurrent ? t('에이전트 기본값') : currentLabel}</option>
    {choices.filter(model => model.id !== current || explicitCurrent).map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
  </select>;
}

/** Renders nothing for a model without effort control, so no unusable override can be chosen. */
export function EffortPicker({ provider, model, value, disabled, onChange }: {
  provider?: ProviderHealth; model?: string; value?: string; disabled?: boolean; onChange: (effort?: string) => void;
}) {
  const { t } = useI18n();
  const { efforts, defaultEffort } = modelEfforts(provider, model);
  if (!efforts.length) return null;
  const defaultLabel = defaultEffort ? t('기본 추론 ({0})', { 0: effortLabel(defaultEffort) }) : t('기본 추론');
  const selected = efforts.find(effort => effort.id === value);
  return <select className="model-picker effort-picker" value={selected ? selected.id : ''} disabled={disabled} onChange={event => onChange(event.target.value || undefined)} aria-label={t('추론 수준')} title={`${t('추론 수준')} · ${selected ? `${effortLabel(selected.id)} · ${t('다음 요청에 적용')}` : t('에이전트 기본값 (변경 없음)')}`}>
    <option value="">{defaultLabel}</option>
    {efforts.map(effort => <option key={effort.id} value={effort.id} title={effort.description}>{effortLabel(effort.id)}</option>)}
  </select>;
}
