import { useEffect, useState } from 'react';
import type { LinkOverview } from '../../../shared/link';
import { api } from '../common/lib';
import { useI18n } from '../i18n/i18n';

/** The name of the Tower this computer follows ("호스트 설정 따르기"), from its link overview; undefined for none. */
export function followedHostName(overview: Pick<LinkOverview, 'controllers'> | undefined): string | undefined {
  return overview?.controllers.find(item => item.followed)?.name;
}

/** Which Tower this computer follows, read once when a settings panel opens. */
export function useFollowedHost(): string | undefined {
  const [host, setHost] = useState<string>();
  useEffect(() => {
    let current = true;
    void api<LinkOverview>('/api/link').then(overview => { if (current) setHost(followedHostName(overview)); },
      // best-effort: a Tower whose links are unavailable follows nobody, and the note stays hidden.
      () => { if (current) setHost(undefined); });
    return () => { current = false; };
  }, []);
  return host;
}

/**
 * Tells this computer's owner that a panel's settings come from the followed Tower and edits here do not last. Of
 * skills only the Tower's own come from it: this computer's other skills stay as they are.
 */
export function FollowedHostNote({ host, skills = false }: { host: string | undefined; skills?: boolean }) {
  const { t } = useI18n();
  if (!host) return null;
  return <p className="trigger-note followed-host-note" role="note">{skills
    ? t('호스트 설정을 따르는 중: {0}. 그 Tower에서 온 스킬과 지침은 여기서 바꿔도 다음 동기화 때 그 Tower의 것으로 돌아갑니다.', { 0: host })
    : t('호스트 설정을 따르는 중: {0}. 여기서 바꾼 값은 다음 동기화 때 그 Tower의 값으로 돌아갑니다.', { 0: host })}</p>;
}
