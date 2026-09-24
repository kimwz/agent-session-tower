import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Terminal } from '@xterm/xterm';
import { Maximize2, Minimize2, Plus, Users, X } from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { isTerminalReport, terminalInputChunks } from './terminal-input';
import { bindWorkspaceTerminal, workspaceTerminalSession, forgetWorkspaceTerminal, MAX_TERMINAL_TABS, nextTerminalTab, readTerminalTabs, saveTerminalTabs, savedWorkspaceTerminal, terminalSlot, type TerminalTab } from './terminal-session';
import { api, ApiError, relativeTime } from '../common/lib';
import { localPart, nodeHeaders, nodeOf, nodePath, settleRequest, workspacePath } from '../remote/scope';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';

interface TerminalControls { close(): Promise<void>; restart(): void }
/** A shell in this folder; `openedBy` is absent for one this page's computer opened for this controller. */
interface SharedShell { id: string; openedAt: string; openedBy?: string }
interface TerminalState { starting: boolean; exited: boolean }

/** `machine` names the joined computer a scoped `cwd` belongs to; its shells run there and other controllers can join them. */
export function WorkspaceTerminal({ cwd, machine, token, maximized, onToggleMaximized }: { cwd: string; machine?: string; token: string; maximized: boolean; onToggleMaximized: () => void }) {
  useI18n();
  const [tabs, setTabs] = useState(() => readTerminalTabs(cwd));
  const [active, setActive] = useState(() => tabs[0]?.key ?? '');
  const [states, setStates] = useState<Record<string, TerminalState>>({});
  const [error, setError] = useState('');
  const controls = useRef(new Map<string, TerminalControls>());
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => { const saved = readTerminalTabs(cwd); setTabs(saved); setActive(saved[0]?.key ?? ''); }, [cwd]);
  const current = states[active];
  const commit = (next: TerminalTab[]) => { setTabs(next); saveTerminalTabs(cwd, next); };
  const node = nodeOf(cwd);
  const full = tabs.length >= MAX_TERMINAL_TABS;
  const add = (shell?: string) => {
    if (full) return;
    const next = nextTerminalTab(tabs);
    // Joining a shell opened elsewhere: the new tab reconnects to it instead of starting one.
    const tab: TerminalTab = shell ? { ...next, joined: true } : next;
    if (shell) bindWorkspaceTerminal(terminalSlot(cwd, tab), shell);
    commit([...tabs, tab]); setActive(tab.key); setError(''); setShared(null);
  };
  // Shells in this folder that no tab here shows, whoever opened them.
  const [shared, setShared] = useState<SharedShell[] | null>(null);
  const [ending, setEnding] = useState('');
  const sharedId = useId();
  const sharedToggle = useRef<HTMLButtonElement>(null);
  const sharedMenu = useRef<HTMLDivElement>(null);
  const showShared = async () => {
    try {
      const { terminals } = await api<{ terminals: SharedShell[] }>(workspacePath(cwd, '/api/workspace/terminals'));
      const shown = new Set(tabs.map(tab => savedWorkspaceTerminal(terminalSlot(cwd, tab))).filter(Boolean));
      setShared(terminals.filter(shell => !shown.has(shell.id))); setEnding('');
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  };
  const hideShared = (focus = false) => { setShared(null); setEnding(''); if (focus) sharedToggle.current?.focus(); };
  useEffect(() => {
    if (!shared) return;
    sharedMenu.current?.querySelector<HTMLButtonElement>('.workspace-terminal-shared-menu button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!sharedMenu.current?.contains(event.target as Node)) hideShared(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [shared !== null]);
  // Ending a shell is explicit and ends it for every window and computer using it.
  const end = async (shell: SharedShell) => {
    try { await api(nodePath(node, `/api/workspace/terminals/${encodeURIComponent(shell.id)}/close`), { method: 'POST', headers: nodeHeaders(node, { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }), body: '{}' }); }
    catch (value) { if (!(value instanceof ApiError) || ![404, 409].includes(value.status)) { setError(value instanceof Error ? value.message : String(value)); return; } }
    setEnding(''); setShared(list => list?.filter(item => item.id !== shell.id) ?? null);
  };
  const opener = (shell: SharedShell) => shell.openedBy === 'local' ? t('그 컴퓨터에서 연 터미널') : shell.openedBy === 'other' ? t('다른 제어 컴퓨터가 연 터미널')
    : shell.openedBy ? t('{0}이(가) 연 터미널', { 0: shell.openedBy }) : t('이 컴퓨터에서 연 터미널');
  // Closing a tab is the explicit stop action for its shell; a failed close keeps the tab. A tab that joined a
  // shell opened elsewhere only leaves it, and the shell stays open for whoever uses it.
  const close = async (tab: TerminalTab) => {
    if (tab.joined) {
      const slot = terminalSlot(cwd, tab);
      const id = savedWorkspaceTerminal(slot);
      if (id) forgetWorkspaceTerminal(slot, id);
    } else {
      try { await controls.current.get(tab.key)?.close(); }
      catch (value) { setError(value instanceof Error ? value.message : String(value)); return; }
    }
    // Read the latest tabs: another close may have finished while this one waited.
    setTabs(current => {
      const index = current.findIndex(item => item.key === tab.key);
      const next = current.filter(item => item.key !== tab.key);
      saveTerminalTabs(cwd, next);
      setActive(selected => selected === tab.key ? next[Math.min(index, next.length - 1)]?.key ?? '' : selected);
      return next;
    });
    setError('');
  };
  // A joined tab whose shell ended starts its own on request, and from then on closing it ends that one.
  const own = (key: string) => setTabs(current => {
    const next = current.map(item => item.key === key ? { key: item.key, number: item.number } : item);
    saveTerminalTabs(cwd, next);
    return next;
  });
  const move = (from: string, offset: number) => {
    const index = tabs.findIndex(tab => tab.key === from);
    const target = tabs[(index + offset + tabs.length) % tabs.length];
    if (!target) return;
    setActive(target.key); tabButtons.current.get(target.key)?.focus();
  };
  return <section className="workspace-terminal"><div className="workspace-terminal-toolbar">
    <div className="workspace-terminal-tabs" role="tablist" aria-label={t('터미널')}>
      {tabs.map(tab => {
        const label = t('터미널 {0}', { 0: tab.number });
        const state = states[tab.key];
        const leave = tab.joined ? t('{0}에서 나가기 (터미널은 계속 열려 있습니다)', { 0: label }) : t('{0} 닫기', { 0: label });
        return <div key={tab.key} className={`workspace-terminal-tab${tab.key === active ? ' active' : ''}${state?.exited ? ' exited' : ''}`}>
          <button ref={element => { if (element) tabButtons.current.set(tab.key, element); else tabButtons.current.delete(tab.key); }} role="tab" id={`workspace-terminal-tab-${tab.key}`} aria-selected={tab.key === active} aria-controls={`workspace-terminal-panel-${tab.key}`} tabIndex={tab.key === active ? 0 : -1}
            title={tab.joined ? t('다른 곳에서 연 터미널입니다') : undefined}
            onClick={() => setActive(tab.key)} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); move(tab.key, event.key === 'ArrowRight' ? 1 : -1); } }}>{tab.joined && <Users size={11} aria-hidden="true" />}{label}</button>
          <button className="workspace-terminal-tab-close" aria-label={leave} title={leave} disabled={!state || (state.starting && !tab.joined)} onClick={() => { void close(tab); }}><X size={12} /></button>
        </div>;
      })}
      <button className="workspace-terminal-add" aria-label={t('새 터미널 탭')} title={full ? t('터미널 탭은 최대 {0}개까지 열 수 있습니다.', { 0: MAX_TERMINAL_TABS }) : t('새 터미널 탭')} disabled={full} onClick={() => add()}><Plus size={14} /></button>
    </div>
    <div className="workspace-terminal-shared" ref={sharedMenu} onKeyDown={event => { if (event.key === 'Escape' && shared) { event.preventDefault(); event.stopPropagation(); hideShared(true); } }}>
      <button ref={sharedToggle} aria-expanded={shared !== null} aria-controls={shared ? sharedId : undefined} title={t('이 폴더에 열려 있는 다른 터미널에 들어가거나 끝냅니다')} onClick={() => { if (shared) hideShared(); else void showShared(); }}><Users size={14} />{t('열린 터미널')}</button>
      {shared && <div id={sharedId} className="workspace-terminal-shared-menu" role="group" aria-label={t('열린 터미널')}>{shared.length ? <ul>{shared.map(shell => {
        const who = opener(shell);
        return <li key={shell.id}><span><strong>{who}</strong><small>{relativeTime(shell.openedAt)}</small></span>
          {ending === shell.id
            ? <><button className="danger" onClick={() => { void end(shell); }}>{t('모두에게서 끝내기')}</button><button onClick={() => setEnding('')}>{t('취소')}</button></>
            : <><button disabled={full} title={full ? t('터미널 탭은 최대 {0}개까지 열 수 있습니다.', { 0: MAX_TERMINAL_TABS }) : undefined} onClick={() => add(shell.id)}>{t('들어가기')}</button>
              <button aria-label={t('{0} 끝내기', { 0: who })} title={t('이 터미널을 끝냅니다')} onClick={() => setEnding(shell.id)}><X size={12} /></button></>}
        </li>;
      })}</ul> : <p>{t('다른 곳에서 연 터미널이 없습니다.')}</p>}</div>}
    </div>
    <span>{machine ? t('명령은 {0}에서 실행됩니다', { 0: machine }) : t('명령은 Tower 서버에서 실행됩니다')}</span>
    {current?.exited && <button onClick={() => controls.current.get(active)?.restart()}>{t('새 터미널')}</button>}
    <button aria-label={maximized ? t('터미널 최대화 해제') : t('터미널 최대화')} title={maximized ? t('터미널 최대화 해제') : t('터미널 최대화')} aria-pressed={maximized} onClick={onToggleMaximized}>{maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
  </div>
  {error && <p role="alert" className="workspace-error">{translateMessage(error)}</p>}
  {tabs.map(tab => <TerminalPane key={tab.key} ref={value => { if (value) controls.current.set(tab.key, value); else controls.current.delete(tab.key); }} cwd={cwd} tab={tab} token={token} active={tab.key === active}
    onState={state => setStates(previous => ({ ...previous, [tab.key]: state }))} onOwned={() => own(tab.key)} />)}
  {!tabs.length && <div className="workspace-terminal-empty"><p>{t('열린 터미널이 없습니다.')}</p><button onClick={() => add()}><Plus size={14} />{t('새 터미널')}</button></div>}
  </section>;
}

function TerminalPane({ cwd, tab, token, active, onState, onOwned, ref }: { cwd: string; tab: TerminalTab; token: string; active: boolean; onState: (state: TerminalState) => void; onOwned: () => void; ref: Ref<TerminalControls> }) {
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ terminal: Terminal; fit: FitAddon }>(undefined);
  const closeSession = useRef<() => Promise<void>>(async () => {});
  const report = useRef(onState);
  report.current = onState;
  const owned = useRef(onOwned);
  owned.current = onOwned;
  // A tab that joined a shell opened elsewhere never starts one by itself.
  const joined = useRef(Boolean(tab.joined));
  const visible = useRef(active);
  visible.current = active;
  const [error, setError] = useState('');
  const [exited, setExited] = useState(false);
  const [starting, setStarting] = useState(true);
  const [generation, setGeneration] = useState(0);
  const slot = terminalSlot(cwd, tab);
  useImperativeHandle(ref, () => ({ close: () => closeSession.current(), restart: () => {
    if (joined.current) { joined.current = false; owned.current(); }
    setGeneration(value => value + 1);
  } }), []);
  useEffect(() => { report.current({ starting, exited }); }, [starting, exited]);
  useEffect(() => {
    if (!active || !terminalRef.current || !host.current?.clientWidth) return;
    terminalRef.current.fit.fit(); terminalRef.current.terminal.focus();
  }, [active]);
  useEffect(() => {
    if (!host.current || !token) return;
    let disposed = false;
    let id = '';
    let closed = false;
    let stream: EventSource | undefined;
    let pending = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let queue = Promise.resolve();
    // Replayed output can contain queries a program sent long ago. Answering them again
    // would type the replies (such as `1;2c`) into whatever now owns the shell.
    let created = false;
    let replayUntil = 0;
    let replaying = 0;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, monospace', theme: { background: '#0c1420', foreground: '#dce6f3' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current); fit.fit();
    terminalRef.current = { terminal, fit };
    setError(''); setExited(false); setStarting(true);
    let requestToken = token;
    const node = nodeOf(cwd);
    /** `once` names a request another computer must run only once, even when it is sent again later. */
    const postPath = async <T,>(path: string, body: object, once?: string): Promise<T> => {
      // Another computer runs a request once per request ID, including when it is sent again below.
      const extra = nodeHeaders(node, {}, once, once && localPart(cwd));
      const send = () => api<T>(nodePath(node, path), { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: requestToken, ...extra }, body: JSON.stringify(body) });
      try { return await send(); }
      catch (error) {
        // A 403 rejects before terminal input is delivered. Never retry a lost response.
        if (!(error instanceof ApiError) || error.status !== 403) throw error;
        const fresh = await api<{ token: string }>('/api/bootstrap');
        if (fresh.token === requestToken) throw error;
        requestToken = fresh.token;
        return send();
      }
    };
    const post = (action: string, body: object) => postPath(`/api/workspace/terminals/${encodeURIComponent(id)}/${action}`, body);
    const fail = (value: unknown) => { if (!disposed) setError(value instanceof Error ? value.message : t('터미널 연결에 실패했습니다.')); };
    const flush = () => { timer = undefined; if (!pending || !id || disposed || closed) return; const data = pending; pending = ''; queue = queue.then(async () => { for (const chunk of terminalInputChunks(data)) { if (disposed || closed) break; await post('input', { data: chunk }); } }).catch(fail); };
    const input = terminal.onData(data => { if (closed || (replaying && isTerminalReport(data))) return; pending += data; if (!timer) timer = setTimeout(flush, 15); });
    const resize = terminal.onResize(({ cols, rows }) => { if (id) queue = queue.then(async () => { if (!disposed && !closed) await post('resize', { cols, rows }); }).catch(fail); });
    const observer = new ResizeObserver(() => { if (!disposed && host.current?.clientWidth && host.current.clientHeight) fit.fit(); }); observer.observe(host.current);
    const finish = () => { forgetWorkspaceTerminal(slot, id); closed = true; terminal.options.disableStdin = true; stream?.close(); setExited(true); };
    closeSession.current = async () => { if (!id || closed) { if (id) forgetWorkspaceTerminal(slot, id); return; } try { await post('close', {}); }
      catch (error) { if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) throw error; }
      finish(); };
    void workspaceTerminalSession(slot,
      saved => postPath(`/api/workspace/terminals/${encodeURIComponent(saved)}/resize`, { cols: terminal.cols, rows: terminal.rows }),
      async () => {
        if (joined.current) throw Object.assign(new Error(t('이 터미널은 닫혔습니다. 새 터미널을 열 수 있습니다.')), { status: 404 });
        created = true;
        // A shell whose answer was lost is the one a new try gets back, not a second shell.
        const once = `terminal:${slot}`;
        try { const { id } = await postPath<{ id: string }>('/api/workspace/terminals', { cwd: localPart(cwd), cols: terminal.cols, rows: terminal.rows }, once); settleRequest(node, once); return id; }
        catch (error) { settleRequest(node, once, error); throw error; }
      },
    ).then(result => {
      id = result;
      if (disposed) return;
      setStarting(false);
      // Before listening again, check the shell is still there: a closed one ends this tab instead of retrying forever.
      const retry = () => {
        if (disposed || closed) return;
        postPath(`/api/workspace/terminals/${encodeURIComponent(id)}/resize`, { cols: terminal.cols, rows: terminal.rows }).then(() => { if (!disposed && !closed) listen(); }, error => {
          if (error instanceof ApiError && [404, 409].includes(error.status)) { terminal.writeln(`\r\n${t('터미널이 더 이상 없습니다.')}`); finish(); }
          else if (!disposed && !closed) reconnect = setTimeout(retry, 5000);
        });
      };
      const listen = () => {
        const current = stream = new EventSource(nodePath(node, `/api/workspace/terminals/${encodeURIComponent(id)}/events`));
        current.addEventListener('output', event => {
          const data = JSON.parse((event as MessageEvent).data).data;
          if (Date.now() >= replayUntil) { terminal.write(data); return; }
          replaying++; terminal.write(data, () => { replaying--; });
        });
        current.addEventListener('exit', event => { const result = JSON.parse((event as MessageEvent).data); terminal.writeln(`\r\n${t('터미널 종료 (코드 {0})', { 0: result.exitCode })}`); finish(); });
        current.onerror = () => {
          if (disposed || closed) return;
          setError(t('터미널 연결이 끊겼습니다. 다시 연결하는 중입니다.'));
          // The browser gives up on an answer that is not a stream (another computer away, for example); try again.
          if (current.readyState === EventSource.CLOSED) reconnect = setTimeout(retry, 3000);
        };
        current.onopen = () => {
          // A new shell has no history on its first connection; every reconnect replays some.
          if (created) created = false; else replayUntil = Date.now() + 500;
          void api<{ token: string }>('/api/bootstrap').then(fresh => { requestToken = fresh.token; if (!disposed) { setError(''); flush(); if (visible.current) terminal.focus(); } }).catch(fail); };
      };
      listen();
    }).catch(value => { closed = true; terminal.options.disableStdin = true; fail(value); if (!disposed) { setStarting(false); setExited(true); } });
    return () => { disposed = true; clearTimeout(timer); clearTimeout(reconnect); input.dispose(); resize.dispose(); observer.disconnect(); stream?.close(); terminal.dispose(); if (terminalRef.current?.terminal === terminal) terminalRef.current = undefined; };
  }, [cwd, slot, token, generation]);
  return <div className="workspace-terminal-panel" role="tabpanel" id={`workspace-terminal-panel-${tab.key}`} aria-labelledby={`workspace-terminal-tab-${tab.key}`} hidden={!active}>
    {error && <p role="alert" className="workspace-error">{translateMessage(error)}</p>}
    <div ref={host} className="workspace-terminal-screen" />
  </div>;
}
