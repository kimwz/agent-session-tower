import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import { useAuth } from '../auth/AuthGate';
import { useMediaQuery } from '../common/use-media-query';
import { useI18n } from '../i18n/i18n';
import { refreshPush } from '../notifications/push';
import { ControllerJoinNotice } from '../remote/controller-join';
import { onOpenSettings } from './settings-open';
import { entryMark, initialSection, markText, requestAllowed, settingsSections, type SettingsSection } from './settings-sections';
import { SettingsDialog, type SettingsContext, type SettingsPlace } from './SettingsDialog';
import { useSettingsAttention } from './use-settings-attention';

/**
 * The one way into Tower's settings, at the top right whether the header shows or not. Its mark says what waits for
 * the owner in there, so a permission request is seen while working on the canvas too.
 */
export function SettingsButton({ context, joined }: { context: SettingsContext; joined?: { name: string; at: string } }) {
  const { t } = useI18n();
  const auth = useAuth();
  const phone = useMediaQuery('(max-width: 680px)');
  const { token } = context;
  const { attention, refresh, join } = useSettingsAttention(token, context.triggers, joined);
  const [place, setPlace] = useState<SettingsPlace | null>(null);
  const last = useRef<SettingsSection | undefined>(undefined);
  const sections = useMemo(() => settingsSections(Boolean(auth)), [auth]);
  // An allowed browser keeps its push registration in the page's current language without being asked.
  useEffect(() => { void refreshPush(token).catch(() => {}); }, [token]);
  useEffect(() => { if (place) last.current = place.section; }, [place]);
  // Looking at the remote computers is seeing who joined.
  const remoteShown = place?.section === 'remote' && !(place.list && phone);
  useEffect(() => { if (remoteShown) join.acknowledge(); }, [remoteShown, join.notice?.at]);

  const open = useCallback((section?: SettingsSection, extra: Omit<SettingsPlace, 'section'> = {}) => {
    const chosen = initialSection(section, attention, last.current, sections);
    // On a phone the settings open on their list unless something particular was asked for.
    setPlace({ section: chosen, ...extra, ...(section || attention.permissions ? {} : { list: true }) });
  }, [attention, sections]);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => onOpenSettings(request => {
    if (!requestAllowed({ token, sections, local: Boolean(auth?.status.local) }, request.section)) return false;
    openRef.current(request.section, 'cwd' in request ? { cwd: request.cwd } : {});
    return true;
  }), [token, sections, auth]);

  const close = useCallback(() => { setPlace(null); refresh(); }, [refresh]);
  const mark = entryMark(attention);
  const label = attention.permissions ? t('설정 · 권한 요청 {0}개', { 0: attention.permissions })
    : attention.skills ? t('설정 · 스킬 추천 {0}개', { 0: attention.skills })
    : mark ? t('설정 · 확인할 항목 있음') : t('설정');
  return <div className="settings-entry">
    <button type="button" className={`settings-button ${place ? 'active' : ''} ${mark?.urgent ? 'urgent' : ''}`} aria-label={label} title={label} aria-haspopup="dialog" disabled={!token} onClick={() => open()}>
      <Settings size={17} /><span className="settings-button-label">{t('설정')}</span>
      {mark?.count ? <span className={`settings-mark ${mark.urgent ? 'urgent' : ''}`} aria-hidden="true">{markText(mark.count)}</span> : mark?.dot ? <i className="settings-dot" aria-hidden="true" /> : null}
    </button>
    {join.notice && !place && <ControllerJoinNotice notice={join.notice} onDismiss={join.acknowledge} onShow={() => { join.acknowledge(); open('remote', { remoteTab: 'controllers' }); }} />}
    {place && <SettingsDialog place={place} sections={sections} attention={attention} context={context} onPlace={setPlace} onChanged={refresh} onClose={close} />}
  </div>;
}
