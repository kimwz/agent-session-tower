import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, FolderX, LoaderCircle, Monitor, Network, Plus, Radio, Trash2, X } from 'lucide-react';
import type { ControllerSummary, LinkInvite, LinkOverview, NodeSummary } from '../../../shared/link';
import { api, copyText, relativeTime } from '../common/lib';
import { translateMessage, useI18n } from '../i18n/i18n';

type Tab = 'nodes' | 'controllers' | 'exclusions';
const TABS: Tab[] = ['nodes', 'controllers', 'exclusions'];
const post = <T,>(token: string, path: string, body: unknown) => api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: JSON.stringify(body) });

/**
 * Remote computers: the ones this computer controls, the ones that control it, and what it never shares.
 * `controlledBy` names the computers controlling this one right now.
 */
export function RemoteButton({ token, projects, controlledBy = [] }: { token: string; projects: [string, string][]; controlledBy?: string[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = controlledBy.length ? t('원격 컴퓨터 · {0}이(가) 이 컴퓨터를 제어하는 중', { 0: controlledBy.join(', ') }) : t('원격 컴퓨터');
  return <>
    <button className={`icon-button remote-button ${controlledBy.length ? 'controlled' : ''}`} aria-label={label} title={label} disabled={!token} onClick={() => setOpen(true)}><Network size={18} /></button>
    {open && <RemotePanel token={token} projects={projects} onClose={() => setOpen(false)} />}
  </>;
}

export function RemotePanel({ token, projects, onClose }: { token: string; projects: [string, string][]; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>('nodes');
  const [overview, setOverview] = useState<LinkOverview | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [busy, setBusy] = useState(false);
  // The command being shown survives switching tabs; it belongs to the dialog, not to one tab.
  const [invite, setInvite] = useState<LinkInvite | null>(null);
  const known = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    try { setOverview(await api<LinkOverview>('/api/link')); setPollError(''); }
    catch (cause) { setPollError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    void refresh();
    // Connections change on their own; the panel follows while it is open.
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { window.clearInterval(timer); dialog.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, [refresh]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await work(); await refresh(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };
  const createInvite = () => void run(async () => {
    known.current = new Set(overview?.nodes.map(node => node.id) ?? []);
    setInvite(await post<LinkInvite>(token, '/api/link/invite', {}));
  });
  const tabs = { nodes: [t('이 컴퓨터가 제어'), Monitor], controllers: [t('이 컴퓨터를 제어'), Radio], exclusions: [t('공유 제외'), FolderX] } as const;
  const moveTab = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next);
    document.getElementById(`remote-tab-${next}`)?.focus();
  };
  const shownError = error || pollError;
  return createPortal(<dialog ref={dialog} className="slack-dialog remote-dialog" aria-labelledby="remote-title" onCancel={event => { event.preventDefault(); onClose(); }}><div className="slack-panel">
    <header className="slack-head"><div><h2 id="remote-title">{t('원격 컴퓨터')}</h2><p>{t('다른 컴퓨터의 Tower를 이 화면에서 쓰거나, 이 컴퓨터를 다른 Tower에 맡깁니다.')}</p></div><button className="icon-button" aria-label={t('닫기')} onClick={onClose}><X size={18} /></button></header>
    <nav className="slack-tabs" role="tablist" onKeyDown={moveTab}>{TABS.map(id => { const [label, Icon] = tabs[id]; return (
      <button key={id} id={`remote-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`remote-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={14} />{label}</button>); })}</nav>
    <div className="slack-body" role="tabpanel" id={`remote-panel-${tab}`} aria-labelledby={`remote-tab-${tab}`}>
      {shownError && <p role="alert" className="slack-error">{translateMessage(shownError)}</p>}
      {overview?.errors?.map(message => <p key={message} role="alert" className="slack-error">{translateMessage(message)}</p>)}
      {!overview ? <LoaderCircle className="spin" aria-label={t('불러오는 중')} />
        : tab === 'nodes' ? <Nodes token={token} overview={overview} busy={busy} run={run} invite={invite} known={known.current} onInvite={createInvite} />
        : tab === 'controllers' ? <Controllers token={token} overview={overview} busy={busy} run={run} />
        : <Exclusions token={token} overview={overview} projects={projects} busy={busy} run={run} />}
      {overview && <p className="remote-identity">{t('이 컴퓨터의 지문')}: <code>{overview.identity.fingerprint}</code></p>}
    </div>
  </div></dialog>, document.body);
}

type Run = (work: () => Promise<unknown>) => Promise<boolean>;

function Nodes({ token, overview, busy, run, invite, known, onInvite }: { token: string; overview: LinkOverview; busy: boolean; run: Run; invite: LinkInvite | null; known: ReadonlySet<string>; onInvite: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<'command' | 'code' | ''>('');
  const [now, setNow] = useState(Date.now());
  const [port, setPort] = useState('');
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const joined = invite ? overview.nodes.find(node => !known.has(node.id)) : undefined;
  const hub = overview.hub;
  const copy = async (kind: 'command' | 'code', value: string) => { if (await copyText(value)) { setCopied(kind); window.setTimeout(() => setCopied(''), 1500); } };
  const expired = invite && invite.expiresAt <= now;
  const changePort = (event: FormEvent) => {
    event.preventDefault();
    void run(() => post(token, '/api/link/hub', { port: Number(port) })).then(ok => { if (ok) setPort(''); });
  };
  return <section className="remote-section">
    <div className="remote-hub">
      <label className="remote-switch"><input type="checkbox" checked={hub.enabled} disabled={busy} onChange={event => void run(() => post(token, '/api/link/hub', { enabled: event.target.checked }))} /><span>{t('다른 컴퓨터의 연결 받기')}</span></label>
      <p className="trigger-note">{hub.enabled
        ? hub.listening ? t('포트 {0}에서 연결을 기다립니다. 같은 네트워크나 Tailscale로 이 컴퓨터에 닿을 수 있어야 합니다.', { 0: hub.port }) : t('연결을 받을 수 없습니다: {0}', { 0: translateMessage(hub.error ?? '') })
        : t('켜면 이 컴퓨터가 연결용 포트({0})를 엽니다. 이 화면의 주소(localhost)는 계속 이 컴퓨터에서만 열립니다.', { 0: hub.port })}</p>
      {!hub.listening && <form className="remote-port" onSubmit={changePort}>
        <label>{t('연결용 포트')}<input type="number" min={1024} max={65535} inputMode="numeric" value={port} placeholder={String(hub.port)} onChange={event => setPort(event.target.value)} /></label>
        <button className="secondary-button" disabled={busy || !port}>{t('포트 변경')}</button>
      </form>}
      {hub.enabled && hub.listening && hub.addresses.length > 0 && <ul className="remote-addresses">{hub.addresses.map(address =>
        <li key={address.url}><code>{address.url.replace(/^ws:\/\//, '').replace(/\/tower-link$/, '')}</code><small>{address.kind === 'tailscale' ? 'Tailscale' : address.kind === 'local-name' ? t('이 네트워크 이름') : address.kind === 'lan' ? t('같은 네트워크') : t('직접 지정한 주소')}</small></li>)}</ul>}
    </div>
    {hub.enabled && hub.listening && <div className="remote-invite">
      {!invite || expired ? <button type="button" className="primary-button" disabled={busy} onClick={onInvite}><Plus size={14} />{expired ? t('새 연결 명령 만들기') : t('컴퓨터 추가')}</button>
        : joined ? <div className="remote-joined-row"><p className="remote-joined" role="status"><Check size={14} />{t('{0}이(가) 연결되었습니다.', { 0: joined.label || joined.name })}</p>
          <button type="button" className="secondary-button" disabled={busy} onClick={onInvite}><Plus size={14} />{t('다른 컴퓨터 추가')}</button></div>
        : <div className="remote-command">
          <p>{t('추가할 컴퓨터의 터미널에서 아래 명령을 한 번 실행하세요. 같은 버전의 Tower가 설치되고, 로그인할 때마다 백그라운드에서 켜지며, 이 컴퓨터에 연결됩니다.')}</p>
          <div className="remote-copy"><code>{invite.command}</code><button type="button" className="icon-button" aria-label={t('명령 복사')} onClick={() => void copy('command', invite.command)}>{copied === 'command' ? <Check size={15} /> : <Copy size={15} />}</button></div>
          <p className="trigger-note">{t('그 컴퓨터에는 Node.js 22.13 이상과 Git이 필요하고, 쓸 Claude Code나 Codex에 로그인되어 있어야 합니다.')}</p>
          <p className="trigger-note">{t('그 컴퓨터에서 Tower가 이미 실행 중이면, 그 화면의 원격 컴퓨터 → 이 컴퓨터를 제어 탭에 이 코드를 붙여 넣어도 됩니다.')}</p>
          <div className="remote-copy"><code>{invite.code}</code><button type="button" className="icon-button" aria-label={t('코드 복사')} onClick={() => void copy('code', invite.code)}>{copied === 'code' ? <Check size={15} /> : <Copy size={15} />}</button></div>
          <p className="trigger-note"><LoaderCircle size={12} className="spin" /> {t('연결을 기다리는 중 · {0}분 {1}초 뒤 만료', { 0: Math.floor(Math.max(0, invite.expiresAt - now) / 60_000), 1: Math.floor(Math.max(0, invite.expiresAt - now) / 1000) % 60 })}</p>
        </div>}
    </div>}
    <h3 className="remote-heading">{t('연결된 컴퓨터')} <span className="auth-count">{overview.nodes.length}</span></h3>
    {overview.nodes.length ? <><ol className="slack-rule-list">{overview.nodes.map(node => <NodeRow key={node.id} token={token} node={node} busy={busy} run={run} />)}</ol>
      <p className="trigger-note">{t('연결된 컴퓨터의 세션을 이 화면의 캔버스에서 보고 다루는 기능은 다음 업데이트에서 추가됩니다.')}</p></>
      : <p className="slack-empty">{t('아직 연결된 컴퓨터가 없습니다.')}</p>}
  </section>;
}

function NodeRow({ token, node, busy, run }: { token: string; node: NodeSummary; busy: boolean; run: Run }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(node.label ?? '');
  const name = node.label || node.name;
  const status = { connected: t('연결됨'), offline: t('오프라인'), 'update-required': t('업데이트 필요'), 'removed-by-node': t('상대 컴퓨터가 연결을 끊음') }[node.status];
  const save = (event: FormEvent) => { event.preventDefault(); void run(() => post(token, `/api/link/nodes/${node.id}`, { label })).then(ok => { if (ok) setEditing(false); }); };
  return <li className="slack-rule-row remote-row">
    <span className={`remote-dot ${node.status}`} aria-hidden="true" />
    <div className="slack-rule-text">
      {editing ? <form className="remote-rename" onSubmit={save} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); } }}>
        <input autoFocus maxLength={80} value={label} placeholder={node.name} onChange={event => setLabel(event.target.value)} aria-label={t('표시 이름')} />
        <button className="secondary-button" disabled={busy}>{t('저장')}</button><button type="button" className="secondary-button" onClick={() => { setLabel(node.label ?? ''); setEditing(false); }}>{t('취소')}</button></form>
        : <strong>{name}</strong>}
      <small>{status}{node.version ? ` · v${node.version}` : ''} · {t('지문')} {node.fingerprint}{node.status !== 'connected' && node.lastSeenAt ? ` · ${t('마지막 연결')} ${relativeTime(node.lastSeenAt)}` : ''}</small>
    </div>
    {!editing && <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(true)}>{t('이름 변경')}</button>}
    <button type="button" className="icon-button" aria-label={t('{0} 연결 해제', { 0: name })} title={t('연결 해제')} disabled={busy}
      onClick={() => { if (window.confirm(t('{0} 연결을 해제할까요? 그 컴퓨터에서 진행 중인 작업은 계속됩니다. 다시 연결하려면 새 명령이 필요합니다.', { 0: name }))) void run(() => post(token, `/api/link/nodes/${node.id}/remove`, {})); }}><Trash2 size={15} /></button>
  </li>;
}

function Controllers({ token, overview, busy, run }: { token: string; overview: LinkOverview; busy: boolean; run: Run }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const status = (item: ControllerSummary) => ({ connected: t('연결됨'), connecting: t('연결 중'), offline: t('연결 대기'), expired: t('연결 코드 만료'), refused: t('다른 컴퓨터가 응답함'), removed: t('상대가 이 컴퓨터를 해제함') }[item.status]);
  return <section className="remote-section">
    <p className="trigger-note">{t('여기 있는 컴퓨터는 이 컴퓨터의 세션, 파일, 터미널을 이 컴퓨터 사용자 권한으로 다룰 수 있습니다. 공유 제외 탭의 폴더는 보이지 않습니다.')}</p>
    <form className="remote-join" onSubmit={event => { event.preventDefault(); void run(() => post(token, '/api/link/join', { code })).then(ok => { if (ok) setCode(''); }); }}>
      <label>{t('연결 코드 붙여넣기')}<input value={code} placeholder="tower-link:…" onChange={event => setCode(event.target.value)} spellCheck={false} autoComplete="off" /></label>
      <button className="primary-button" disabled={busy || !code.trim()}>{t('연결')}</button>
    </form>
    {overview.controllers.length ? <ol className="slack-rule-list">{overview.controllers.map(item => <li key={item.id} className="slack-rule-row remote-row">
      <span className={`remote-dot ${item.status}`} aria-hidden="true" />
      <div className="slack-rule-text"><strong>{item.name}</strong><small>{status(item)} · {t('지문')} {item.fingerprint}{item.error && item.status !== 'connected' && item.status !== 'removed' ? ` · ${translateMessage(item.error)}` : ''}{item.lastConnectedAt ? ` · ${t('마지막 연결')} ${relativeTime(item.lastConnectedAt)}` : ''}</small></div>
      <button type="button" className="icon-button" aria-label={item.status === 'removed' ? t('{0} 목록에서 지우기', { 0: item.name }) : t('{0} 연결 해제', { 0: item.name })} title={item.status === 'removed' ? t('목록에서 지우기') : t('연결 해제')} disabled={busy}
        onClick={() => { if (item.status === 'removed' || window.confirm(t('{0}이(가) 더 이상 이 컴퓨터를 제어하지 못하게 할까요? 진행 중인 작업은 계속됩니다.', { 0: item.name }))) void run(() => post(token, `/api/link/controllers/${item.id}/remove`, {})); }}><Trash2 size={15} /></button>
    </li>)}</ol> : <p className="slack-empty">{t('이 컴퓨터를 제어하는 컴퓨터가 없습니다.')}</p>}
  </section>;
}

function Exclusions({ token, overview, projects, busy, run }: { token: string; overview: LinkOverview; projects: [string, string][]; busy: boolean; run: Run }) {
  const { t } = useI18n();
  const [path, setPath] = useState('');
  const folders = overview.exclusions.folders;
  return <section className="remote-section">
    <p className="trigger-note">{t('여기 있는 폴더와 그 하위 폴더의 세션, 파일, 기록은 이 컴퓨터를 제어하는 다른 컴퓨터에 보이지 않고, 그 컴퓨터에서 이 폴더로 작업을 시작할 수도 없습니다. 원격 터미널로 파일에 접근하는 것까지 막지는 않습니다.')}</p>
    {overview.exclusions.error && <div className="remote-command" role="alert"><p>{translateMessage(overview.exclusions.error)}</p>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { if (window.confirm(t('목록을 비우고 새로 시작할까요? 제외할 폴더를 다시 추가해야 합니다.'))) void run(() => post(token, '/api/remote/exclusions', { reset: true })); }}>{t('목록 초기화')}</button></div>}
    <form className="remote-join" onSubmit={event => { event.preventDefault(); void run(() => post(token, '/api/remote/exclusions', { add: path.trim() })).then(ok => { if (ok) setPath(''); }); }}>
      <label>{t('제외할 폴더')}<input list="remote-exclusion-projects" value={path} placeholder="/Users/…" onChange={event => setPath(event.target.value)} spellCheck={false} autoComplete="off" /></label>
      <datalist id="remote-exclusion-projects">{projects.filter(([cwd]) => !folders.includes(cwd)).map(([cwd, name]) => <option key={cwd} value={cwd}>{name}</option>)}</datalist>
      <button className="primary-button" disabled={busy || !path.trim().startsWith('/')}>{t('제외')}</button>
    </form>
    {folders.length ? <ol className="slack-rule-list">{folders.map(folder => <li key={folder} className="slack-rule-row remote-row">
      <FolderX size={15} aria-hidden="true" />
      <div className="slack-rule-text"><strong>{projects.find(([cwd]) => cwd === folder)?.[1] ?? folder.split('/').filter(Boolean).at(-1) ?? folder}</strong><small>{folder}</small></div>
      <button type="button" className="icon-button" aria-label={t('{0} 제외 해제', { 0: folder })} title={t('제외 해제')} disabled={busy}
        onClick={() => void run(() => post(token, '/api/remote/exclusions', { remove: folder }))}><Trash2 size={15} /></button>
    </li>)}</ol> : <p className="slack-empty">{t('공유에서 제외한 폴더가 없습니다.')}</p>}
  </section>;
}
