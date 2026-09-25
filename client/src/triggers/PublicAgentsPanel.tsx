import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Copy, Globe2, KeyRound, MessagesSquare, Pencil, Plus, RefreshCw, Settings, Trash2, X } from 'lucide-react';
import type { ProviderHealth } from '../../../shared/types';
import type { PublicAgent, PublicAgentInput, PublicAgentOverview, PublicConversationView, PublicRequest, PublicRequestStatus } from '../../../shared/public-agents';
import { EffortPicker, ModelPicker } from '../chat/ModelPicker';
import { api, absoluteTime, relativeTime } from '../common/lib';
import { authPost } from '../auth/AuthGate';
import { translateMessage, useI18n } from '../i18n/i18n';

type Agent = PublicAgentOverview['agents'][number];
type View = { page: 'list' } | { page: 'edit'; agent?: Agent } | { page: 'detail'; id: string };
type Tab = 'agents' | 'listener';
type Translate = (key: string, values?: Record<string, string | number>) => string;

const blank = (projects: [string, string][]): PublicAgentInput => ({ name: '', description: '', scope: '', workInstructions: '', cwd: projects[0]?.[0] ?? '', provider: 'claude', intakeProvider: 'claude', conversation: 'visitor', enabled: true });

export function requestStatusLabel(status: PublicRequestStatus, t: Translate): string {
  return t(({ reviewing: '검토 중', rejected: '거절됨', queued: '대기 중', dispatching: '시작 중', running: '진행 중', summarizing: '결과 검토 중', completed: '완료', failed: '실패' } as const)[status]);
}

/** Where visitors open an agent: the public address when one is set, else this computer's own port. */
function agentLink(agent: PublicAgent, listener: PublicAgentOverview['listener']): string {
  const origin = listener.publicUrl || (listener.port ? `http://127.0.0.1:${listener.port}` : '');
  return origin ? `${origin}/a/${agent.slug}` : '';
}

/**
 * Public agents: pages outside visitors use to ask for work within a scope the owner writes. The intake agent has no
 * tools; each request is reviewed, runs in one folder, and only a reviewed summary goes back to the visitor.
 */
export function PublicAgentsPanel({ token, providers, projects, onClose }: { token: string; providers: ProviderHealth[]; projects: [string, string][]; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [overview, setOverview] = useState<PublicAgentOverview>();
  const [view, setView] = useState<View>({ page: 'list' });
  const [tab, setTab] = useState<Tab>('agents');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { setOverview(await api<PublicAgentOverview>('/api/public-agents')); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 4000);
    return () => { window.clearInterval(timer); dialog.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, [refresh]);
  const mutate = async (action: string, body: unknown) => {
    setBusy(true); setError('');
    try { setOverview(await authPost<PublicAgentOverview>(`/api/public-agents/${action}`, token, body)); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };
  const editing = view.page === 'edit';
  const leave = (next: () => void) => { if (!editing || window.confirm(t('저장하지 않은 변경 사항을 버릴까요?'))) next(); };
  const close = () => leave(onClose);
  const detail = view.page === 'detail' ? overview?.agents.find(agent => agent.id === view.id) : undefined;
  const listener = overview?.listener;
  return createPortal(<dialog ref={dialog} className="slack-dialog trigger-dialog" aria-labelledby="public-agents-title" onCancel={event => { event.preventDefault(); close(); }}><div className="slack-panel">
    <header className="slack-head"><div><h2 id="public-agents-title">{t('공개 에이전트')}</h2>
      <p>{t('외부 사용자가 정해 둔 범위 안에서 작업을 요청하고 결과를 받아 가는 공개 페이지입니다. 대화 에이전트는 도구가 없고, 요청은 검수를 거쳐 지정한 폴더에서만 실행됩니다.')}</p></div>
      <button className="icon-button" aria-label={t('닫기')} onClick={close}><X size={18} /></button></header>
    <nav className="slack-tabs" role="tablist">{([['agents', t('에이전트'), MessagesSquare], ['listener', t('공개 주소'), Settings]] as const).map(([id, label, Icon]) =>
      <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => leave(() => { setView({ page: 'list' }); setTab(id); })}><Icon size={14} />{label}</button>)}</nav>
    <div className="slack-body">
      {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}
      {overview?.storageError && <p role="alert" className="slack-error">{translateMessage(overview.storageError)}</p>}
      {listener?.error && <p role="alert" className="slack-error">{translateMessage(listener.error)}</p>}
      {!overview ? <p className="slack-empty">{t('불러오는 중…')}</p>
        : tab === 'listener' ? <ListenerSettings listener={overview.listener} busy={busy} onSave={settings => void mutate('listener', settings)} />
        : view.page === 'edit' ? <AgentEditor key={view.agent?.id ?? 'new'} agent={view.agent} providers={providers} projects={projects} busy={busy} onCancel={() => leave(() => setView(view.agent ? { page: 'detail', id: view.agent.id } : { page: 'list' }))}
          onSave={(input, password) => void (async () => {
            const ok = view.agent ? await mutate('update', { id: view.agent.id, agent: input }) : await mutate('create', { agent: input, ...(password ? { password } : {}) });
            if (ok) setView(view.agent ? { page: 'detail', id: view.agent.id } : { page: 'list' });
          })()} />
        : detail ? <AgentDetail agent={detail} listener={overview.listener} busy={busy} token={token} onBack={() => setView({ page: 'list' })} onEdit={() => setView({ page: 'edit', agent: detail })} onMutate={mutate} />
        : <section className="trigger-list">
          <div className="trigger-toolbar"><p>{listener && !listener.listening ? t('공개 주소 탭에서 공개 페이지 포트를 먼저 정하세요.') : t('주소를 받은 사람만 들어올 수 있고, 비밀번호를 정할 수도 있습니다.')}</p>
            <button type="button" className="primary-button" onClick={() => setView({ page: 'edit' })}><Plus size={14} />{t('공개 에이전트 추가')}</button></div>
          {overview.agents.length ? <ol className="slack-rule-list">{overview.agents.map(agent => <li key={agent.id} className={`slack-rule ${agent.enabled ? '' : 'disabled'}`}><div className="slack-rule-row">
            <label className="slack-switch" title={agent.enabled ? t('켜짐') : t('꺼짐')}><input type="checkbox" aria-label={t('활성')} checked={agent.enabled} disabled={busy}
              onChange={event => void mutate('update', { id: agent.id, agent: { ...inputOf(agent), enabled: event.target.checked } })} /><span /></label>
            <button type="button" className="slack-rule-summary" onClick={() => setView({ page: 'detail', id: agent.id })}>
              <span className="trigger-kind"><Globe2 size={16} /></span>
              <span className="slack-rule-text"><strong>{agent.name}</strong><small>{agent.cwd}</small></span>
              <span className="slack-badges">
                <span>{agent.conversation === 'shared' ? t('공유 대화') : t('방문자별 대화')}</span>
                {agent.passwordSet && <span>{t('비밀번호')}</span>}
                {agent.requests.some(item => !['completed', 'failed', 'rejected'].includes(item.status)) && <span className="accent">{t('작업 중')}</span>}
              </span>
            </button>
          </div></li>)}</ol> : <p className="slack-empty">{t('아직 공개 에이전트가 없습니다.')}</p>}
        </section>}
    </div>
  </div></dialog>, document.body);
}

const inputOf = (agent: PublicAgent): PublicAgentInput => ({ name: agent.name, description: agent.description, scope: agent.scope, workInstructions: agent.workInstructions, cwd: agent.cwd, provider: agent.provider,
  ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}), intakeProvider: agent.intakeProvider, conversation: agent.conversation, enabled: agent.enabled });

function AgentEditor({ agent, providers, projects, busy, onCancel, onSave }: { agent?: Agent; providers: ProviderHealth[]; projects: [string, string][]; busy: boolean; onCancel: () => void; onSave: (input: PublicAgentInput, password?: string) => void }) {
  const { t } = useI18n();
  const [input, setInput] = useState<PublicAgentInput>(() => agent ? inputOf(agent) : blank(projects));
  const [password, setPassword] = useState('');
  const set = (patch: Partial<PublicAgentInput>) => setInput(previous => ({ ...previous, ...patch }));
  const provider = providers.find(item => item.provider === input.provider);
  const folders = projects.some(([cwd]) => cwd === input.cwd) || !input.cwd ? projects : [[input.cwd, input.cwd] as [string, string], ...projects];
  return <form className="trigger-editor" onSubmit={event => { event.preventDefault(); onSave(input, password || undefined); }}><fieldset disabled={busy}>
    <header className="trigger-editor-head">
      <button type="button" className="icon-button" aria-label={t('목록으로')} onClick={onCancel}><ArrowLeft size={16} /></button>
      <Globe2 size={18} /><h3>{agent ? t('공개 에이전트 편집') : t('새 공개 에이전트')}</h3>
    </header>
    <label className="trigger-name">{t('이름')}<input required maxLength={120} placeholder={t('예: 신규 콘텐츠 요청')} value={input.name} onChange={event => set({ name: event.target.value })} /></label>
    <section className="trigger-section"><h4><span>1</span>{t('방문자에게 보이는 것')}</h4>
      <label>{t('소개')}<textarea rows={2} maxLength={2000} value={input.description} placeholder={t('예: 새 콘텐츠 아이디어를 함께 정리하고 발행을 요청할 수 있습니다.')} onChange={event => set({ description: event.target.value })} /></label>
      <div className="trigger-grid">
        <label>{t('대화')}<select value={input.conversation} onChange={event => set({ conversation: event.target.value as 'shared' | 'visitor' })}>
          <option value="visitor">{t('방문자마다 따로')}</option><option value="shared">{t('모두 하나의 대화 공유')}</option></select>
          <small>{input.conversation === 'shared' ? t('주소를 받은 모든 사람이 같은 대화와 결과를 봅니다.') : t('브라우저마다 자기 대화만 보고, 새 대화로 시작할 수 있습니다.')}</small></label>
        {!agent && <label>{t('비밀번호 (선택)')}<input type="password" autoComplete="new-password" minLength={8} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} />
          <small>{t('비워 두면 주소만으로 들어올 수 있습니다.')}</small></label>}
      </div>
    </section>
    <section className="trigger-section"><h4><span>2</span>{t('요청할 수 있는 일')}</h4>
      <p className="trigger-note">{t('대화 에이전트와 두 검수 에이전트가 따르는 규칙입니다. 방문자는 이 범위 안의 일만 요청할 수 있습니다. 비밀이나 내부 정보는 쓰지 마세요.')}</p>
      <label>{t('범위')}<textarea required rows={6} maxLength={8000} value={input.scope} onChange={event => set({ scope: event.target.value })}
        placeholder={t('예: 팩트야 사이트에 새 콘텐츠를 발행하는 요청만 받습니다. 주제, 제목, 본문 방향을 함께 정리하고 확정되면 발행합니다. 기존 콘텐츠 삭제, 사이트 설정 변경, 내부 정보 조회는 받지 않습니다.')} /></label>
    </section>
    <section className="trigger-section"><h4><span>3</span>{t('실제 작업')}</h4>
      <label>{t('작업 지침 (방문자에게 보이지 않음)')}<textarea rows={4} maxLength={8000} value={input.workInstructions} onChange={event => set({ workInstructions: event.target.value })}
        placeholder={t('예: 콘텐츠는 content/ 아래에 만들고, 빌드가 통과하면 배포한 뒤 공개 주소를 알려 주세요.')} /></label>
      <div className="trigger-grid">
        <label className="wide">{t('폴더')}<select required value={input.cwd} onChange={event => set({ cwd: event.target.value })}>
          {folders.map(([cwd, title]) => <option key={cwd} value={cwd}>{title} — {cwd}</option>)}</select></label>
        <label>{t('작업 에이전트')}<select value={input.provider} onChange={event => set({ provider: event.target.value as 'claude' | 'codex', model: undefined, effort: undefined })}>
          <option value="claude">Claude</option><option value="codex">Codex</option></select></label>
        <label>{t('모델')}<span className="trigger-model"><ModelPicker provider={provider} value={input.model} onChange={model => set({ model, effort: undefined })} />
          <EffortPicker provider={provider} model={input.model ?? provider?.defaultModel} value={input.effort} onChange={effort => set({ effort })} /></span></label>
        <label className="wide">{t('대화·검수 모델')}<select value={input.intakeProvider} onChange={event => set({ intakeProvider: event.target.value as 'claude' | 'codex' })}>
          <option value="claude">Claude Opus</option><option value="codex">Codex</option></select>
          <small>{t('방문자와 대화하고 요청과 결과를 검수합니다. 도구 없이 실행되어 파일이나 명령에 접근할 수 없습니다.')}</small></label>
      </div>
    </section>
    <div className="trigger-editor-foot"><button type="button" className="secondary-button" onClick={onCancel}>{t('취소')}</button>
      <button type="submit" className="primary-button">{agent ? t('저장') : t('만들기')}</button></div>
  </fieldset></form>;
}

function AgentDetail({ agent, listener, busy, token, onBack, onEdit, onMutate }: { agent: Agent; listener: PublicAgentOverview['listener']; busy: boolean; token: string; onBack: () => void; onEdit: () => void; onMutate: (action: string, body: unknown) => Promise<boolean> }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [open, setOpen] = useState<string>();
  const [copied, setCopied] = useState(false);
  const link = agentLink(agent, listener);
  const ask = (action: string) => { if (confirm === action) { setConfirm(''); return true; } setConfirm(action); return false; };
  return <section className="public-agent-detail">
    <header className="trigger-editor-head">
      <button type="button" className="icon-button" aria-label={t('목록으로')} onClick={onBack}><ArrowLeft size={16} /></button>
      <Globe2 size={18} /><h3>{agent.name}</h3>
      <button type="button" className="secondary-button" onClick={onEdit}><Pencil size={13} />{t('편집')}</button>
    </header>
    <div className="trigger-section">
      <h4>{t('공개 주소')}</h4>
      {link ? <p className="public-agent-link"><code>{link}</code>
        <button type="button" className="icon-button" aria-label={t('주소 복사')} title={t('주소 복사')} onClick={() => { void navigator.clipboard?.writeText(link).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); }}><Copy size={14} /></button>
        {copied && <small>{t('복사했습니다.')}</small>}</p>
        : <p className="trigger-note">{t('공개 주소 탭에서 공개 페이지 포트를 정하면 주소가 생깁니다.')}</p>}
      {!listener.publicUrl && link && <p className="trigger-note">{t('이 주소는 이 컴퓨터에서만 열립니다. 외부에 공개하려면 터널로 이 포트를 연결하고 공개 주소를 적어 두세요.')}</p>}
      <div className="public-agent-actions">
        <button type="button" className={confirm === 'rotate' ? 'slack-danger' : 'secondary-button'} disabled={busy} onBlur={() => setConfirm('')}
          onClick={() => { if (ask('rotate')) void onMutate('rotate', { id: agent.id }); }}><RefreshCw size={13} />{confirm === 'rotate' ? t('새 주소 확인 (기존 주소는 막힘)') : t('새 주소 만들기')}</button>
        <button type="button" className={confirm === 'delete' ? 'slack-danger' : 'secondary-button'} disabled={busy} onBlur={() => setConfirm('')}
          onClick={() => { if (ask('delete')) void onMutate('delete', { id: agent.id }).then(ok => { if (ok) onBack(); }); }}><Trash2 size={13} />{confirm === 'delete' ? t('삭제 확인') : t('삭제')}</button>
      </div>
    </div>
    <form className="trigger-section" onSubmit={event => { event.preventDefault(); void onMutate('password', { id: agent.id, password }).then(ok => { if (ok) setPassword(''); }); }}>
      <h4><KeyRound size={14} />{agent.passwordSet ? t('비밀번호가 설정되어 있습니다') : t('비밀번호 없음')}</h4>
      <div className="public-agent-actions">
        <input type="password" autoComplete="new-password" aria-label={t('새 비밀번호')} placeholder={t('새 비밀번호 (8자 이상)')} minLength={8} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} />
        <button type="submit" className="secondary-button" disabled={busy || password.length < 8}>{agent.passwordSet ? t('바꾸기') : t('설정')}</button>
        {agent.passwordSet && <button type="button" className="secondary-button" disabled={busy} onClick={() => void onMutate('password', { id: agent.id, password: null })}>{t('비밀번호 없애기')}</button>}
      </div>
      <small className="trigger-note">{t('비밀번호를 바꾸거나 없애면 들어와 있던 방문자는 모두 다시 로그인해야 합니다.')}</small>
    </form>
    <div className="trigger-section">
      <h4>{t('요청')}</h4>
      {agent.requests.length ? <ol className="trigger-log">{agent.requests.map(request => <RequestRow key={request.id} request={request} />)}</ol> : <p className="trigger-note">{t('아직 요청이 없습니다.')}</p>}
    </div>
    <div className="trigger-section">
      <h4>{t('대화')}</h4>
      {agent.conversations.length ? <ol className="trigger-log">{agent.conversations.map(conversation => <li key={conversation.id}>
        <MessagesSquare size={14} /><div><p><strong>{conversation.mode === 'shared' ? t('공유 대화') : t('방문자 대화')}</strong>
          <span>{t('메시지 {0}개', { 0: conversation.messageCount })} · {t('컨텍스트 {0}%', { 0: conversation.contextPercent })}{conversation.busy ? ` · ${t('답변 중')}` : ''}</span></p>
          <small>{relativeTime(conversation.updatedAt)}{conversation.lastMessage ? ` · ${conversation.lastMessage}` : ''}</small>
          {conversation.error && <small className="slack-error">{conversation.error}</small>}
          {open === conversation.id && <ConversationView agentId={agent.id} conversationId={conversation.id} token={token} revision={conversation.updatedAt} />}</div>
        <div className="public-agent-actions">
          <button type="button" className="secondary-button" onClick={() => setOpen(open === conversation.id ? undefined : conversation.id)}>{open === conversation.id ? t('닫기') : t('보기')}</button>
          <button type="button" className={confirm === `reset:${conversation.id}` ? 'slack-danger' : 'secondary-button'} disabled={busy} onBlur={() => setConfirm('')}
            onClick={() => { if (ask(`reset:${conversation.id}`)) void onMutate('reset', { id: agent.id, conversationId: conversation.id }); }}>{confirm === `reset:${conversation.id}` ? t('초기화 확인') : t('초기화')}</button>
        </div>
      </li>)}</ol> : <p className="trigger-note">{t('아직 대화가 없습니다.')}</p>}
    </div>
  </section>;
}

function RequestRow({ request }: { request: PublicRequest }) {
  const { t } = useI18n();
  const warn = request.status === 'rejected' || request.status === 'failed';
  return <li><Globe2 size={14} /><div>
    <p><strong>{request.request.slice(0, 120)}</strong><span className={`trigger-status ${warn ? 'error' : request.status === 'completed' ? 'completed' : 'running'}`}>{requestStatusLabel(request.status, t)}</span></p>
    <small>{absoluteTime(request.createdAt)}{request.sessionId ? ` · ${request.sessionId}` : ''}</small>
    {request.reason && <small>{t('거절 이유')}: {request.reason}</small>}
    {request.result && <small className="trigger-detail" title={request.result}>{t('방문자에게 보낸 결과')}: {request.result}</small>}
    {request.error && <small className="slack-error">{request.error}</small>}
  </div></li>;
}

function ConversationView({ agentId, conversationId, revision }: { agentId: string; conversationId: string; token: string; revision: string }) {
  const { t } = useI18n();
  const [conversation, setConversation] = useState<PublicConversationView>();
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    api<PublicConversationView>(`/api/public-agents/conversation?agent=${agentId}&id=${conversationId}`).then(value => { if (current) setConversation(value); }, cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [agentId, conversationId, revision]);
  if (error) return <p className="slack-error">{translateMessage(error)}</p>;
  if (!conversation) return <p className="trigger-note">{t('불러오는 중…')}</p>;
  return <ol className="public-agent-messages">{conversation.messages.map(message => <li key={message.id} className={message.role}>
    <small>{message.role === 'agent' ? t('에이전트') : message.role === 'visitor' ? `${t('방문자')}${message.visitor ? ` ${message.visitor}` : ''}` : 'Tower'} · {absoluteTime(message.at)}</small>
    <p>{message.text}</p></li>)}</ol>;
}

function ListenerSettings({ listener, busy, onSave }: { listener: PublicAgentOverview['listener']; busy: boolean; onSave: (settings: { port: number; publicUrl: string }) => void }) {
  const { t } = useI18n();
  const [port, setPort] = useState(String(listener.port || ''));
  const [publicUrl, setPublicUrl] = useState(listener.publicUrl);
  return <form className="trigger-editor" onSubmit={event => { event.preventDefault(); onSave({ port: Number(port) || 0, publicUrl: publicUrl.trim() }); }}><fieldset disabled={busy}>
    <section className="trigger-section"><h4>{t('공개 페이지')}</h4>
      <p className="trigger-note">{t('공개 에이전트 페이지는 Tower와 다른 포트에서, 이 컴퓨터(127.0.0.1)에서만 열립니다. Cloudflare Tunnel 같은 터널로 이 포트를 별도 서브도메인에 연결해 공개하세요. Tower 화면과 API는 이 포트로 열리지 않습니다.')}</p>
      <div className="trigger-grid">
        <label>{t('포트')}<input type="number" min={0} max={65535} placeholder="8790" value={port} onChange={event => setPort(event.target.value)} /><small>{t('0이나 빈 칸이면 공개 페이지를 끕니다.')}</small></label>
        <label>{t('공개 주소')}<input type="url" placeholder="https://agents.example.com" value={publicUrl} onChange={event => setPublicUrl(event.target.value)} /><small>{t('터널이 이 포트로 보내는 주소입니다. 이 주소로 온 요청만 받습니다.')}</small></label>
      </div>
      <p className="trigger-note">{listener.listening ? t('127.0.0.1:{0}에서 열려 있습니다.', { 0: listener.port }) : t('지금은 열려 있지 않습니다.')}</p>
    </section>
    <div className="trigger-editor-foot"><button type="submit" className="primary-button">{t('저장')}</button></div>
  </fieldset></form>;
}
