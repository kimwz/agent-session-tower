import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, FolderX, LoaderCircle, Monitor, Network, Plus, Radio, RefreshCw, Trash2, X } from 'lucide-react';
import type { ControllerSummary, LinkInvite, LinkOverview, NodeSummary, RemoteAction, RemoteChange, UpdateFailure, UpdateStage } from '../../../shared/link';
import type { TriggerAuditEntry } from '../../../shared/triggers';
import { absoluteTime, api, copyText, relativeTime } from '../common/lib';
import { translateMessage, useI18n } from '../i18n/i18n';
import { auditActionLabel } from '../triggers/trigger-helpers';

type Tab = 'nodes' | 'controllers' | 'exclusions';
const TABS: Tab[] = ['nodes', 'controllers', 'exclusions'];
const post = <T,>(token: string, path: string, body: unknown) => api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: JSON.stringify(body) });

const SEEN_JOIN = 'agent-monitor.seen-controller-join';
const seenJoin = () => { try { return localStorage.getItem(SEEN_JOIN) ?? ''; } catch { return ''; } };

/**
 * Remote computers: the ones this computer controls, the ones that control it, and what it never shares.
 * `controlledBy` names the computers controlling this one right now; `joined` is the latest that started to, shown
 * here until it is seen in any tab: dismissed, or its computer looked at.
 */
export function RemoteButton({ token, projects, controlledBy = [], joined }: { token: string; projects: [string, string][]; controlledBy?: string[]; joined?: { name: string; at: string } }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Tab | null>(null);
  const [seen, setSeen] = useState(seenJoin);
  useEffect(() => {
    const follow = (event: StorageEvent) => { if (event.key === SEEN_JOIN) setSeen(event.newValue ?? ''); };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, []);
  const label = controlledBy.length ? t('원격 컴퓨터 · {0}이(가) 이 컴퓨터를 제어하는 중', { 0: controlledBy.join(', ') }) : t('원격 컴퓨터');
  const notice = joined && joined.at > seen ? joined : undefined;
  const acknowledge = () => { if (!notice) return; try { localStorage.setItem(SEEN_JOIN, notice.at); } catch { /* Shown again next time. */ } setSeen(notice.at); };
  // With a notice showing, the panel opens on the computers controlling this one.
  const show = (tab: Tab) => { acknowledge(); setOpen(tab); };
  return <div className="remote-anchor">
    <button className={`icon-button remote-button ${controlledBy.length ? 'controlled' : ''}`} aria-label={label} title={label} disabled={!token} onClick={() => show(notice ? 'controllers' : 'nodes')}><Network size={18} /></button>
    {notice && <div className="remote-join-notice" role="status">
      <p>{t('{0}이(가) 이 컴퓨터를 제어하기 시작했습니다.', { 0: notice.name })}<small><time dateTime={notice.at}>{absoluteTime(notice.at)}</time></small></p>
      <div><button type="button" className="secondary-button" onClick={() => show('controllers')}>{t('보기')}</button>
        <button type="button" className="secondary-button" onClick={acknowledge}>{t('확인')}</button></div>
    </div>}
    {open && <RemotePanel token={token} projects={projects} initialTab={open} onClose={() => setOpen(null)} />}
  </div>;
}

export function RemotePanel({ token, projects, initialTab = 'nodes', onClose }: { token: string; projects: [string, string][]; initialTab?: Tab; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
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
  const tabs = { nodes: [t('연결한 컴퓨터'), Monitor], controllers: [t('이 컴퓨터를 제어하는 Tower'), Radio], exclusions: [t('공유 제외'), FolderX] } as const;
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
  // A computer that joined with this code, including one that was joined before and used it to join again.
  const joined = invite ? overview.nodes.find(node => node.invite === invite.id || !known.has(node.id)) : undefined;
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
        {overview.nodes.length > 0 && <small>{t('포트를 바꾸면 이미 연결한 컴퓨터는 새 명령으로 다시 연결해야 합니다.')}</small>}
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
          <p className="trigger-note">{t('그 컴퓨터에서 Tower가 이미 실행 중이면, 그 화면의 원격 컴퓨터 → 이 컴퓨터를 제어하는 Tower 탭에 이 코드를 붙여 넣어도 됩니다.')}</p>
          <div className="remote-copy"><code>{invite.code}</code><button type="button" className="icon-button" aria-label={t('코드 복사')} onClick={() => void copy('code', invite.code)}>{copied === 'code' ? <Check size={15} /> : <Copy size={15} />}</button></div>
          <p className="trigger-note"><LoaderCircle size={12} className="spin" /> {t('연결을 기다리는 중 · {0}분 {1}초 뒤 만료', { 0: Math.floor(Math.max(0, invite.expiresAt - now) / 60_000), 1: Math.floor(Math.max(0, invite.expiresAt - now) / 1000) % 60 })}</p>
        </div>}
    </div>}
    <h3 className="remote-heading">{t('연결된 컴퓨터')} <span className="auth-count">{overview.nodes.length}</span></h3>
    {overview.nodes.length ? <><ol className="slack-rule-list">{overview.nodes.map(node => <NodeRow key={node.id} token={token} node={node} version={overview.identity.version} busy={busy} run={run} />)}</ol>
      <p className="trigger-note">{t('연결된 컴퓨터와 그 세션은 캔버스에 컴퓨터별로 나타납니다. 세션 목록의 컴퓨터 필터로 한 컴퓨터만 볼 수 있습니다.')}</p></>
      : <p className="slack-empty">{t('아직 연결된 컴퓨터가 없습니다.')}</p>}
  </section>;
}

/** Whether released version `a` is newer than `b`. */
function newer(a: string | undefined, b: string | undefined): boolean {
  const [x, y] = [a, b].map(value => /^\d+\.\d+\.\d+$/.test(value ?? '') ? value!.split('.').map(Number) : undefined);
  if (!x || !y) return false;
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] > y[index];
  return false;
}

/** Where a joined computer's version stands against this Tower's, and what its update is doing or why it failed. */
export function UpdateLine({ token, node, version, busy, run }: { token: string; node: NodeSummary; version: string; busy: boolean; run: Run }) {
  const { t } = useI18n();
  const update = node.report?.update;
  const stages: Partial<Record<UpdateStage, string>> = { installing: t('설치하는 중'), checking: t('설치한 버전을 점검하는 중'), switching: t('새 버전으로 전환하는 중'), verifying: t('새 버전이 다시 연결되는지 확인하는 중'), 'rolling-back': t('이전 버전으로 되돌리는 중') };
  const failures: Record<UpdateFailure, string> = { 'low-disk': t('그 컴퓨터의 디스크 여유 공간이 2GB보다 적어 설치하지 않았습니다.'), 'install-failed': t('설치하지 못했습니다. 그 컴퓨터의 네트워크와 디스크 공간을 확인하세요.'), 'check-failed': t('설치한 버전이 실행되지 않았습니다.'),
    'switch-failed': t('새 버전으로 다시 시작하지 못했습니다.'), 'start-failed': t('새 버전이 제때 응답하지 않았습니다.'), 'link-failed': t('새 버전이 이 컴퓨터에 다시 연결하지 못했습니다.'),
    interrupted: t('업데이트가 중간에 멈췄습니다. 그 컴퓨터가 다시 시작됐을 수 있습니다.'), 'rollback-failed': t('이전 버전으로도 돌아가지 못했습니다.') };
  const ask = (label: string) => <button type="button" className="secondary-button" disabled={busy || node.status !== 'connected'} onClick={() => { void run(() => post(token, `/api/link/nodes/${node.id}/update`, {})); }}><RefreshCw size={13} />{label}</button>;
  if (update && stages[update.stage]) return <p className="remote-update" role="status"><LoaderCircle size={13} className="spin" aria-hidden="true" />{t('v{0}(으)로 업데이트: {1}', { 0: update.version, 1: stages[update.stage]! })}</p>;
  if (update?.stage === 'failed' && newer(update.version, node.version)) {
    // Running the previous version again, it came back whatever the helper saw.
    const back = update.code !== 'rollback-failed' || (node.status === 'connected' && node.version === update.previous);
    const reason = update.code === 'rollback-failed' && back ? t('새 버전으로 옮기지 못했습니다.') : update.code ? failures[update.code] : '';
    return <div className="remote-update failed"><p role="status">{back
      ? t('v{0}(으)로 업데이트하지 못해 v{1}(으)로 계속 실행 중입니다. {2}', { 0: update.version, 1: update.previous, 2: reason })
      : t('v{0}(으)로 업데이트하지 못했고, {1} 그 컴퓨터에서 Tower를 확인하세요(기록: logs/update.log).', { 0: update.version, 1: reason })}</p>{back && ask(t('다시 시도'))}</div>;
  }
  if (newer(node.version, version)) return <p className="remote-update">{t('이 Tower보다 새 버전입니다. 이 컴퓨터의 Tower를 업데이트하세요.')}</p>;
  if (!newer(version, node.version) || node.status !== 'connected') return null;
  if (!node.features.includes('status')) return <p className="remote-update">{t('이 Tower보다 이전 버전입니다. 그 컴퓨터에서 Tower를 한 번 직접 업데이트하세요. 백그라운드 서비스로 실행 중이면 그다음부터는 이 Tower를 따라 자동으로 업데이트됩니다.')}</p>;
  if (!node.features.includes('update')) return <p className="remote-update">{t('이 Tower보다 이전 버전입니다. 그 컴퓨터는 Tower를 백그라운드 서비스로 실행하지 않아 자동으로 업데이트되지 않습니다. 그 컴퓨터에서 직접 업데이트하세요.')}</p>;
  return <div className="remote-update"><p>{t('이 Tower(v{0})보다 이전 버전입니다.', { 0: version })}</p>{ask(t('지금 업데이트'))}</div>;
}

function NodeRow({ token, node, version, busy, run }: { token: string; node: NodeSummary; version: string; busy: boolean; run: Run }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(node.label ?? '');
  const name = node.label || node.name;
  const status = { connected: t('연결됨'), offline: t('오프라인'), 'update-required': t('업데이트 필요'), 'removed-by-node': t('상대 컴퓨터가 연결을 끊음') }[node.status];
  const save = (event: FormEvent) => { event.preventDefault(); void run(() => post(token, `/api/link/nodes/${node.id}`, { label })).then(ok => { if (ok) setEditing(false); }); };
  const reported = node.report?.versions;
  // The worker takes the new version once no work is running; until then it differs, and that is expected.
  const worker = reported?.worker && newer(reported.web, reported.worker) ? reported.worker : undefined;
  // So does a terminal host that keeps open terminals; it moves once they are all closed.
  const terminalHost = reported?.terminalHost && newer(reported.web, reported.terminalHost) ? reported.terminalHost : undefined;
  const free = node.report?.diskFree;
  const lowDisk = free !== undefined && free < 2 * 1024 ** 3 ? (free / 1024 ** 3).toFixed(1) : undefined;
  return <li className="slack-rule-row remote-row">
    <span className={`remote-dot ${node.status}`} aria-hidden="true" />
    <div className="slack-rule-text">
      {editing ? <form className="remote-rename" onSubmit={save} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); } }}>
        <input autoFocus maxLength={80} value={label} placeholder={node.name} onChange={event => setLabel(event.target.value)} aria-label={t('표시 이름')} />
        <button className="secondary-button" disabled={busy}>{t('저장')}</button><button type="button" className="secondary-button" onClick={() => { setLabel(node.label ?? ''); setEditing(false); }}>{t('취소')}</button></form>
        : <strong>{name}</strong>}
      <small>{status}{node.version ? ` · v${node.version}` : ''}{worker ? ` · ${t('작업 실행기 v{0} (진행 중인 작업이 끝나면 바뀜)', { 0: worker })}` : ''}{terminalHost ? ` · ${t('터미널 호스트 v{0} (열린 터미널이 모두 닫히면 바뀜)', { 0: terminalHost })}` : ''} · {t('지문')} {node.fingerprint}{node.status !== 'connected' && node.lastSeenAt ? ` · ${t('마지막 연결')} ${relativeTime(node.lastSeenAt)}` : ''}{lowDisk ? ` · ${t('디스크 여유 {0}GB', { 0: lowDisk })}` : ''}</small>
      <UpdateLine token={token} node={node} version={version} busy={busy} run={run} />
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
    <RemoteChanges />
  </section>;
}

/** What controlling computers changed here, newest first: which computer, what, and what it touched. */
/** What a controlling computer can do to a trigger, as its change history names it. */
const TRIGGER_CHANGES = new Set(['create', 'update', 'delete', 'enable', 'disable', 'run', 'revert', 'restore']);

export function RemoteChanges({ initial }: { initial?: RemoteChange[] }) {
  const { t } = useI18n();
  const [changes, setChanges] = useState<RemoteChange[] | undefined>(initial);
  const [error, setError] = useState('');
  const [shown, setShown] = useState(20);
  useEffect(() => {
    if (initial) return;
    let current = true;
    const load = () => {
      void api<{ changes: RemoteChange[] }>('/api/link/changes').then(value => { if (current) { setChanges(value.changes); setError(''); } },
        cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { current = false; window.clearInterval(timer); };
  }, [initial]);
  const actions: Record<RemoteAction, string> = { joined: t('제어를 시작함'), update: t('업데이트 요청'), session: t('새 세션'), message: t('메시지 보냄'), title: t('제목 변경'), close: t('세션 닫음'),
    reopen: t('세션 다시 엶'), approval: t('승인 요청에 답함'), steer: t('요청 끼워넣음'), cancel: t('작업 중지'), dismiss: t('실패 기록 지움'), 'auto-prompt': t('Auto Prompt'),
    'auto-prompt-cancel': t('Auto Prompt 취소'), repository: t('저장소 동기화'), 'folder-name': t('폴더 이름 변경'), file: t('파일 저장'), directory: t('폴더 만듦'),
    'terminal-open': t('터미널 엶'), 'terminal-close': t('터미널 끝냄'), trigger: t('트리거 변경') };
  // What was done, in the words used where it is done.
  const answers: Record<string, string> = { allow: t('허용함'), deny: t('거부함'), answers: t('답함'), accept: t('수락함'), decline: t('거절함'), cancel: t('취소함') };
  const detail = ({ action, detail: value }: RemoteChange) => !value ? '' : action === 'trigger' ? TRIGGER_CHANGES.has(value) ? auditActionLabel(value as TriggerAuditEntry['action'], t) : value
    : action === 'repository' ? value === 'pull' ? t('받기') : value === 'push' ? t('푸시') : value : action === 'approval' ? answers[value] ?? value : value;
  const heading = <h3>{t('최근 원격 변경')}</h3>;
  if (!changes) return error ? <div className="remote-changes">{heading}<p role="alert" className="slack-error">{t('원격 변경 기록을 불러오지 못했습니다.')} {translateMessage(error)}</p></div> : null;
  return <div className="remote-changes">
    {heading}
    {error && <p role="alert" className="slack-error">{t('원격 변경 기록을 불러오지 못했습니다.')} {translateMessage(error)}</p>}
    {changes.length ? <><ol>{changes.slice(0, shown).map((change, index) => { const done = detail(change); return <li key={`${change.at}:${index}`}>
      <span className="remote-change-what"><strong>{actions[change.action] ?? change.action}</strong>{done ? ` · ${done}` : ''}</span>
      {/* A path shows its end; a title or a trigger's name its start. */}
      {change.name || change.action === 'trigger' ? <span className="remote-change-target" title={change.name ?? change.target}><bdi dir="auto">{change.name ?? change.target}</bdi></span>
        : <span className="remote-change-target folder-tail" title={change.target}>{change.target && <bdi dir="ltr">{change.target}</bdi>}</span>}
      <small>{change.controller ?? t('해제된 컴퓨터')} · <time dateTime={change.at} title={relativeTime(change.at)}>{absoluteTime(change.at)}</time></small>
    </li>; })}</ol>
    {changes.length > shown && <button type="button" className="secondary-button" onClick={() => setShown(value => value + 50)}>{t('더 보기')}</button>}</>
      : <p className="trigger-note">{t('아직 다른 컴퓨터가 여기서 바꾼 것이 없습니다.')}</p>}
    <p className="trigger-note">{t('파일이나 메시지의 내용, 비밀 값은 기록하지 않습니다. 최근 1,000건까지 보관합니다.')}</p>
  </div>;
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
