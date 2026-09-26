import type { ProviderHealth } from '../../../shared/types';
import { ModelPicker } from '../chat/ModelPicker';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Slack, Plus, Trash2, X } from 'lucide-react';
import { api } from '../common/lib';
import { authPost } from '../auth/AuthGate';
import { translateMessage, useI18n } from '../i18n/i18n';
import type { SlackRule, SlackPublicStatus } from '../../../shared/slack';
import { SLACK_CHANGED_EVENT } from './use-slack-monitor';

type Tab = 'rules' | 'account' | 'activity';
const ACTIVITY_PAGE = 20;
const incomplete = (rule: SlackRule) => ![rule.name, rule.condition, rule.instructions, rule.replyInstructions].every(value => value.trim());

export function SlackButton({ token, providers = [] }: { token: string; providers?: ProviderHealth[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <><button className="icon-button" aria-label={t('Slack 자동화')} title={t('Slack 자동화')} disabled={!token} onClick={() => setOpen(true)}><Slack size={18} /></button>{open && <SlackPanel providers={providers} token={token} onClose={() => setOpen(false)} />}</>;
}

export function SlackPanel({ token, onClose, providers = [], projects = [] }: { token: string; onClose: () => void; providers?: ProviderHealth[]; projects?: [string, string][] }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [overview, setOverview] = useState<SlackPublicStatus | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [rules, setRules] = useState<SlackRule[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
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
  const current: Tab = tab ?? (overview && !overview.connected ? 'account' : 'rules');
  function close() { if (!dirtyRef.current || window.confirm(t('저장하지 않은 지침 변경 사항을 버릴까요?'))) onClose(); }
  function edit(next: SlackRule[]) { dirtyRef.current = true; setDirty(true); setRules(next); setNotice(''); }
  function add(rule: Omit<SlackRule, 'id'>) { const id = crypto.randomUUID(); edit([...rules, { id, ...rule }]); setExpanded(id); }
  function discard() { dirtyRef.current = false; setDirty(false); setError(''); if (overview) setRules(overview.rules); }
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
  function save() {
    // Collapsed editors are not rendered, so browser validation cannot reach them; open the first incomplete one.
    const missing = rules.find(incomplete);
    if (missing) { setExpanded(missing.id); setError(t('필수 항목을 입력하세요.')); return; }
    void mutate('/api/slack/rules', { rules }, true);
  }
  const tabs: Array<[Tab, string, number?]> = [['rules', t('처리 지침'), rules.length], ['account', t('연결 및 감시')], ['activity', t('처리 기록'), overview?.events.length]];
  return createPortal(<dialog ref={dialog} className="slack-dialog" aria-labelledby="slack-title" onCancel={event => { event.preventDefault(); close(); }}><div className="slack-panel">
    <header className="slack-head"><div><h2 id="slack-title">{t('Slack 자동화')}</h2>{overview && <p><span className={`slack-dot ${overview.enabled ? 'on' : ''}`} />{overview.connected ? `${overview.account?.teamName || overview.account?.teamId} · ${overview.account?.userName || overview.account?.userId} · ${overview.enabled ? t('멘션 감시 중') : t('감시 꺼짐')}` : t('계정이 연결되지 않았습니다')}</p>}</div><button className="icon-button" aria-label={t('닫기')} onClick={close}><X size={20} /></button></header>
    {overview && <nav className="slack-tabs" role="tablist">{tabs.map(([id, label, count]) => <button key={id} type="button" role="tab" aria-selected={current === id} className={current === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{count !== undefined && <span>{count}</span>}</button>)}</nav>}
    <div className="slack-body">
      {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}{notice && <p role="status" className="slack-notice">{notice}</p>}
      {!overview ? <p role="status">{t('연결 중')}</p> : current === 'account' ? <section>{overview.connected ? <>
        <div className="slack-settings">
          <label className="slack-check"><input type="checkbox" checked={overview.enabled} disabled={busy} onChange={event => void mutate('/api/slack/settings', { enabled: event.target.checked })} /><span><strong>{t('멘션 감시')}</strong><small>{t('새 멘션마다 전용 대화를 열고 지침에 따라 처리합니다.')}</small></span></label>
          <label className="slack-check"><input type="checkbox" checked={overview.allowSelfMentions === true} disabled={busy} onChange={event => void mutate('/api/slack/settings', { allowSelfMentions: event.target.checked })} /><span><strong>{t('내 멘션도 처리 (테스트용)')}</strong><small>{t('직접 멘션해 지침을 시험할 수 있습니다. 실제 작업이 실행됩니다.')}</small></span></label>
        </div>
        <p>{t('상태')}: {overview.status}</p>{overview.error && <p role="alert" className="slack-error">{overview.error}</p>}
        <button className="secondary-button" disabled={busy} onClick={() => void mutate('/api/slack/disconnect', {})}>{t('연결 해제')}</button>
      </> : <form className="slack-connect" onSubmit={event => { event.preventDefault(); void mutate('/api/slack/connect', { appToken, userToken }).then(ok => { if (ok) { setAppToken(''); setUserToken(''); } }); }}><p>{t('Slack 앱의 Socket Mode 토큰과 사용자 OAuth 토큰을 입력하세요.')}</p><SlackSetupGuide /><label>App token (xapp)<input type="password" required autoComplete="off" value={appToken} onChange={event => setAppToken(event.target.value)} /></label><label>User OAuth token (xoxp)<input type="password" required autoComplete="off" value={userToken} onChange={event => setUserToken(event.target.value)} /></label><button className="primary-button" disabled={busy}>{t('계정 연결')}</button></form>}</section>
      : current === 'activity' ? <section><SlackActivity events={overview.events} /></section>
      : <form id="slack-rules-form" onSubmit={event => { event.preventDefault(); save(); }}><fieldset disabled={busy} className="slack-rules">
        <div className="slack-rules-intro"><p>{t('위에서부터 확인하여 처음 일치하는 활성 지침으로 작업합니다. 저장한 지침만 적용됩니다.')}</p><div className="slack-actions"><button type="button" className="secondary-button" onClick={() => add({ name: '', enabled: false, condition: '', instructions: '', replyInstructions: '', provider: 'codex' })}><Plus size={14} />{t('지침 추가')}</button><button type="button" className="secondary-button" onClick={() => add({ name: 'Verse8 PR 리뷰', enabled: false, condition: 'Verse8 관련 GitHub PR의 리뷰를 요청하는 멘션', instructions: '요청한 PR과 변경 내용을 확인하고 리뷰를 수행하세요. 접근할 수 없거나 리뷰를 완료하지 못하면 완료했다고 말하지 마세요.', replyInstructions: '리뷰를 완료하고 지적 사항이 없으면 "확인 했습니다.", 리뷰 코멘트를 작성했다면 "코멘트 확인 부탁드립니다"를 답변 후보에 포함하세요. 후보를 1, 2, 3번으로 제안하고 사용자의 전송 승인을 기다리세요.', provider: 'codex' })}>{t('Verse8 PR 예시 추가')}</button></div></div>
        {rules.length ? <SlackRules providers={providers} projects={projects} rules={rules} onChange={edit} expanded={expanded} onExpand={setExpanded} /> : <p className="slack-empty">{t('아직 지침이 없습니다. 지침을 추가하세요.')}</p>}
      </fieldset></form>}
    </div>
    {overview && current === 'rules' && dirty && <footer className="slack-savebar"><span role="status">{t('저장하지 않은 변경 사항')}</span><button type="button" className="secondary-button" disabled={busy} onClick={discard}>{t('되돌리기')}</button><button form="slack-rules-form" className="primary-button" disabled={busy}>{t('지침 저장')}</button></footer>}
  </div></dialog>, document.body);
}

export function SlackRules({ rules, onChange, providers = [], projects = [], expanded, onExpand, channel = 'slack', autoReview = true }: { rules: SlackRule[]; onChange: (rules: SlackRule[]) => void; providers?: ProviderHealth[]; expanded?: string | null; onExpand?: (id: string | null) => void;
  /** Folders offered for the working folder; any other absolute path can still be typed. */
  projects?: [string, string][];
  /** GitHub coordinators use the same rules; only the words about where replies go differ. */
  channel?: 'slack' | 'github';
  /** Whether delegated Codex work is reviewed automatically; Slack always is. */
  autoReview?: boolean }) {
  const { t } = useI18n();
  const github = channel === 'github';
  const folders = `${useId()}-folders`;
  const [local, setLocal] = useState<string | null>(rules.length === 1 ? rules[0].id : null);
  const open = expanded === undefined ? local : expanded;
  const setOpen = onExpand ?? setLocal;
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const update = (index: number, patch: Partial<SlackRule>) => onChange(rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  const move = (index: number, offset: number) => { const next = [...rules]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; onChange(next); };
  return <><ol className="slack-rule-list">{rules.map((rule, index) => {
    const isOpen = open === rule.id;
    const model = rule.model ? providers.find(provider => provider.provider === rule.provider)?.models?.find(item => item.id === rule.model)?.label ?? rule.model : undefined;
    return <li className={`slack-rule ${isOpen ? 'open' : ''} ${rule.enabled ? '' : 'disabled'}`} key={rule.id}>
      <div className="slack-rule-row">
        <label className="slack-switch" title={t('활성')}><input type="checkbox" aria-label={t('활성')} checked={rule.enabled} onChange={event => update(index, { enabled: event.target.checked })} /><span /></label>
        <button type="button" className="slack-rule-summary" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : rule.id)}>
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span className="slack-rule-index">{index + 1}</span>
          <span className="slack-rule-text"><strong>{rule.name.trim() || t('이름 없는 지침')}</strong>{!isOpen && <small>{rule.condition.trim() || t('일치 조건이 비어 있습니다')}</small>}</span>
          <span className="slack-badges"><span>{rule.provider === 'claude' ? 'Claude' : 'Codex'}{model ? ` · ${model}` : ''}</span>{rule.autoReply && <span className="accent">{t('자동 답변')}</span>}{incomplete(rule) && <span className="warn">{t('입력 필요')}</span>}</span>
        </button>
        <div className="slack-rule-tools">
          <button type="button" className="icon-button" aria-label={t('지침 위로 이동')} disabled={!index} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
          <button type="button" className="icon-button" aria-label={t('지침 아래로 이동')} disabled={index === rules.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
          {confirmDelete === rule.id
            ? <button type="button" className="slack-danger" onClick={() => { setConfirmDelete(null); onChange(rules.filter((_, i) => i !== index)); }} onBlur={() => setConfirmDelete(null)}>{t('삭제 확인')}</button>
            : <button type="button" className="icon-button" aria-label={t('지침 삭제')} onClick={() => setConfirmDelete(rule.id)}><Trash2 size={15} /></button>}
        </div>
      </div>
      {isOpen && <div className="slack-rule-editor">
        <label>{t('지침 이름')}<input required value={rule.name} onChange={event => update(index, { name: event.target.value })} /></label>
        <label>{t('일치 조건')}<small>{github ? t('어떤 이슈에 이 지침을 적용할지 설명합니다.') : t('어떤 멘션에 이 지침을 적용할지 설명합니다.')}</small><textarea required rows={2} value={rule.condition} onChange={event => update(index, { condition: event.target.value })} /></label>
        <label>{t('작업 지침')}<textarea required rows={4} value={rule.instructions} onChange={event => update(index, { instructions: event.target.value })} /></label>
        <fieldset className="slack-group"><legend>{github ? t('GitHub 댓글') : t('Slack 답변')}</legend>
          <label>{t('답변 제안 가이드')}<small>{rule.autoReply ? t('자동 답변을 작성할 때 따릅니다.') : github ? t('댓글 후보를 작성할 때 참고합니다. GitHub 게시에는 채팅에서 사용자의 승인이 필요합니다.') : t('답변 후보를 작성할 때 참고합니다. Slack 전송에는 채팅에서 사용자의 승인이 필요합니다.')}</small><textarea required rows={2} value={rule.replyInstructions} onChange={event => update(index, { replyInstructions: event.target.value })} /></label>
          <label className="slack-check"><input type="checkbox" checked={rule.autoReply === true} onChange={event => update(index, { autoReply: event.target.checked || undefined })} /><span><strong>{t('승인 없이 결과 자동 답변')}</strong><small>{github ? t('이 지침으로 위임한 작업이 끝나면 가이드대로 결과 댓글을 한 번 게시하고, 이슈에 반응을 달 수 있습니다. 채팅에서 “보내지 마세요”로 취소할 수 있습니다.') : t('이 지침으로 위임한 작업이 끝나면 답변 가이드대로 결과를 한 번 전송하고, 요청 메시지에 진행 이모지를 달 수 있습니다. 채팅에서 “보내지 마세요”로 취소할 수 있습니다.')}</small></span></label>
        </fieldset>
        <fieldset className="slack-group"><legend>{t('실행')}</legend><div className="slack-rule-options">
          <label>{t('에이전트')}<select value={rule.provider} onChange={event => update(index, { provider: event.target.value as SlackRule['provider'], model: undefined })}><option value="codex">Codex</option><option value="claude">Claude</option></select>{rule.provider === 'codex' && <small>{autoReview ? t('승인 검토: 항상 Auto') : t('승인: Tower에서 직접')}</small>}</label>
          <label>{t('모델')}<ModelPicker provider={providers.find(provider => provider.provider === rule.provider)} value={rule.model} onChange={model => update(index, { model })} /></label>
          <label className="wide">{t('작업 폴더 (선택)')}<input list={folders} value={rule.cwd || ''} placeholder={t('비워 두면 Auto Prompt가 선택합니다')} onChange={event => update(index, { cwd: event.target.value || undefined })} /></label>
        </div></fieldset>
      </div>}
    </li>;
  })}</ol><datalist id={folders}>{projects.map(([cwd, title]) => <option key={cwd} value={cwd}>{title}</option>)}</datalist></>;
}

export function SlackActivity({ events }: { events: SlackPublicStatus['events'] }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(ACTIVITY_PAGE);
  const recent = [...events].reverse().slice(0, shown);
  return events.length ? <><ol className="slack-activity">{recent.map(event => <li key={event.id}><strong>{event.rule?.name ? `${event.rule.name} · ` : ''}{event.status}</strong><a href={`https://app.slack.com/client/${encodeURIComponent(event.mention.teamId)}/${encodeURIComponent(event.mention.channel)}?thread_ts=${encodeURIComponent(event.mention.threadTs)}&message_ts=${encodeURIComponent(event.mention.ts)}`} target="_blank" rel="noreferrer">{t('Slack 스레드 열기')}</a>{event.autoPromptId && <span>Auto Prompt: {event.autoPromptId}</span>}{event.runId && <span>Run: {event.runId}</span>}{event.reason && <p>{event.reason}</p>}{event.reply && <p>{event.reply}</p>}{event.error && <p className="slack-error">{event.error}</p>}</li>)}</ol>
    {events.length > shown && <button type="button" className="secondary-button" onClick={() => setShown(shown + ACTIVITY_PAGE)}>{t('더 보기')}</button>}</> : <p>{t('아직 처리 기록이 없습니다.')}</p>;
}

function SlackSetupGuide() {
  const { t } = useI18n();
  return <details className="slack-setup-guide">
    <summary>{t('Slack 연결 설정 안내')}</summary>
    <ol>
      <li><a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">{t('Slack 앱 만들기')}</a>{t('에서 워크스페이스용 내부 앱을 만드세요. 관리자 승인이 필요할 수 있습니다.')}</li>
      <li>{t('Socket Mode를 켜고 Basic Information → App-Level Tokens에서 connections:write 권한으로 앱 토큰(xapp-)을 생성하세요.')}</li>
      <li>{t('OAuth & Permissions → User Token Scopes에 다음 권한을 추가하세요.')}<code>channels:history, groups:history, im:history, mpim:history, chat:write, reactions:write</code></li>
      <li>{t('Event Subscriptions → Subscribe to events on behalf of users에 다음 이벤트를 추가하세요.')}<code>message.channels, message.groups, message.im, message.mpim</code>{t('개인 계정의 멘션을 감시하므로 app_mention이 아닌 사용자 이벤트를 선택하세요. 감시하지 않을 대화 유형은 권한과 이벤트를 함께 제외하세요.')}</li>
      <li>{t('앱을 워크스페이스에 설치하거나 재설치하고 User OAuth Token(xoxp-)을 복사하세요. 두 토큰은 같은 앱과 워크스페이스에서 발급해야 합니다. 이 버전은 토큰 자동 교체를 지원하지 않으므로 Token Rotation은 사용하지 마세요.')}</li>
      <li>{t('아래에 두 토큰을 입력해 계정을 연결하세요. 처리 지침을 저장한 뒤 멘션 감시를 켜세요. 계정 연결만으로 감시가 시작되지는 않습니다.')}</li>
    </ol>
    <p>{t('댓글은 연결한 사용자 계정으로 게시됩니다. 감시를 켠 이후 새로 전달되는 직접 멘션만 처리하며, 과거 멘션은 가져오지 않습니다.')}</p>
  </details>;
}
