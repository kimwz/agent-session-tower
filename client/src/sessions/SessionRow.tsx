import { translate as t, useI18n } from '../i18n/i18n';
import { ArrowUpRight, GitBranch } from 'lucide-react';
import type { Session } from '../../../shared/types';
import { ProviderIcon } from '../common/Icons';
import { cleanPreview, providerLabels, relativeTime, sessionActivityAt, sessionTitle, statusLabels } from '../common/lib';

export function SessionRow({ session, selected, unread, onSelect }: { session: Session; selected: boolean; unread: boolean; onSelect: (id: string) => void }) {
  useI18n();
  const activityAt = sessionActivityAt(session);
  return <button className={`session-row ${selected ? 'selected' : ''} ${unread ? 'unread' : ''}`} onClick={() => onSelect(session.id)} aria-pressed={selected}>
    <span className={`session-row-icon ${session.provider} ${session.status}`}><ProviderIcon provider={session.provider} size={17} /><i className={`status-pip ${session.status}`} /></span>
    <span className="session-row-main"><span className="session-row-heading"><span className="session-row-project folder-tail" title={session.cwd || session.project || t("프로젝트 없음")}><bdi dir="ltr">{session.project || t("프로젝트 없음")}</bdi></span><time dateTime={activityAt}>{relativeTime(activityAt)}</time></span><strong>{unread && <i className="unread-dot" title={t("새 활동")} aria-label={t("새 활동")} />}{sessionTitle(session)}</strong><span className="session-row-preview">{cleanPreview(session.lastMessage, 100) || providerLabels[session.provider]}</span><span className="session-row-meta"><span className={`row-status ${session.status}`}>{statusLabels[session.status]}</span>{session.isSubagent && <><GitBranch size={10} /><span>{t("하위 에이전트")}</span></>}{selected && <ArrowUpRight size={12} />}</span></span>
  </button>;
}
