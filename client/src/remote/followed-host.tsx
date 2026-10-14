import { useEffect, useState } from 'react';
import type { LinkOverview } from '../../../shared/link';
import { api } from '../common/lib';
import { useI18n } from '../i18n/i18n';

/** The controlling Tower this computer follows ("호스트 설정 따르기"), by name; undefined when it follows none. */
export function followedHostName(overview: Pick<LinkOverview, 'controllers'>): string | undefined {
  return overview.controllers.find(controller => controller.followed)?.name;
}

/** Which Tower's settings this computer follows, read once when a panel opens. */
export function useFollowedHost(): string | undefined {
  const [host, setHost] = useState<string>();
  useEffect(() => {
    let live = true;
    // best-effort: without the link overview the note is simply not shown; the settings themselves are unaffected.
    void api<LinkOverview>('/api/link').then(overview => { if (live) setHost(followedHostName(overview)); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return host;
}

/** Says that settings here follow another Tower and go back to its values with the next sync. */
export function FollowedHostNote({ host }: { host?: string }) {
  const { t } = useI18n();
  if (!host) return null;
  return <p className="trigger-note followed-host-note">{t('호스트 설정을 따르는 중: {0}. 여기서 바꾼 값은 다음 동기화 때 그 Tower의 값으로 돌아갑니다.', { 0: host })}</p>;
}
