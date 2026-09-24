import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Pencil, X } from 'lucide-react';
import type { Session } from '../../../shared/types';
import { api, sessionTitle } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { pathFor, scopeSession } from '../remote/scope';

export function SessionTitleEditor({ session, token, connected, onSaved }: {
  session: Session;
  token: string;
  connected: boolean;
  onSaved: (session: Session) => void;
}) {
  useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const unavailable = !connected || !token;

  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
  }, [editing]);

  const finish = () => {
    setEditing(false); setError('');
    requestAnimationFrame(() => editButton.current?.focus());
  };

  async function save(title: string) {
    if (unavailable || inFlight.current) return;
    inFlight.current = true; setSaving(true); setError('');
    try {
      const result = await api<{ session: Session }>(pathFor(session.id, id => `/api/sessions/${encodeURIComponent(id)}/title`), {
        method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token },
        body: JSON.stringify({ title: title.trim() }),
      });
      onSaved(session.node ? scopeSession(session.node, result.session) : result.session);
      finish();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("제목을 저장하지 못했습니다."));
      requestAnimationFrame(() => input.current?.focus());
    } finally { inFlight.current = false; setSaving(false); }
  }

  if (!editing) return <div className="session-title-row">
    <h2 title={sessionTitle(session)}>{sessionTitle(session)}</h2>
    <button ref={editButton} className="icon-button title-edit-button" aria-label={t("세션 제목 수정")} title={t("세션 제목 수정")} disabled={unavailable} onClick={() => {
      setDraft(sessionTitle(session)); setError(''); setEditing(true);
    }}><Pencil size={14} /></button>
  </div>;

  return <form className="session-title-editor" onSubmit={event => { event.preventDefault(); void save(draft); }} onKeyDown={event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!event.nativeEvent.isComposing && !inFlight.current) { event.preventDefault(); finish(); }
    }
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
  }}>
    <label htmlFor="session-title-input">{t("세션 제목")}</label>
    <div className="session-title-input-row">
      <input id="session-title-input" ref={input} value={draft} maxLength={120} disabled={saving} placeholder={t("비워두면 자동 제목 사용")} autoComplete="off" aria-describedby={error ? 'session-title-error' : undefined} aria-invalid={!!error} onChange={event => setDraft(event.target.value)} />
      <button className="icon-button title-save-button" type="submit" aria-label={saving ? t("제목 저장 중") : t("제목 저장")} title={t("제목 저장 (Enter)")} disabled={saving || unavailable}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={16} />}</button>
      <button className="icon-button" type="button" aria-label={t("제목 수정 취소")} title={t("취소 (Esc)")} disabled={saving} onClick={finish}><X size={16} /></button>
    </div>
    <div className="session-title-editor-footer">{session.customTitle && <button type="button" disabled={saving || unavailable} onClick={() => { void save(''); }}>{t("자동 제목으로 되돌리기")}</button>}<span>{draft.length} / 120</span></div>
    {error && <p id="session-title-error" className="session-title-error" role="alert">{translateMessage(error)}</p>}
  </form>;
}
