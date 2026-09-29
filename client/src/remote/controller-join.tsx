import { useEffect, useState } from 'react';
import { absoluteTime } from '../common/lib';
import { useI18n } from '../i18n/i18n';

// Storage keys keep the project's first name so saved user state survives the rename (shared/app-identity.ts LEGACY_APP_NAME).
const SEEN_JOIN = 'agent-monitor.seen-controller-join';
const seenJoin = () => { try { return localStorage.getItem(SEEN_JOIN) ?? ''; } catch { return ''; } };

/**
 * The latest computer that started controlling this one, shown until it is seen in any tab: dismissed, or its
 * computer looked at.
 */
export function useControllerJoin(joined: { name: string; at: string } | undefined) {
  const [seen, setSeen] = useState(seenJoin);
  useEffect(() => {
    const follow = (event: StorageEvent) => { if (event.key === SEEN_JOIN) setSeen(event.newValue ?? ''); };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, []);
  const notice = joined && joined.at > seen ? joined : undefined;
  const acknowledge = () => { if (!notice) return; try { localStorage.setItem(SEEN_JOIN, notice.at); } catch { /* Shown again next time. */ } setSeen(notice.at); };
  return { notice, acknowledge };
}

/** Says which computer started controlling this one, beside the settings button, until the owner has seen it. */
export function ControllerJoinNotice({ notice, onShow, onDismiss }: { notice: { name: string; at: string }; onShow: () => void; onDismiss: () => void }) {
  const { t } = useI18n();
  return <div className="remote-join-notice" role="status">
    <p>{t('{0}이(가) 이 컴퓨터를 제어하기 시작했습니다.', { 0: notice.name })}<small><time dateTime={notice.at}>{absoluteTime(notice.at)}</time></small></p>
    <div><button type="button" className="secondary-button" onClick={onShow}>{t('보기')}</button>
      <button type="button" className="secondary-button" onClick={onDismiss}>{t('확인')}</button></div>
  </div>;
}
