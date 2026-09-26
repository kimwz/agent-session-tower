import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BrainCircuit, KeyRound, LoaderCircle, Trash2, X } from 'lucide-react';
import type { DecisionFeatures, DecisionOverview } from '../../../shared/decisions';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { api } from '../common/lib';
import { translateMessage, useI18n } from '../i18n/i18n';

const post = (path: string, token: string, body: unknown) => api<DecisionOverview>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(body) });

export function DecisionButton({ token }: { token: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <><button className={`icon-button ${open ? 'active' : ''}`} title={t('빠른 판단')} aria-label={t('빠른 판단')} aria-expanded={open} onClick={() => setOpen(true)}><BrainCircuit size={18} /></button>{open && <DecisionPanel token={token} onClose={() => setOpen(false)} />}</>;
}

/** The fast-judgment service (Jev today), its API key, and which Tower features use it. */
export function DecisionPanel({ token, onClose }: { token: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [overview, setOverview] = useState<DecisionOverview | null>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setOverview(await api<DecisionOverview>('/api/decisions')), []);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    void load().catch(error => setError(error instanceof Error ? error.message : String(error)));
    return () => { element?.close(); if (opener?.isConnected) opener.focus(); };
  }, [load]);
  async function act(action: () => Promise<DecisionOverview>, done = '') {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { setOverview(await action()); if (done) setNotice(done); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const setFeature = (name: keyof DecisionFeatures, value: boolean) => overview && void act(() => post('/api/decisions/settings', token, { features: { ...overview.features, [name]: value } }));
  const label = overview?.label ?? 'Jev';
  return createPortal(<dialog ref={dialog} className="auth-dialog decision-dialog" aria-labelledby="decision-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="auth-panel">
    <header><h2 id="decision-title">{t('빠른 판단')}</h2><div><button className="icon-button" aria-label={t('닫기')} onClick={onClose}><X size={20} /></button></div></header>
    <p className="auth-hint">{t('{0} 같은 빠른 객관식 판단 서비스로 Auto Prompt 추천과 알림 선별을 켭니다. API 키가 없으면 두 기능은 꺼져 있고 Tower는 평소대로 동작합니다.', { 0: label })}</p>
    {error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}
    {notice && <p className="notification-notice" role="status">{notice}</p>}
    {!overview ? !error && <LoaderCircle className="spin" aria-label={t('연결 중')} /> : <>
      <section><h3>{t('판단 서비스')}</h3>
        <label className="decision-provider">{t('서비스')}<select value={overview.provider} disabled={busy || overview.providers.length < 2} onChange={event => void act(() => post('/api/decisions/settings', token, { provider: event.target.value }))}>
          {overview.providers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
        {overview.configured ? <div className="decision-key"><span><KeyRound size={14} />{t('저장된 API 키 {0}', { 0: overview.keyHint ?? '' })}</span>
          <button className="secondary-button" disabled={busy} onClick={() => void act(() => post('/api/decisions/test', token, {}), t('{0}가 키를 확인했습니다.', { 0: label }))}>{t('키 확인')}</button>
          <button className="icon-button" title={t('API 키 삭제')} aria-label={t('API 키 삭제')} disabled={busy} onClick={() => void act(() => post('/api/decisions/settings', token, { apiKey: null }), t('API 키를 삭제했습니다. 빠른 판단 기능이 꺼졌습니다.'))}><Trash2 size={15} /></button>
        </div> : <p className="auth-hint">{t('API 키를 저장하면 아래 기능이 켜집니다.')}</p>}
        <form className="decision-key-form" onSubmit={event => { event.preventDefault(); const value = key.trim(); if (value) void act(async () => { const next = await post('/api/decisions/settings', token, { apiKey: value }); setKey(''); return next; }, t('API 키를 저장했습니다. “키 확인”으로 동작을 확인하세요.')); }}>
          <input type="password" autoComplete="off" spellCheck={false} placeholder={overview.configured ? t('새 API 키로 바꾸기') : t('{0} API 키', { 0: label })} aria-label={t('{0} API 키', { 0: label })} value={key} disabled={busy} onChange={event => setKey(event.target.value)} />
          <button className="secondary-button" type="submit" disabled={busy || !key.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : null}{t('저장')}</button>
        </form>
      </section>
      <section><h3>{t('사용할 기능')}</h3>
        <fieldset className="notification-events" disabled={busy || !overview.configured}><legend className="sr-only">{t('사용할 기능')}</legend>
          <label><input type="checkbox" checked={overview.features.autoPromptSuggestions} onChange={event => setFeature('autoPromptSuggestions', event.target.checked)} />{t('Auto Prompt 프로젝트·세션 추천')}<small>{t('요청을 30자 이상 쓰면 5초마다 요청 내용과 프로젝트·세션의 제목과 마지막 메시지를 보내 추천을 받습니다.')}</small></label>
          <label><input type="checkbox" checked={overview.features.attentionNotifications} onChange={event => setFeature('attentionNotifications', event.target.checked)} />{t('알림 선별')}<small>{t('끝난 턴의 요청과 마지막 답변을 보내, 중간 단계로 판단된 턴은 푸시하지 않습니다.')}</small></label>
        </fieldset>
        <p className="auth-hint">{t('켜진 기능은 위 내용을 {0}로 보냅니다. API 키는 이 컴퓨터의 상태 폴더에만 저장되고 화면에 다시 표시되지 않습니다.', { 0: label })}</p>
      </section>
    </>}
  </div></dialog>, document.body);
}
