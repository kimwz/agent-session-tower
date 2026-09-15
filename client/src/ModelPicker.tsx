import { useId } from 'react';
import type { ProviderHealth } from '../../shared/types';
import { useI18n } from './i18n';

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
  const id = useId();
  const choices = modelChoices(provider, observedModel, value);
  const current = observedModel || provider?.defaultModel;
  return <div className="model-picker">
    <label htmlFor={id}>{t('모델')}</label>
    <select id={id} value={value || ''} disabled={disabled} onChange={event => onChange(event.target.value || undefined)} aria-describedby={`${id}-hint`}>
      <option value="">{t('에이전트 기본값 (변경 없음)')}</option>
      {choices.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
    </select>
    <span id={`${id}-hint`} className="model-picker-hint">{value ? t('다음 요청에 적용') : current ? t('기존 모델 유지: {0}', { 0: current }) : t('기존 에이전트 설정 유지')}</span>
  </div>;
}
