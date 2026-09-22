import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, MessageSquare, Plus, Trash2, X } from 'lucide-react';
import { api } from '../common/lib';
import { authPost } from '../auth/AuthGate';
import { translateMessage, useI18n } from '../i18n/i18n';
import type { SlackRule, SlackPublicStatus } from '../../../shared/slack';
import { SLACK_CHANGED_EVENT } from './use-slack-monitor';

export function SlackButton({ token }: { token: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <><button className="icon-button" aria-label={t('Slack 자동화')} title={t('Slack 자동화')} disabled={!token} onClick={() => setOpen(true)}><MessageSquare size={18} /></button>{open && <SlackPanel token={token} onClose={() => setOpen(false)} />}</>;
}

export function SlackPanel({ token, onClose }: { token: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [overview, setOverview] = useState<SlackPublicStatus | null>(null);
  const [rules, setRules] = useState<SlackRule[]>([]);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [appToken, setAppToken] = useState('');
  const [userToken, setUserToken] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    async function refresh() {
      const requestRevision = revision.current;
      try {
        const next = await api<SlackPublicStatus>('/api/slack');
        if (!disposed && requestRevision === revision.current) { setOverview(next); if (!dirtyRef.current) setRules(next.rules); }
      } catch (cause) { if (!disposed && requestRevision === revision.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    }
    refreshRef.current = refresh;
    async function poll() { if (!inFlight.current) await refresh(); if (!disposed) timer = setTimeout(() => void poll(), 5000); }
    void poll();
    return () => { disposed = true; clearTimeout(timer); dialog.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  function edit(next: SlackRule[]) { dirtyRef.current = true; setDirty(true); setRules(next); setNotice(''); }
  async function mutate(path: string, body: unknown, savedRules = false) {
    if (inFlight.current) return false;
    inFlight.current = true; ++revision.current; setBusy(true); setError(''); setNotice('');
    try {
      await authPost(path, token, body);
      window.dispatchEvent(new Event(SLACK_CHANGED_EVENT));
      if (savedRules) { dirtyRef.current = false; setDirty(false); setNotice(t('지침을 저장했습니다.')); }
      await refreshRef.current();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { inFlight.current = false; setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="slack-dialog" aria-labelledby="slack-title" onCancel={onClose}><div className="slack-panel"><header><div><h2 id="slack-title">{t('Slack 자동화')}</h2><p>{t('내 멘션을 읽고 지침에 맞는 작업을 수행한 뒤 스레드에 답합니다.')}</p></div><button className="icon-button" aria-label={t('닫기')} onClick={onClose}><X size={20} /></button></header>
    {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}{notice && <p role="status">{notice}</p>}
    {!overview ? <p role="status">{t('연결 중')}</p> : <>
      <section><h3>{t('Slack 계정')}</h3>{overview.connected ? <><p>{overview.account?.teamName || overview.account?.teamId} · {overview.account?.userName || overview.account?.userId}</p><div className="slack-actions"><label className="slack-check"><input type="checkbox" checked={overview.enabled} disabled={busy} onChange={event => void mutate('/api/slack/settings', { enabled: event.target.checked })} />{t('멘션 감시')}</label><label className="slack-check"><input type="checkbox" checked={overview.allowSelfMentions === true} disabled={busy} onChange={event => void mutate('/api/slack/settings', { allowSelfMentions: event.target.checked })} />{t('내 멘션도 처리 (테스트용)')}</label><button className="secondary-button" disabled={busy} onClick={() => void mutate('/api/slack/disconnect', {})}>{t('연결 해제')}</button></div><p role="status">{t('상태')}: {overview.status}</p>{overview.error && <p role="alert" className="slack-error">{overview.error}</p>}</> : <form className="slack-connect" onSubmit={event => { event.preventDefault(); void mutate('/api/slack/connect', { appToken, userToken }).then(ok => { if (ok) { setAppToken(''); setUserToken(''); } }); }}><p>{t('Slack 앱의 Socket Mode 토큰과 사용자 OAuth 토큰을 입력하세요.')}</p><SlackSetupGuide /><label>App token (xapp)<input type="password" required autoComplete="off" value={appToken} onChange={event => setAppToken(event.target.value)} /></label><label>User OAuth token (xoxp)<input type="password" required autoComplete="off" value={userToken} onChange={event => setUserToken(event.target.value)} /></label><button className="primary-button" disabled={busy}>{t('계정 연결')}</button></form>}</section>
      <section><h3>{t('처리 지침')}</h3><p>{t('위에서부터 확인하여 처음 일치하는 활성 지침으로 작업합니다. 저장한 지침만 적용됩니다.')}</p><form onSubmit={event => { event.preventDefault(); void mutate('/api/slack/rules', { rules }, true); }}><fieldset disabled={busy} className="slack-rules"><SlackRules rules={rules} onChange={edit} /><div className="slack-actions"><button type="button" className="secondary-button" onClick={() => edit([...rules, { id: crypto.randomUUID(), name: '', enabled: false, condition: '', instructions: '', replyInstructions: '', provider: 'codex' }])}><Plus size={14} />{t('지침 추가')}</button><button type="button" className="secondary-button" onClick={() => edit([...rules, { id: crypto.randomUUID(), name: 'Verse8 PR 리뷰', enabled: false, condition: 'Verse8 관련 GitHub PR의 리뷰를 요청하는 멘션', instructions: '요청한 PR과 변경 내용을 확인하고 리뷰를 수행하세요. 접근할 수 없거나 리뷰를 완료하지 못하면 완료했다고 말하지 마세요.', replyInstructions: '리뷰를 완료하고 지적 사항이 없으면 "확인 했습니다."라고 답하세요. 리뷰 코멘트를 작성했다면 "코멘트 확인 부탁드립니다"라고 답하세요.', provider: 'codex' }])}>{t('Verse8 PR 예시 추가')}</button><button className="primary-button" disabled={!dirty}>{t('지침 저장')}</button>{dirty && <span role="status">{t('저장하지 않은 변경 사항')}</span>}</div></fieldset></form></section>
      <section><h3>{t('최근 처리 기록')}</h3><SlackActivity events={overview.events} /></section>
    </>}
  </div></dialog>, document.body);
}

export function SlackRules({ rules, onChange }: { rules: SlackRule[]; onChange: (rules: SlackRule[]) => void }) {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<SlackRule>) => onChange(rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  const move = (index: number, offset: number) => { const next = [...rules]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; onChange(next); };
  return <>{rules.map((rule, index) => <article className="slack-rule" key={rule.id}><div className="slack-actions"><strong>{index + 1}</strong><label className="slack-check"><input type="checkbox" checked={rule.enabled} onChange={event => update(index, { enabled: event.target.checked })} />{t('활성')}</label><button type="button" className="icon-button" aria-label={t('지침 위로 이동')} disabled={!index} onClick={() => move(index, -1)}><ArrowUp size={16} /></button><button type="button" className="icon-button" aria-label={t('지침 아래로 이동')} disabled={index === rules.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button><button type="button" className="icon-button" aria-label={t('지침 삭제')} onClick={() => onChange(rules.filter((_, i) => i !== index))}><Trash2 size={16} /></button></div><label>{t('지침 이름')}<input required value={rule.name} onChange={event => update(index, { name: event.target.value })} /></label><label>{t('일치 조건')}<textarea required rows={2} value={rule.condition} onChange={event => update(index, { condition: event.target.value })} /></label><label>{t('작업 지침')}<textarea required rows={3} value={rule.instructions} onChange={event => update(index, { instructions: event.target.value })} /></label><label>{t('댓글 지침')}<textarea required rows={2} value={rule.replyInstructions} onChange={event => update(index, { replyInstructions: event.target.value })} /></label><div className="slack-rule-options"><label>{t('에이전트')}<select value={rule.provider} onChange={event => update(index, { provider: event.target.value as SlackRule['provider'] })}><option value="codex">Codex</option><option value="claude">Claude</option></select>{rule.provider === 'codex' && <small>{t('승인 검토: 항상 Auto')}</small>}</label><label>{t('작업 폴더 (선택)')}<input value={rule.cwd || ''} onChange={event => update(index, { cwd: event.target.value || undefined })} /></label></div></article>)}</>;
}

export function SlackActivity({ events }: { events: SlackPublicStatus['events'] }) {
  const { t } = useI18n();
  return events.length ? <ol className="slack-activity">{events.map(event => <li key={event.id}><strong>{event.rule?.name ? `${event.rule.name} · ` : ''}{event.status}</strong><a href={`https://app.slack.com/client/${encodeURIComponent(event.mention.teamId)}/${encodeURIComponent(event.mention.channel)}?thread_ts=${encodeURIComponent(event.mention.threadTs)}&message_ts=${encodeURIComponent(event.mention.ts)}`} target="_blank" rel="noreferrer">{t('Slack 스레드 열기')}</a>{event.autoPromptId && <span>Auto Prompt: {event.autoPromptId}</span>}{event.runId && <span>Run: {event.runId}</span>}{event.reason && <p>{event.reason}</p>}{event.reply && <p>{event.reply}</p>}{event.error && <p className="slack-error">{event.error}</p>}</li>)}</ol> : <p>{t('아직 처리 기록이 없습니다.')}</p>;
}

function SlackSetupGuide() {
  const { t } = useI18n();
  return <details className="slack-setup-guide">
    <summary>{t('Slack 연결 설정 안내')}</summary>
    <ol>
      <li><a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">{t('Slack 앱 만들기')}</a>{t('에서 워크스페이스용 내부 앱을 만드세요. 관리자 승인이 필요할 수 있습니다.')}</li>
      <li>{t('Socket Mode를 켜고 Basic Information → App-Level Tokens에서 connections:write 권한으로 앱 토큰(xapp-)을 생성하세요.')}</li>
      <li>{t('OAuth & Permissions → User Token Scopes에 다음 권한을 추가하세요.')}<code>channels:history, groups:history, im:history, mpim:history, chat:write</code></li>
      <li>{t('Event Subscriptions → Subscribe to events on behalf of users에 다음 이벤트를 추가하세요.')}<code>message.channels, message.groups, message.im, message.mpim</code>{t('개인 계정의 멘션을 감시하므로 app_mention이 아닌 사용자 이벤트를 선택하세요. 감시하지 않을 대화 유형은 권한과 이벤트를 함께 제외하세요.')}</li>
      <li>{t('앱을 워크스페이스에 설치하거나 재설치하고 User OAuth Token(xoxp-)을 복사하세요. 두 토큰은 같은 앱과 워크스페이스에서 발급해야 합니다. 이 버전은 토큰 자동 교체를 지원하지 않으므로 Token Rotation은 사용하지 마세요.')}</li>
      <li>{t('아래에 두 토큰을 입력해 계정을 연결하세요. 처리 지침을 저장한 뒤 멘션 감시를 켜세요. 계정 연결만으로 감시가 시작되지는 않습니다.')}</li>
    </ol>
    <p>{t('댓글은 연결한 사용자 계정으로 게시됩니다. 감시를 켠 이후 새로 전달되는 직접 멘션만 처리하며, 과거 멘션은 가져오지 않습니다.')}</p>
  </details>;
}
