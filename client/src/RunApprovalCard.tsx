import { memo, useRef, useState } from 'react';
import { Check, LoaderCircle, ShieldQuestion, X } from 'lucide-react';
import type { RunApproval } from '../../shared/types';
import { translate as t, translateMessage, useI18n } from './i18n';
import { submitApprovalDecision, type ApprovalDecision } from './chat-approvals';

export const RunApprovalCard = memo(function RunApprovalCard({ runId, approval, token, disabled = false, onSnapshotRefresh }: {
  runId: string; approval: RunApproval; token: string; disabled?: boolean; onSnapshotRefresh: () => void;
}) {
  useI18n();
  const locked = useRef(false);
  const [state, setState] = useState<'idle' | 'submitting' | 'settled'>('idle');
  const [error, setError] = useState('');
  const fields = Object.entries(approval.input);

  async function decide(decision: ApprovalDecision) {
    if (disabled || !token || locked.current) return;
    locked.current = true;
    setState('submitting'); setError('');
    try {
      await submitApprovalDecision(runId, approval.id, decision, token);
      // Keep both buttons locked until the authoritative snapshot removes this card.
      setState('settled');
      onSnapshotRefresh();
    } catch (error) {
      locked.current = false;
      setState('idle');
      setError(error instanceof Error ? error.message : t('승인 결정을 보내지 못했습니다. 다시 시도하세요.'));
    }
  }

  return <section className="run-approval" aria-label={t('작업 승인 요청')} data-approval-id={approval.id} aria-busy={state === 'submitting'}>
    <div className="run-approval-heading"><ShieldQuestion size={14} aria-hidden="true" /><strong>{approval.toolName}</strong><span>{t('승인 필요')}</span></div>
    <div className="run-approval-details">
      {approval.description && <p className="run-approval-description">{approval.description}</p>}
      {fields.length ? <dl>{fields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd><pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></dd></div>)}</dl> : <p className="run-approval-description">{t('추가 입력 없음')}</p>}
    </div>
    {error && <p className="run-approval-error" role="alert">{translateMessage(error)}</p>}
    <div className="run-approval-actions">
      <span role="status">{state !== 'idle' && <LoaderCircle size={11} className="spin" aria-hidden="true" />}{state === 'submitting' ? t('결정 보내는 중…') : state === 'settled' ? t('작업 상태 갱신 중…') : approval.scope === 'turn' ? t('요청한 권한은 이번 턴에만 적용됩니다.') : t('이 작업에만 적용됩니다.')}</span>
      <button type="button" disabled={disabled || !token || state !== 'idle'} onClick={() => { void decide('deny'); }}><X size={12} aria-hidden="true" />{t('거절')}</button>
      <button type="button" className="run-approval-allow" disabled={disabled || !token || state !== 'idle'} onClick={() => { void decide('allow'); }}><Check size={12} aria-hidden="true" />{approval.scope === 'turn' ? t('이번 턴에 허용') : t('한 번 허용')}</button>
    </div>
  </section>;
});
