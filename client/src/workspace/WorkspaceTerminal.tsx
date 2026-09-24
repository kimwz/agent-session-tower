import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Terminal } from '@xterm/xterm';
import { Maximize2, Minimize2, Plus, Users, X } from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { isTerminalReport, terminalInputChunks } from './terminal-input';
import { bindWorkspaceTerminal, workspaceTerminalSession, forgetWorkspaceTerminal, MAX_TERMINAL_TABS, nextTerminalTab, readTerminalTabs, saveTerminalTabs, savedWorkspaceTerminal, settleTerminalRequest, terminalRequest, terminalSlot, type TerminalTab } from './terminal-session';
import { absoluteTime, api, ApiError, relativeTime } from '../common/lib';
import { localPart, nodeHeaders, nodeOf, nodePath, refusedBeforeRunning, requestId, workspacePath } from '../remote/scope';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';

/** `fresh`: start a new shell if the tab's shell is gone; otherwise only reach the one it has again. */
interface TerminalControls { close(): Promise<void>; restart(fresh: boolean): void }
/**
 * A shell in this folder, and who opened it as this page sees it: this computer (`self`), the computer it runs on
 * (`computer`), or a controlling computer (`controller`, named when known).
 */
interface SharedShell { id: string; openedAt: string; origin: 'self' | 'computer' | 'controller'; openedBy?: string }
/** `lost`: the tab could not reach its shell, which may still be running. */
interface TerminalState { starting: boolean; exited: boolean; lost?: boolean }

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
    // The row that had focus is gone; focus moves on to the next one, or back to the list's button.
    window.setTimeout(() => (sharedMenu.current?.querySelector<HTMLButtonElement>('.workspace-terminal-shared-menu button:not(:disabled)') ?? sharedToggle.current)?.focus());
  };
  const opener = (shell: SharedShell) => shell.origin === 'self' ? t('이 컴퓨터에서 연 터미널') : shell.origin === 'computer' ? t('그 컴퓨터에서 연 터미널')
    : shell.openedBy ? t('{0}이(가) 연 터미널', { 0: shell.openedBy }) : t('다른 제어 컴퓨터가 연 터미널');
  // Closing a tab is the explicit stop action for its shell; a failed close keeps the tab. A tab that joined a
  // shell opened elsewhere only leaves it, and the shell stays open for whoever uses it.
  const close = async (tab: TerminalTab) => {
    settleTerminalRequest(terminalSlot(cwd, tab));
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
        const leave = tab.joined ? t('{0}에서 나가기 (터미널은 계속 열려 있습니다)', { 0: label }) : t('{0} 닫기 (터미널이 끝납니다)', { 0: label });
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
        return <li key={shell.id}><span><strong>{who}</strong><small title={absoluteTime(shell.openedAt)}>{relativeTime(shell.openedAt)}</small></span>
          {ending === shell.id
            ? <><button className="danger" onClick={() => { void end(shell); }}>{t('모두에게서 끝내기')}</button><button onClick={() => setEnding('')}>{t('취소')}</button></>
            : <><button disabled={full} title={full ? t('터미널 탭은 최대 {0}개까지 열 수 있습니다.', { 0: MAX_TERMINAL_TABS }) : undefined} onClick={() => add(shell.id)}>{t('들어가기')}</button>
              <button aria-label={t('이 터미널 끝내기: {0}', { 0: who })} title={t('이 터미널을 끝냅니다')} onClick={() => setEnding(shell.id)}><X size={12} /></button></>}
        </li>;
      })}</ul> : <p>{t('다른 곳에서 연 터미널이 없습니다.')}</p>}</div>}
    </div>
    <span>{machine ? t('명령은 {0}에서 실행됩니다', { 0: machine }) : t('명령은 Tower 서버에서 실행됩니다')}</span>
    {current?.exited && <button onClick={() => controls.current.get(active)?.restart(!current.lost)}>{current.lost ? t('다시 연결') : t('새 터미널')}</button>}
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
  // A tab that joined a shell opened elsewhere starts one only when asked to after that shell is gone.
  const joined = useRef(Boolean(tab.joined));
  const fresh = useRef(false);
  const visible = useRef(active);
  visible.current = active;
  const [error, setError] = useState('');
  const [exited, setExited] = useState(false);
  const [lost, setLost] = useState(false);
  const [starting, setStarting] = useState(true);
  const [generation, setGeneration] = useState(0);
  const slot = terminalSlot(cwd, tab);
  useImperativeHandle(ref, () => ({ close: () => closeSession.current(), restart: value => { fresh.current = value; setGeneration(current => current + 1); } }), []);
  useEffect(() => { report.current({ starting, exited, lost }); }, [starting, exited, lost]);
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
    setError(''); setExited(false); setLost(false); setStarting(true);
    const asked = fresh.current;
    fresh.current = false;
    let failedOpens = 0;
    let requestToken = token;
    const node = nodeOf(cwd);
    /** `once` is the ID of a request another computer must run only once, even when it is sent again later. */
    const postPath = async <T,>(path: string, body: object, once?: string): Promise<T> => {
      // Another computer runs a request once per request ID, including when it is sent again below.
      const extra = once ? { 'X-Tower-Request-Id': once } : nodeHeaders(node, {});
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
        if (joined.current && !asked) throw Object.assign(new Error(t('이 터미널은 닫혔습니다. 새 터미널을 열 수 있습니다.')), { status: 404 });
        // From here the tab has a shell of its own, and closing it ends that shell.
        if (joined.current) { joined.current = false; owned.current(); }
        // A shell whose answer was lost is the one a new try gets back, even after a reload, not a second shell.
        const once = node ? terminalRequest(slot, () => requestId()) : undefined;
        // Only a request never sent before is sure to get a shell with no history to replay.
        created = !once?.reused;
        try { const { id } = await postPath<{ id: string }>('/api/workspace/terminals', { cwd: localPart(cwd), cols: terminal.cols, rows: terminal.rows }, once?.id); settleTerminalRequest(slot); return id; }
        catch (error) { if (refusedBeforeRunning(error)) settleTerminalRequest(slot); throw error; }
      },
    ).then(result => {
      id = result;
      if (disposed) return;
      setStarting(false);
      // Before listening again, check the shell is still there: a closed one ends this tab instead of retrying forever.
      const retry = () => {
        if (disposed || closed) return;
        postPath(`/api/workspace/terminals/${encodeURIComponent(id)}/resize`, { cols: terminal.cols, rows: terminal.rows }).then(() => {
          // A new stream replays the shell's output from the start; the screen starts over so nothing shows twice.
          if (!disposed && !closed) { terminal.reset(); listen(); }
        }, error => {
          if (disposed || closed) return;
          if (error instanceof ApiError && [404, 409].includes(error.status)) { terminal.writeln(`\r\n${t('터미널이 더 이상 없습니다.')}`); finish(); }
          else reconnect = setTimeout(retry, 5000);
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
          // The browser gives up on an answer that is not a stream (another computer away, for example); try again,
          // less often, and say so when it keeps failing although the shell is there.
          if (current.readyState !== EventSource.CLOSED) return;
          if (++failedOpens >= 3) setError(t('터미널에 다시 연결하지 못했습니다. 이 터미널을 보는 창이 너무 많거나 그 컴퓨터에 닿지 않습니다. 계속 다시 시도합니다.'));
          reconnect = setTimeout(retry, Math.min(3000 * failedOpens, 30_000));
        };
        current.onopen = () => {
          failedOpens = 0;
          // A new shell has no history on its first connection; every reconnect replays some.
          if (created) created = false; else replayUntil = Date.now() + 500;
          void api<{ token: string }>('/api/bootstrap').then(fresh => { requestToken = fresh.token; if (!disposed) { setError(''); flush(); if (visible.current) terminal.focus(); } }).catch(fail); };
      };
      listen();
    }).catch(value => {
      closed = true; terminal.options.disableStdin = true; fail(value);
      // Without an answer that the shell is gone, it may still be running: the tab offers to reach it again.
      const status = (value as { status?: number }).status;
      if (!disposed) { setStarting(false); setExited(true); setLost(status === undefined || status >= 500); }
    });
    return () => { disposed = true; clearTimeout(timer); clearTimeout(reconnect); input.dispose(); resize.dispose(); observer.disconnect(); stream?.close(); terminal.dispose(); if (terminalRef.current?.terminal === terminal) terminalRef.current = undefined; };
  }, [cwd, slot, token, generation]);
  return <div className="workspace-terminal-panel" role="tabpanel" id={`workspace-terminal-panel-${tab.key}`} aria-labelledby={`workspace-terminal-tab-${tab.key}`} hidden={!active}>
    {error && <p role="alert" className="workspace-error">{translateMessage(error)}</p>}
    <div ref={host} className="workspace-terminal-screen" />
  </div>;
}
