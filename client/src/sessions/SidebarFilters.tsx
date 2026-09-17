import { ChevronDown } from 'lucide-react';
import type { SessionStatus } from '../../../shared/types';
import { translate as t, useI18n } from '../i18n/i18n';

export function SidebarFilters({ status, onStatusChange, period, onPeriodChange, total, working, completed }: {
  status: 'all' | SessionStatus;
  onStatusChange: (status: 'all' | SessionStatus) => void;
  period: string;
  onPeriodChange: (period: string) => void;
  total: number;
  working: number;
  completed: number;
}) {
  useI18n();
  return <div className="sidebar-filters">
    <div className="sidebar-status-filters" role="group" aria-label={t("세션 상태 필터")}>
      <button className={status === 'all' ? 'selected' : ''} aria-pressed={status === 'all'} onClick={() => onStatusChange('all')}><span>{t("전체")}</span><b>{total.toLocaleString()}</b></button>
      <button className={`working ${status === 'working' ? 'selected' : ''}`} aria-pressed={status === 'working'} onClick={() => onStatusChange(status === 'working' ? 'all' : 'working')}><span>{t("작업 중")}</span><b>{working.toLocaleString()}</b></button>
      <button className={status === 'completed' ? 'selected' : ''} aria-pressed={status === 'completed'} onClick={() => onStatusChange(status === 'completed' ? 'all' : 'completed')}><span>{t("완료")}</span><b>{completed.toLocaleString()}</b></button>
    </div>
    <div className="sidebar-time-status">
      <label><select aria-label={t("세션 조회 기간")} value={period} onChange={event => onPeriodChange(event.target.value)}><option value="1">{t("최근 24시간")}</option><option value="7">{t("최근 7일")}</option><option value="30">{t("최근 30일")}</option><option value="all">{t("전체 기록")}</option></select><ChevronDown size={11} /></label>
      <label><select aria-label={t("그 외 세션 상태")} value={status === 'idle' || status === 'error' ? status : ''} onChange={event => onStatusChange(event.target.value as SessionStatus)}><option value="" disabled>{t("그 외 상태")}</option><option value="idle">{t("대기 중")}</option><option value="error">{t("중단·오류")}</option></select><ChevronDown size={11} /></label>
    </div>
  </div>;
}
