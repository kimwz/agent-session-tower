import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Terminal } from '@xterm/xterm';
import { Maximize2, Minimize2, Plus, X } from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { terminalInputChunks } from './terminal-input';
import { workspaceTerminalSession, forgetWorkspaceTerminal, MAX_TERMINAL_TABS, nextTerminalTab, readTerminalTabs, saveTerminalTabs, terminalSlot, type TerminalTab } from './terminal-session';
import { api, ApiError } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';

interface TerminalControls { close(): Promise<void>; restart(): void }
interface TerminalState { starting: boolean; exited: boolean }

export function WorkspaceTerminal({ cwd, token, maximized, onToggleMaximized }: { cwd: string; token: string; maximized: boolean; onToggleMaximized: () => void }) {
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
  const add = () => { if (tabs.length >= MAX_TERMINAL_TABS) return; const tab = nextTerminalTab(tabs); commit([...tabs, tab]); setActive(tab.key); setError(''); };
  // Closing a tab is the explicit stop action for its shell; a failed close keeps the tab.
  const close = async (tab: TerminalTab) => {
    try { await controls.current.get(tab.key)?.close(); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); return; }
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
        return <div key={tab.key} className={`workspace-terminal-tab${tab.key === active ? ' active' : ''}${state?.exited ? ' exited' : ''}`}>
          <button ref={element => { if (element) tabButtons.current.set(tab.key, element); else tabButtons.current.delete(tab.key); }} role="tab" id={`workspace-terminal-tab-${tab.key}`} aria-selected={tab.key === active} aria-controls={`workspace-terminal-panel-${tab.key}`} tabIndex={tab.key === active ? 0 : -1}
            onClick={() => setActive(tab.key)} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); move(tab.key, event.key === 'ArrowRight' ? 1 : -1); } }}>{label}</button>
          <button className="workspace-terminal-tab-close" aria-label={t('{0} 닫기', { 0: label })} title={t('{0} 닫기', { 0: label })} disabled={!state || state.starting} onClick={() => { void close(tab); }}><X size={12} /></button>
        </div>;
      })}
      <button className="workspace-terminal-add" aria-label={t('새 터미널 탭')} title={tabs.length >= MAX_TERMINAL_TABS ? t('터미널 탭은 최대 {0}개까지 열 수 있습니다.', { 0: MAX_TERMINAL_TABS }) : t('새 터미널 탭')} disabled={tabs.length >= MAX_TERMINAL_TABS} onClick={add}><Plus size={14} /></button>
    </div>
    <span>{t('명령은 Tower 서버에서 실행됩니다')}</span>
    {current?.exited && <button onClick={() => controls.current.get(active)?.restart()}>{t('새 터미널')}</button>}
    <button aria-label={maximized ? t('터미널 최대화 해제') : t('터미널 최대화')} title={maximized ? t('터미널 최대화 해제') : t('터미널 최대화')} aria-pressed={maximized} onClick={onToggleMaximized}>{maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
  </div>
  {error && <p role="alert" className="workspace-error">{translateMessage(error)}</p>}
  {tabs.map(tab => <TerminalPane key={tab.key} ref={value => { if (value) controls.current.set(tab.key, value); else controls.current.delete(tab.key); }} cwd={cwd} tab={tab} token={token} active={tab.key === active}
    onState={state => setStates(previous => ({ ...previous, [tab.key]: state }))} />)}
  {!tabs.length && <div className="workspace-terminal-empty"><p>{t('열린 터미널이 없습니다.')}</p><button onClick={add}><Plus size={14} />{t('새 터미널')}</button></div>}
  </section>;
}

function TerminalPane({ cwd, tab, token, active, onState, ref }: { cwd: string; tab: TerminalTab; token: string; active: boolean; onState: (state: TerminalState) => void; ref: Ref<TerminalControls> }) {
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ terminal: Terminal; fit: FitAddon }>(undefined);
  const closeSession = useRef<() => Promise<void>>(async () => {});
  const report = useRef(onState);
  report.current = onState;
  const visible = useRef(active);
  visible.current = active;
  const [error, setError] = useState('');
  const [exited, setExited] = useState(false);
  const [starting, setStarting] = useState(true);
  const [generation, setGeneration] = useState(0);
  const slot = terminalSlot(cwd, tab);
  useImperativeHandle(ref, () => ({ close: () => closeSession.current(), restart: () => setGeneration(value => value + 1) }), []);
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
    let queue = Promise.resolve();
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, monospace', theme: { background: '#0c1420', foreground: '#dce6f3' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current); fit.fit();
    terminalRef.current = { terminal, fit };
    setError(''); setExited(false); setStarting(true);
    let requestToken = token;
    const postPath = async <T,>(path: string, body: object): Promise<T> => {
      const send = () => api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: requestToken }, body: JSON.stringify(body) });
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
    const input = terminal.onData(data => { if (closed) return; pending += data; if (!timer) timer = setTimeout(flush, 15); });
    const resize = terminal.onResize(({ cols, rows }) => { if (id) queue = queue.then(async () => { if (!disposed && !closed) await post('resize', { cols, rows }); }).catch(fail); });
    const observer = new ResizeObserver(() => { if (!disposed && host.current?.clientWidth && host.current.clientHeight) fit.fit(); }); observer.observe(host.current);
    const finish = () => { forgetWorkspaceTerminal(slot, id); closed = true; terminal.options.disableStdin = true; stream?.close(); setExited(true); };
    closeSession.current = async () => { if (!id || closed) { if (id) forgetWorkspaceTerminal(slot, id); return; } try { await post('close', {}); }
      catch (error) { if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) throw error; }
      finish(); };
    void workspaceTerminalSession(slot,
      saved => postPath(`/api/workspace/terminals/${encodeURIComponent(saved)}/resize`, { cols: terminal.cols, rows: terminal.rows }),
      async () => (await postPath<{ id: string }>('/api/workspace/terminals', { cwd, cols: terminal.cols, rows: terminal.rows })).id,
    ).then(result => {
      id = result;
      if (disposed) return;
      setStarting(false);
      stream = new EventSource(`/api/workspace/terminals/${encodeURIComponent(id)}/events`);
      stream.addEventListener('output', event => { terminal.write(JSON.parse((event as MessageEvent).data).data); });
      stream.addEventListener('exit', event => { const result = JSON.parse((event as MessageEvent).data); terminal.writeln(`\r\n${t('터미널 종료 (코드 {0})', { 0: result.exitCode })}`); finish(); });
      stream.onerror = () => { if (!disposed) setError(t('터미널 연결이 끊겼습니다. 다시 연결하는 중입니다.')); };
      stream.onopen = () => { void api<{ token: string }>('/api/bootstrap').then(fresh => { requestToken = fresh.token; if (!disposed) { setError(''); flush(); if (visible.current) terminal.focus(); } }).catch(fail); };
    }).catch(value => { closed = true; terminal.options.disableStdin = true; fail(value); if (!disposed) { setStarting(false); setExited(true); } });
    return () => { disposed = true; clearTimeout(timer); input.dispose(); resize.dispose(); observer.disconnect(); stream?.close(); terminal.dispose(); if (terminalRef.current?.terminal === terminal) terminalRef.current = undefined; };
  }, [cwd, slot, token, generation]);
  return <div className="workspace-terminal-panel" role="tabpanel" id={`workspace-terminal-panel-${tab.key}`} aria-labelledby={`workspace-terminal-tab-${tab.key}`} hidden={!active}>
    {error && <p role="alert" className="workspace-error">{translateMessage(error)}</p>}
    <div ref={host} className="workspace-terminal-screen" />
  </div>;
}
