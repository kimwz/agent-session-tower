import { useState } from 'react';
import { MASTER_EFFORTS, MASTER_MODELS, type MasterEffort, type MasterSettings } from '../../../shared/master';
import { updateDraft, useMasterDraft } from './master-draft';
import { useWords } from './strings';

/**
 * The model and reasoning for the message being written, instead of the settings'. Left on "as set", the settings
 * decide; a choice stays for the following messages until it is set back.
 */
export function MessageChoices({ settings, disabled }: { settings?: MasterSettings; disabled: boolean }) {
  const words = useWords();
  const { model, effort } = useMasterDraft();
  const models = [...new Set([...MASTER_MODELS, ...(settings?.model ? [settings.model] : []), ...(model ? [model] : [])])];
  const changed = Boolean(model || effort);
  return <div className={`master-choices ${changed ? 'changed' : ''}`}>
    <span>{words('이번 메시지', 'This message')}</span>
    <select value={model ?? ''} disabled={disabled} aria-label={words('이번 메시지의 모델', 'Model for this message')} onChange={event => updateDraft({ model: event.target.value || undefined })}>
      <option value="">{words(`설정대로 (${settings?.model ?? '…'})`, `As set (${settings?.model ?? '…'})`)}</option>
      {models.filter(item => item !== settings?.model || item === model).map(item => <option key={item} value={item}>{item}</option>)}
    </select>
    <select value={effort ?? ''} disabled={disabled} aria-label={words('이번 메시지의 추론 수준', 'Reasoning for this message')} onChange={event => updateDraft({ effort: (event.target.value || undefined) as MasterEffort | undefined })}>
      <option value="">{words(`추론 설정대로 (${settings?.effort ?? '…'})`, `Reasoning as set (${settings?.effort ?? '…'})`)}</option>
      {MASTER_EFFORTS.map(item => <option key={item} value={item}>{words(`추론 ${item}`, `Reasoning ${item}`)}</option>)}
    </select>
    {changed && <button type="button" className="master-choices-reset" disabled={disabled} onClick={() => updateDraft({ model: undefined, effort: undefined })}>{words('설정대로', 'Reset')}</button>}
  </div>;
}

/** A long message shows its start, and all of it on request. */
export function useFold(text: string, limit = 1800): { shown: string; toggle?: { open: boolean; flip(): void } } {
  const [open, setOpen] = useState(false);
  if (text.length <= limit) return { shown: text };
  return { shown: open ? text : `${text.slice(0, Math.floor(limit * 0.8)).trimEnd()}…`, toggle: { open, flip: () => setOpen(value => !value) } };
}
