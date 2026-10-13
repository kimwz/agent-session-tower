import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { memo } from 'react';
import { Check, Clock, LoaderCircle, RefreshCw, Send, ShieldQuestion, Square, Trash2, TriangleAlert } from 'lucide-react';
import type { Run } from '../../../shared/types';
import { cleanPreview, scheduledLabel } from '../common/lib';
import { RunApprovalCard } from './RunApprovalCard';

export const RunControl = memo(function RunControl({ run, onCancel, onRetry, cancelling, onDismiss, dismissing = false, onSteer, steering = false, disabled = false, retryDisabled = false, showPrompt = true, token = '', onSnapshotRefresh }: { run: Run; onCancel: (id: string) => void; onRetry: (run: Run) => void; cancelling: boolean; onDismiss?: (id: string) => void; dismissing?: boolean; onSteer?: (id: string) => void; steering?: boolean; disabled?: boolean; retryDisabled?: boolean; showPrompt?: boolean; token?: string; onSnapshotRefresh?: () => void }) {
  useI18n();
  if (run.status === 'completed' || run.status === 'cancelled') return null;
  const active = run.status === 'running' || run.status === 'queued';
  const approvals = active ? run.approvals || [] : [];
  const preview = run.prompt || (run.attachments?.length ? run.attachments.map(file => file.name).join(', ') : t("보낸 요청"));
  return <div data-run-id={run.id} className={`run-control ${run.status}${approvals.length ? ' awaiting-approval' : ''}`}>
    <div className="run-control-line">
      {run.scheduled && run.status === 'queued' ? <Clock size={12} aria-hidden="true" /> : run.steering?.state === 'delivered' ? <Check size={12} aria-hidden="true" /> : approvals.length ? <ShieldQuestion size={12} aria-hidden="true" /> : active ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : <TriangleAlert size={12} aria-hidden="true" />}
      <strong>{run.steering ? run.steering.state === 'sending' ? t('끼워넣는 중') : run.steering.state === 'delivered' ? t('현재 작업에 전달됨') : t('전달 여부 확인 필요') : approvals.length ? approvals.some(approval => approval.interaction) ? t('응답 대기') : t('작업 승인 대기') : run.scheduled && run.status === 'queued' ? scheduledLabel(run.scheduled.at) : run.status === 'queued' ? t("전송 대기 중") : run.status === 'running' ? run.backgroundWait ? t('백그라운드 작업 대기 중') : t("작업 중") : t("요청 실패")}</strong>
      {showPrompt && <span className="run-control-preview" title={preview}>{cleanPreview(preview, 140)}</span>}
      <div className="run-control-actions">
        {run.status === 'queued' && run.canSteer && !run.steering && onSteer && <button type="button" disabled={disabled || steering} onClick={() => onSteer(run.id)}>{steering ? <LoaderCircle className="spin" size={11} aria-hidden="true" /> : <Send size={11} aria-hidden="true" />}{t("지금 끼워넣기")}</button>}
        {active && !run.steering && <button type="button" disabled={disabled || cancelling} onClick={() => onCancel(run.id)}><Square size={10} aria-hidden="true" />{cancelling ? t("취소 중…") : run.scheduled && run.status === 'queued' ? t('예약 취소') : run.status === 'queued' ? t("대기 취소") : t("중지")}</button>}
        {run.status === 'error' && <>{!run.steering && <button type="button" aria-label={t("요청 다시 작성")} disabled={disabled || retryDisabled} onClick={() => onRetry(run)}><RefreshCw size={11} aria-hidden="true" />{t("다시 작성")}</button>}{onDismiss && <button type="button" aria-label={t("실패 내역 지우기")} disabled={disabled || dismissing} onClick={() => onDismiss(run.id)}>{dismissing ? <LoaderCircle className="spin" size={11} aria-hidden="true" /> : <Trash2 size={11} aria-hidden="true" />}{t("지우기")}</button>}</>}
      </div>
    </div>
    {run.status === 'queued' && !run.canSteer && !run.steering && run.steerBlocked && <p className="run-control-note">{steerBlockedNote(run.steerBlocked)}</p>}
    {active && run.origin?.kind === 'owner' && run.towerTools && run.towerTools !== 'attached' && <p className="run-control-note">{towerToolsNote(run.towerTools)}</p>}
    {run.status === 'error' && run.error && <p className="run-control-error">{translateMessage(run.error)}</p>}
    {approvals.map(approval => <RunApprovalCard key={approval.id} runId={run.id} approval={approval} token={token} disabled={disabled || cancelling || !onSnapshotRefresh} onSnapshotRefresh={onSnapshotRefresh || (() => {})} />)}
  </div>;
});

/** Why a queued message waits instead of going into the turn running now. */
export function steerBlockedNote(reason: NonNullable<Run['steerBlocked']>): string {
  return reason === 'instructions' ? t('이 메시지에는 Tower 지침이 함께 가야 해서 진행 중인 작업에 끼워넣지 않고 다음 턴으로 보냅니다.')
    : reason === 'model' ? t('선택한 모델이 진행 중인 작업과 달라 끼워넣을 수 없습니다. 작업이 끝나면 이 모델로 실행합니다.')
    : reason === 'effort' ? t('선택한 추론 수준이 진행 중인 작업과 달라 끼워넣을 수 없습니다. 작업이 끝나면 이 수준으로 실행합니다.')
    : reason === 'origin' ? t('진행 중인 작업은 트리거·Slack·다른 컴퓨터처럼 이 메시지와 다른 곳에서 시작해 끼워넣을 수 없습니다. 작업이 끝나면 실행합니다.')
    : t('진행 중인 작업이 지금은 메시지를 받을 수 없습니다. 받을 수 있게 되면 끼워넣기 버튼이 나타나고, 그 전에 작업이 끝나면 다음 턴으로 실행합니다.');
}

/** Why an owner turn has no Tower tools. Agents can manage triggers only in turns that have them. */
export function towerToolsNote(reason: NonNullable<Run['towerTools']>): string {
  return reason === 'desktop-app' ? t('이 턴은 열려 있는 Codex 앱에서 실행되어 Tower 도구가 없습니다.')
    : reason === 'external-input' ? t('외부 내용이 들어온 대화라 Tower 도구를 연결하지 않았습니다.')
    : reason === 'remote' ? t('다른 컴퓨터에서 보낸 턴이라 이 코디네이터 대화의 도구를 연결하지 않았습니다.')
    : t('자동화가 만든 대화라 Tower 도구를 연결하지 않았습니다.');
}
