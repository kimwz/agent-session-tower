import { createContext, lazy, Suspense, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { workspaceMinimumWidth as minimumWidth, workspaceOverlayLayout } from './overlay-layout';
import { translate as t } from '../i18n/i18n';

const WorkspacePage = lazy(() => import('./WorkspacePage').then(module => ({ default: module.WorkspacePage })));
type Tool = 'editor' | 'terminal';
/** Opens a folder's workspace; `machine` names the joined computer a scoped folder belongs to. */
export const WorkspaceContext = createContext<((cwd: string, tool: Tool, machine?: string) => void) | null>(null);
export const useOpenWorkspace = () => useContext(WorkspaceContext);

export function WorkspaceOverlayProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<{ cwd: string; tool: Tool; machine?: string; request: number } | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem('agent-monitor.workspace-width')); return saved >= minimumWidth && Number.isFinite(saved) ? saved : 640; } catch { return 640; }
  });
  const [layout, setLayout] = useState({ viewport: window.innerWidth, chat: 0 });
  const guard = useRef<() => boolean>(() => true);
  const dragging = useRef<{ x: number; width: number } | null>(null);
  const registerGuard = useCallback((canLeave: () => boolean) => { guard.current = canLeave; }, []);
  const open = useCallback((cwd: string, tool: Tool, machine?: string) => {
    if (workspace && cwd !== workspace.cwd && !guard.current()) return;
    setWorkspace(previous => ({ cwd, tool, ...(machine ? { machine } : {}), request: (previous?.request || 0) + 1 }));
  }, [workspace]);
  const close = () => { if (guard.current()) { setWorkspace(null); guard.current = () => true; } };
  useLayoutEffect(() => {
    if (!workspace) return;
    let chat: Element | null = null;
    const measure = () => {
      const next = document.querySelector('.chat-panel');
      if (next !== chat) { if (chat) resize.unobserve(chat); chat = next; if (chat) resize.observe(chat); }
      const viewport = window.innerWidth;
      const chatWidth = chat ? (viewport <= 680 ? viewport : chat.getBoundingClientRect().width) : 0;
      setLayout(previous => previous.viewport === viewport && previous.chat === chatWidth ? previous : { viewport, chat: chatWidth });
    };
    const resize = new ResizeObserver(measure);
    const mutations = new MutationObserver(measure);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', measure); measure();
    return () => { resize.disconnect(); mutations.disconnect(); window.removeEventListener('resize', measure); };
  }, [!!workspace]);
  const { stacked, maxWidth, minWidth, width, right } = workspaceOverlayLayout(layout.viewport, layout.chat, preferredWidth);
  useLayoutEffect(() => {
    document.body.classList.toggle('workspace-overlay-stacked', !!workspace && stacked);
    return () => document.body.classList.remove('workspace-overlay-stacked');
  }, [!!workspace, stacked]);
  const changeWidth = (value: number) => {
    const next = Math.max(minimumWidth, Math.min(value, maxWidth)); setPreferredWidth(next);
    try { localStorage.setItem('agent-monitor.workspace-width', String(next)); } catch { /* Resizing works without storage. */ }
  };
  return <WorkspaceContext.Provider value={open}>{children}{workspace && <aside className={`workspace-overlay ${stacked ? 'is-stacked' : ''}`} aria-label={t('브라우저 작업 공간')} style={{ width, right }}>
    {!stacked && <div className="workspace-resize-handle" role="separator" tabIndex={0} aria-label={t('작업 공간 너비 조절')} aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={width}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); dragging.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (dragging.current) changeWidth(dragging.current.width + dragging.current.x - event.clientX); }}
      onPointerUp={event => { dragging.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragging.current = null; }} onLostPointerCapture={() => { dragging.current = null; }}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); changeWidth(width + (event.key === 'ArrowLeft' ? 20 : -20)); } }} />}
    <Suspense fallback={<div className="chat-loading">{t('브라우저 작업 공간')}<button onClick={close}>{t('닫기')}</button></div>}><WorkspacePage key={workspace.cwd} cwd={workspace.cwd} machine={workspace.machine} initialTool={workspace.tool} toolRequest={workspace.request} onClose={close} registerGuard={registerGuard} /></Suspense>
  </aside>}</WorkspaceContext.Provider>;
}
