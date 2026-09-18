import { translate as t, useI18n } from '../i18n/i18n';
import { storeCodexApprovalsChoice, type CodexApprovalsChoice } from './codex-approvals-preference';

/** Every place that can start a Codex session shows this, so who approves its sandbox escalations is never decided out of sight. */
export function CodexApprovalsSelect({ id, value, disabled, onChange }: { id?: string; value: CodexApprovalsChoice; disabled?: boolean; onChange: (choice: CodexApprovalsChoice) => void }) {
  useI18n();
  return <select id={id} aria-label={t("승인 검토")} value={value} disabled={disabled}
    title={t("자동 검토를 고르면 Codex의 검토 에이전트가 샌드박스 예외 요청을 판단합니다. 샌드박스 설정 자체는 그대로입니다.")}
    onChange={event => { const choice = event.target.value as CodexApprovalsChoice; storeCodexApprovalsChoice(choice); onChange(choice); }}>
    <option value="default">{t("Codex 기본값")}</option>
    <option value="auto_review">{t("자동 검토 (Approve for me)")}</option>
    <option value="user">{t("직접 확인 (Ask)")}</option>
  </select>;
}
