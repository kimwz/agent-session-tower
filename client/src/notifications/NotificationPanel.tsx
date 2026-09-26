import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, BellOff, BellRing, LoaderCircle, Trash2, X } from 'lucide-react';
import type { NotificationEvents, NotificationOverview } from '../../../shared/notifications';
import { api } from '../common/lib';
import { locale, translateMessage, useI18n } from '../i18n/i18n';
import { deviceIdOf, disablePush, enablePush, existingSubscription, notificationPost, pushSupport, refreshPush } from './push';

export function NotificationButton({ token }: { token: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // An allowed browser keeps its registration in the page's current language without being asked.
  useEffect(() => { void refreshPush(token).catch(() => {}); }, [token]);
  return <><button className={`icon-button ${open ? 'active' : ''}`} title={t('알림')} aria-label={t('알림')} aria-expanded={open} onClick={() => setOpen(true)}><Bell size={18} /></button>{open && <NotificationPanel token={token} onClose={() => setOpen(false)} />}</>;
}

export function NotificationPanel({ token, onClose }: { token: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [overview, setOverview] = useState<NotificationOverview | null>(null);
  const [ownId, setOwnId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const support = pushSupport();
  const permission = support === 'supported' ? Notification.permission : 'default';
  const load = useCallback(async (next?: NotificationOverview) => {
    const value = next ?? await api<NotificationOverview>('/api/notifications');
    const subscription = await existingSubscription(value.publicKey).catch(() => null);
    setOwnId(subscription ? await deviceIdOf(subscription) : null);
    setOverview(value);
  }, []);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    void load().catch(error => setError(error instanceof Error ? error.message : String(error)));
    return () => { element?.close(); if (opener?.isConnected) opener.focus(); };
  }, [load]);
  async function act(action: () => Promise<NotificationOverview | undefined>, done = '') {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { const next = await action(); await load(next); if (done) setNotice(done); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const own = overview?.devices.find(device => device.id === ownId);
  const setEvent = (key: keyof NotificationEvents, value: boolean) => own && void act(() => notificationPost('/api/notifications/update', token, { id: own.id, events: { ...own.events, [key]: value } }));
  const date = (at: string) => new Date(at).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const unavailable = support === 'insecure' ? t('HTTPS 주소나 localhost로 연 페이지에서만 알림을 받을 수 있습니다.')
    : support === 'install' ? t('iPhone과 iPad에서는 공유 메뉴의 “홈 화면에 추가”로 설치한 뒤, 설치한 앱에서 알림을 켜세요.')
    : support === 'unsupported' ? t('이 브라우저는 푸시 알림을 지원하지 않습니다.')
    : permission === 'denied' ? t('이 사이트의 알림이 브라우저 설정에서 차단되어 있습니다. 브라우저 설정에서 허용한 뒤 다시 시도하세요.') : '';
  return createPortal(<dialog ref={dialog} className="auth-dialog notification-dialog" aria-labelledby="notification-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="auth-panel">
    <header><h2 id="notification-title">{t('알림')}</h2><div><button className="icon-button" aria-label={t('닫기')} onClick={onClose}><X size={20} /></button></div></header>
    <p className="auth-hint">{t('프로젝트 채팅의 작업이 끝나거나, 대화가 승인·답변을 기다리거나, 트리거가 작업을 시작하면 알림을 보냅니다. 페이지를 닫아도 이 기기로 전달됩니다.')}</p>
    {error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}
    {notice && <p className="notification-notice" role="status">{notice}</p>}
    {!overview ? !error && <LoaderCircle className="spin" aria-label={t('연결 중')} /> : <>
      <section><h3>{t('이 기기')}</h3>
        {unavailable ? <p className="auth-hint">{unavailable}</p> : own ? <>
          <div className="notification-own"><span><BellRing size={15} />{t('알림 받는 중')} · {own.label}</span><button className="secondary-button" disabled={busy} onClick={() => void act(() => disablePush(token, overview.publicKey), t('이 기기의 알림을 껐습니다.'))}><BellOff size={14} />{t('끄기')}</button></div>
          <fieldset className="notification-events" disabled={busy}><legend>{t('받을 알림')}</legend>
            <label><input type="checkbox" checked={own.events.runCompleted} onChange={event => setEvent('runCompleted', event.target.checked)} />{t('채팅 작업 완료')}<small>{t('프로젝트 채팅에서 보낸 요청이 끝나거나 오류로 멈췄을 때. 다음 요청이 이어지는 중간 턴은 알리지 않습니다.')}</small></label>
            <label><input type="checkbox" checked={own.events.runWaiting} onChange={event => setEvent('runWaiting', event.target.checked)} />{t('승인·답변 대기')}<small>{t('대화가 승인이나 질문에 대한 답을 기다릴 때')}</small></label>
            <label><input type="checkbox" checked={own.events.triggerStarted} onChange={event => setEvent('triggerStarted', event.target.checked)} />{t('트리거 작업 시작')}<small>{t('트리거가 실행되어 작업을 시작했을 때')}</small></label>
          </fieldset>
          <button className="secondary-button" disabled={busy} onClick={() => void act(() => notificationPost('/api/notifications/test', token, { id: own.id }), t('테스트 알림을 보냈습니다.'))}>{t('테스트 알림 보내기')}</button>
          {own.lastError && <p className="auth-error">{t('마지막 전송 실패: {0}', { 0: own.lastError })}</p>}
        </> : <button className="secondary-button notification-enable" disabled={busy} onClick={() => void act(() => enablePush(token, overview.publicKey), t('이 기기에서 알림을 받습니다.'))}>{busy ? <LoaderCircle className="spin" size={14} /> : <Bell size={14} />}{t('이 기기에서 알림 받기')}</button>}
      </section>
      <section><h3>{t('알림 받는 기기')} <span className="auth-count">{overview.devices.length}</span></h3>
        {overview.devices.length ? <ul className="notification-devices">{overview.devices.map(device => <li key={device.id}>
          <div><strong>{device.label}{device.id === ownId ? ` (${t('이 기기')})` : ''}</strong><small>{t('등록 {0}', { 0: date(device.createdAt) })}{device.lastSentAt ? ` · ${t('마지막 전송 {0}', { 0: date(device.lastSentAt) })}` : ''}</small>{device.lastError && <small className="auth-error">{device.lastError}</small>}</div>
          <button className="icon-button" title={t('삭제')} aria-label={t('{0} 삭제', { 0: device.label })} disabled={busy} onClick={() => void act(() => notificationPost('/api/notifications/remove', token, { id: device.id }))}><Trash2 size={15} /></button>
        </li>)}</ul> : <p className="auth-empty">{t('알림을 받는 기기가 없습니다.')}</p>}
      </section>
    </>}
  </div></dialog>, document.body);
}
