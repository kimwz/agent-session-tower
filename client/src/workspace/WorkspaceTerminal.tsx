import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { Maximize2, Minimize2 } from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { terminalInputChunks } from './terminal-input';
import { workspaceTerminalSession, forgetWorkspaceTerminal } from './terminal-session';
import { api, ApiError } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';

export function WorkspaceTerminal({ cwd, token, maximized, onToggleMaximized }: { cwd: string; token: string; maximized: boolean; onToggleMaximized: () => void }) {
  useI18n();
  const host = useRef<HTMLDivElement>(null);
  const closeSession = useRef<() => Promise<void>>(async () => {});
  const [error, setError] = useState('');
  const [exited, setExited] = useState(false);
  const [starting, setStarting] = useState(true);
  const [generation, setGeneration] = useState(0);
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
    closeSession.current = async () => { if (!id) return; await post('close', {}); forgetWorkspaceTerminal(cwd, id); closed = true; terminal.options.disableStdin = true; stream?.close(); setExited(true); };
    void workspaceTerminalSession(cwd,
      saved => postPath(`/api/workspace/terminals/${encodeURIComponent(saved)}/resize`, { cols: terminal.cols, rows: terminal.rows }),
      async () => (await postPath<{ id: string }>('/api/workspace/terminals', { cwd, cols: terminal.cols, rows: terminal.rows })).id,
    ).then(result => {
      id = result;
      if (disposed) return;
      setStarting(false);
      stream = new EventSource(`/api/workspace/terminals/${encodeURIComponent(id)}/events`);
      stream.addEventListener('output', event => { terminal.write(JSON.parse((event as MessageEvent).data).data); });
      stream.addEventListener('exit', event => { const result = JSON.parse((event as MessageEvent).data); terminal.writeln(`\r\n${t('터미널 종료 (코드 {0})', { 0: result.exitCode })}`); forgetWorkspaceTerminal(cwd, id); closed = true; terminal.options.disableStdin = true; stream?.close(); setExited(true); });
      stream.onerror = () => { if (!disposed) setError(t('터미널 연결이 끊겼습니다. 다시 연결하는 중입니다.')); };
      stream.onopen = () => { void api<{ token: string }>('/api/bootstrap').then(fresh => { requestToken = fresh.token; if (!disposed) { setError(''); flush(); terminal.focus(); } }).catch(fail); };
    }).catch(value => { closed = true; terminal.options.disableStdin = true; fail(value); if (!disposed) { setStarting(false); setExited(true); } });
    return () => { disposed = true; clearTimeout(timer); input.dispose(); resize.dispose(); observer.disconnect(); stream?.close(); terminal.dispose(); };
  }, [cwd, token, generation]);
  return <section className="workspace-terminal"><div className="workspace-terminal-toolbar"><strong>{t('터미널')}</strong><span>{t('명령은 Tower 서버에서 실행됩니다')}</span><button aria-label={maximized ? t('터미널 최대화 해제') : t('터미널 최대화')} title={maximized ? t('터미널 최대화 해제') : t('터미널 최대화')} aria-pressed={maximized} onClick={onToggleMaximized}>{maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>{exited ? <button onClick={() => setGeneration(value => value + 1)}>{t('새 터미널')}</button> : <button disabled={starting} onClick={() => { void closeSession.current().catch(value => setError(value instanceof Error ? value.message : String(value))); }}>{starting ? t('터미널 시작 중…') : t('터미널 종료')}</button>}</div>{error && <p role="alert" className="workspace-error">{translateMessage(error)}</p>}<div ref={host} className="workspace-terminal-screen" /></section>;
}
