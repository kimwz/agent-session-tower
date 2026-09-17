import type { ProviderHealth } from '../../../shared/types';
import { useI18n } from '../i18n/i18n';

export function modelChoices(provider?: ProviderHealth, observedModel?: string, selectedModel?: string) {
  const choices = new Map((provider?.models || []).map(model => [model.id, model]));
  for (const id of [observedModel, selectedModel]) {
    if (id && !choices.has(id)) choices.set(id, { id, label: id });
  }
  return [...choices.values()];
}

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
