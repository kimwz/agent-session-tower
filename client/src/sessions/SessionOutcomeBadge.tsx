import { translate as t, useI18n } from '../i18n/i18n';
import { useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { SessionOutcome } from '../../../shared/types';

/** How a finished conversation's last turn ended, as the fast judgment read it. */
export const outcomeLabels: Record<SessionOutcome, string> = {
  get done() { return t("작업 완료"); },
  get needsOwner() { return t("확인 필요"); },
  get blocked() { return t("작업 끊김"); },
  get progress() { return t("이어서 진행 예정"); },
};

/** The outcome in the conversation's header. One that waits on the owner can be marked as looked at, which makes it done. */
export function SessionOutcomeBadge({ outcome, disabled, onAcknowledge, onError }: {
  outcome: SessionOutcome;
  disabled: boolean;
  onAcknowledge?: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useI18n();
  const [saving, setSaving] = useState(false);
  const label = <><i />{outcomeLabels[outcome]}</>;
  if (!onAcknowledge || (outcome !== 'needsOwner' && outcome !== 'blocked')) return <span className={`agent-outcome chat-outcome ${outcome}`}>{label}</span>;
  const acknowledge = async () => {
    if (saving) return;
    setSaving(true); onError('');
    try { await onAcknowledge(); } catch (error) { onError(error instanceof Error ? error.message : t("세션 상태를 저장하지 못했습니다.")); } finally { setSaving(false); }
  };
  return <button type="button" className={`agent-outcome chat-outcome acknowledge ${outcome}`} disabled={disabled || saving} onClick={() => void acknowledge()}
    title={t("확인했으면 눌러 작업 완료로 바꿉니다")} aria-label={t("{0} · 확인했음으로 표시", { 0: outcomeLabels[outcome] })}>
    {label}<span className="chat-outcome-action">{saving ? <LoaderCircle className="spin" size={11} /> : <Check size={11} />}{t("확인했음")}</span>
  </button>;
}
