import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ArrowRight, CalendarDays, Check, Columns3, ChevronLeft, ChevronRight, Flag, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, TriangleAlert, X } from 'lucide-react';
import { addDays } from '../../../shared/todo/dates';
import type { TodoTask } from '../../../shared/todo/types';
import { useMediaQuery } from '../common/use-media-query';
import { translate as t, useI18n } from '../i18n/i18n';
import { BoardView } from './BoardView';
import { DisplayMenu, loadDisplay, saveDisplay } from './DisplayMenu';
import { Menu, Popover, type MenuItem } from './Popover';
import { QuickAdd, type QuickAddPreset } from './QuickAdd';
import { TaskCard } from './TaskCard';
import { TaskDetail } from './TaskDetail';
import { TodoSidebar } from './TodoSidebar';
import { createActions, type FollowUp } from './todo-actions';
import { longDate, priorityName } from './todo-format';
import { readShortcut, typingIn } from './todo-shortcuts';
import { httpTransport, localToday, newId, TodoClient, useTodoState } from './todo-store';
import { isTodoPage, readTodoLocation, todoSearch, viewKey, type TodoLocation, type TodoView } from './todo-url';
import { boardColumns, calendarTasks, sectionMoveTarget, cardContext, defaultDisplay, dropOps, manualOrder, projectOf, sidebarCounts, viewTitle, type BoardColumn, type DisplaySettings } from './todo-views';
import { CalendarView } from './calendar/CalendarView';
import type { TodoLayout } from '../../../shared/todo/types';

/**
 * The Todo page, shown in place of the canvas (`?view=todo`). It owns its store for as long as it is shown, reads the
 * address for the list and task to show, and keeps its keys to itself while shown.
 */

export interface TodoPageProps {
  token: string;
  /** The snapshot's todo revision. */
  revision: number | undefined;
  sidebarOpen: boolean;
  /** The sidebar covers the page (a phone) instead of standing beside it. */
  drawer: boolean;
  onSidebarOpen: (open: boolean) => void;
}

function SectionRename({ anchor, name, onSave, onClose }: { anchor: RefObject<HTMLElement | null>; name: string; onSave: (name: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const save = (event: FormEvent) => { event.preventDefault(); if (value.trim() && value.trim() !== name) onSave(value.trim()); onClose(); };
  return <Popover anchor={anchor} onClose={onClose} label={t('섹션 이름')} className="todo-menu"><form className="todo-menu-search" onSubmit={save}>
    <input autoFocus value={value} maxLength={120} aria-label={t('섹션 이름')} onChange={event => setValue(event.target.value)} />
  </form></Popover>;
}

export function TodoPage({ token, revision, sidebarOpen, drawer, onSidebarOpen }: TodoPageProps) {
  useI18n();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [client] = useState(() => new TodoClient(httpTransport(() => tokenRef.current)));
  const state = useTodoState(client);
  const { world } = state;
  const mobile = useMediaQuery('(max-width: 680px)');
  const [today, setToday] = useState(localToday);
  const [location, setLocation] = useState<TodoLocation>(() => readTodoLocation(window.location.search));
  const locationRef = useRef(location);
  const [start, setStart] = useState(today);
  const [displays, setDisplays] = useState<Record<string, DisplaySettings>>({});
  const [searchResults, setSearchResults] = useState<TodoTask[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quick, setQuick] = useState<{ preset: QuickAddPreset; follow: FollowUp | null } | null>(null);
  const [cardMenu, setCardMenu] = useState<{ task: TodoTask; anchor: HTMLElement } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<string | null>(null);
  // Renaming opens after the menu closes, so the menu's closing never undoes it.
  const [sectionRename, setSectionRename] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const chord = useRef(false);
  const { view, task: openTaskId, query } = location;
  const key = viewKey(view);
  const display = displays[key] ?? loadDisplay(key, defaultDisplay(view));
  const readOnly = world.availability.state !== 'ready';

  useEffect(() => { client.start(); return () => client.dispose(); }, [client]);
  useEffect(() => { client.noticeRevision(revision); }, [client, revision]);
  // The local date moves at midnight while the page stays open.
  useEffect(() => { const timer = window.setInterval(() => setToday(localToday()), 60_000); return () => window.clearInterval(timer); }, []);

  const navigate = useCallback((patch: Partial<TodoLocation>, replace = false) => {
    const next = { ...locationRef.current, ...patch };
    locationRef.current = next;
    const url = `${window.location.pathname}${todoSearch(window.location.search, next)}${window.location.hash}`;
    if (replace) window.history.replaceState({}, '', url); else window.history.pushState({}, '', url);
    setLocation(next);
  }, []);
  useEffect(() => {
    const onPop = () => { if (!isTodoPage(window.location.search)) return; const next = readTodoLocation(window.location.search); locationRef.current = next; setLocation(next); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // The address names the list even when it was opened without one.
  useEffect(() => { navigate({}, true); }, [navigate]);
  useEffect(() => { client.openDetail(openTaskId); }, [client, openTaskId]);
  useEffect(() => { setStart(today); setSelectedId(null); }, [key, today]);

  const openTask = useCallback((id: string) => navigate({ task: id }), [navigate]);
  const closeTask = useCallback(() => navigate({ task: null }), [navigate]);
  const goTo = useCallback((next: TodoView, text?: string) => {
    // A project opens in the layout it was last shown in.
    const shown = next.kind === 'project' || next.kind === 'inbox' ? projectOf(client.getState().world, next)?.layout : undefined;
    navigate({ view: next, task: null, query: text ?? '', ...(shown ? { layout: shown } : {}) });
    if (drawer) onSidebarOpen(false);
  }, [navigate, drawer, onSidebarOpen, client]);
  const actions = useMemo(() => createActions(client, { openTask }), [client, openTask]);

  useEffect(() => {
    if (view.kind !== 'search' || !query) { setSearchResults(null); return; }
    let live = true;
    client.search(query).then(found => { if (live) setSearchResults(found); }).catch(error => { if (live) { setSearchResults([]); client.toast(error instanceof Error ? error.message : String(error), 'error'); } });
    return () => { live = false; };
  }, [client, view.kind, query, world.revision]);

  const project = projectOf(world, view);
  const completedAvailable = view.kind !== 'upcoming' && view.kind !== 'search';
  const layout = location.layout;
  const setLayout = useCallback((next: TodoLayout) => {
    navigate({ layout: next });
    const shown = projectOf(client.getState().world, locationRef.current.view);
    // Remembered with the project, not as a change to undo.
    if (shown && shown.layout !== next && client.getState().world.availability.state === 'ready') client.apply([{ op: 'project.update', id: shown.id, patch: { layout: next } }], { undoable: false });
  }, [navigate, client]);
  const completedScope = display.completed && completedAvailable && layout === 'board' ? project?.id ?? '' : null;
  useEffect(() => { if (completedScope === null) client.hideCompleted(); else void client.readCompleted(completedScope); }, [client, completedScope]);

  const setDisplay = (value: DisplaySettings) => { setDisplays(previous => ({ ...previous, [key]: value })); saveDisplay(key, value); };
  const columns = useMemo(() => boardColumns(view, display, { world, today, start, query, searchResults }), [view, display, world, today, start, query, searchResults]);
  // A card names its project where the list is not one project and its column does not already.
  const showProject = !project && display.group !== 'project';
  const context = useMemo(() => cardContext(world, today, showProject), [world, today, showProject]);
  const counts = useMemo(() => sidebarCounts(world, today), [world, today]);

  const openAdd = useCallback((preset?: QuickAddPreset) => {
    if (readOnly) return;
    const base: QuickAddPreset = project ? { projectId: project.id } : view.kind === 'today' || view.kind === 'upcoming' ? { dueDate: today } : view.kind === 'label' ? { labelIds: [view.id] } : {};
    setQuick({ preset: { ...base, ...preset }, follow: null });
  }, [readOnly, project, view, today]);
  const followUp = useCallback((task: TodoTask, complete: boolean) => {
    if (readOnly || (complete && task.completedAt)) return;
    setQuick({ preset: { projectId: task.projectId, sectionId: task.sectionId }, follow: { taskId: task.id, complete } });
  }, [readOnly]);

  const target = (): TodoTask | undefined => (openTaskId ? world.tasks[openTaskId] : undefined) ?? (selectedId ? world.tasks[selectedId] : undefined);
  const shortcutState = useRef({ target, openAdd, followUp, actions, closeTask, goTo, openTaskId, quick, drawer, sidebarOpen, onSidebarOpen, client, openTask, layout, setLayout });
  shortcutState.current = { target, openAdd, followUp, actions, closeTask, goTo, openTaskId, quick, drawer, sidebarOpen, onSidebarOpen, client, openTask, layout, setLayout };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const current = shortcutState.current;
      if (event.defaultPrevented || current.quick || document.querySelector('.todo-popover, dialog[open], [aria-modal="true"], .workspace-overlay')) { chord.current = false; return; }
      if (typingIn(event.target instanceof Element ? event.target : null)) { chord.current = false; return; }
      const read = readShortcut(event, chord.current);
      chord.current = read.pending;
      const shortcut = read.shortcut;
      if (!shortcut) { if (read.pending) event.preventDefault(); return; }
      const task = current.target();
      const taskAction = ['complete', 'complete-next', 'add-next', 'priority', 'open'].includes(shortcut.action);
      if (taskAction && !task) return;
      switch (shortcut.action) {
        case 'add': current.openAdd(); break;
        case 'search':
          if (current.drawer) current.onSidebarOpen(true);
          else if (!current.sidebarOpen) current.onSidebarOpen(true);
          requestAnimationFrame(() => searchRef.current?.focus());
          break;
        case 'today': case 'upcoming': case 'inbox': current.goTo({ kind: shortcut.action }); break;
        case 'complete': if (task && !task.completedAt) current.actions.complete(task); break;
        case 'complete-next': if (task) current.followUp(task, true); break;
        case 'add-next': if (task) current.followUp(task, false); break;
        case 'priority': if (task) current.actions.priority(task, shortcut.priority); break;
        case 'open': if (task && !current.openTaskId) current.openTask(task.id); else return; break;
        case 'close':
          if (current.openTaskId) current.closeTask();
          else if (current.drawer && current.sidebarOpen) current.onSidebarOpen(false);
          else return;
          break;
        case 'undo': if (!current.client.undo()) return; break;
        case 'layout': current.setLayout(current.layout === 'board' ? 'calendar' : 'board'); break;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const card = {
    onOpen: openTask,
    onComplete: actions.complete,
    onCompleteNext: (task: TodoTask) => followUp(task, true),
    onReopen: (task: TodoTask) => void actions.reopen(task),
    onSelect: setSelectedId,
    onMenu: readOnly ? undefined : (task: TodoTask, anchor: HTMLElement) => { menuAnchor.current = anchor; setCardMenu({ task, anchor }); },
  };
  const onDrop = (task: TodoTask, column: BoardColumn, afterId: string | null | undefined) => {
    if (!column.drop) return;
    const ops = dropOps(task, column.drop, manualOrder(display) ? afterId : undefined);
    if (ops.length) client.apply(ops);
  };
  const cardMenuItems = (task: TodoTask): (MenuItem | 'separator')[] => [
    { key: 'complete-next', label: t('완료 및 후속작업'), hint: '⇧E', icon: <Check size={13} />, run: () => followUp(task, true) },
    { key: 'next', label: t('후속 작업 추가'), hint: 'N', icon: <ArrowRight size={13} />, run: () => followUp(task, false) },
    'separator',
    { key: 'today', label: t('오늘'), icon: <CalendarDays size={13} />, run: () => actions.date(task, today) },
    { key: 'tomorrow', label: t('내일'), icon: <CalendarDays size={13} />, run: () => actions.date(task, addDays(today, 1)) },
    { key: 'none', label: t('날짜 없음'), icon: <CalendarDays size={13} />, run: () => actions.date(task, null) },
    'separator',
    ...([1, 2, 3, 4] as const).map(priority => ({ key: `p${priority}`, label: priorityName(priority), hint: String(priority), icon: <Flag size={13} className={`p${priority}`} />, checked: undefined, run: () => actions.priority(task, priority) })),
    'separator',
    { key: 'delete', label: t('삭제'), danger: true, icon: <Trash2 size={13} />, run: () => actions.remove(task) },
  ];

  const completedColumn = display.completed && state.completed ? (() => {
    const items = state.completed.items.filter(({ completion, task }) => view.kind === 'label' ? task.labelIds.includes(view.id) : view.kind === 'today' ? localToday(new Date(completion.completedAt)) === today : true);
    return <section className="todo-column todo-completed-column" aria-label={t('완료됨')}>
      <header className="todo-column-head"><h3>{t('완료됨')}</h3><span className="todo-column-count">{items.length || ''}</span></header>
      <div className="todo-column-cards">
        {items.map(({ completion, task }) => <TaskCard key={completion.id} task={{ ...task, completedAt: task.completedAt ?? completion.completedAt }} context={context} {...card} onMenu={undefined}
          onReopen={() => void actions.reopen(task, completion.id)} />)}
        {state.completed.loading && <LoaderCircle className="spin todo-muted" size={16} />}
        {state.completed.error && <p className="todo-error" role="alert">{state.completed.error}</p>}
        {state.completed.before && !state.completed.loading && <button type="button" className="todo-add-card" onClick={() => void client.readCompleted(state.completed!.projectId, true)}>{t('더 보기')}</button>}
      </div>
    </section>;
  })() : undefined;

  const total = columns.reduce((sum, column) => sum + column.tasks.length, 0);
  const emptyBoard = total === 0 && !project && !completedColumn;
  const title = viewTitle(view, world, query);
  const section = world.sections.find(item => item.id === (sectionMenu ?? sectionRename));
  const siblings = section ? world.sections.filter(item => item.projectId === section.projectId && !item.archivedAt) : [];

  let body;
  if (state.phase === 'loading') body = <div className="todo-state"><LoaderCircle className="spin" size={20} /></div>;
  else if (state.phase === 'error') body = <div className="todo-state"><TriangleAlert size={20} /><p role="alert">{state.error}</p><button type="button" className="secondary-button" onClick={() => client.start()}><RefreshCw size={13} />{t('다시 시도')}</button></div>;
  else if (world.availability.state === 'unavailable') body = <div className="todo-state"><TriangleAlert size={20} /><h3>{t('할 일을 사용할 수 없습니다')}</h3><p>{world.availability.reason}</p></div>;
  else if ((view.kind === 'project' && !project) || (view.kind === 'label' && !world.labels.some(label => label.id === view.id))) body = <div className="todo-state"><p>{t('찾을 수 없는 목록입니다.')}</p><button type="button" className="secondary-button" onClick={() => goTo({ kind: 'today' })}>{t('오늘 보기')}</button></div>;
  else if (layout === 'calendar') body = <CalendarView tasks={calendarTasks(view, { world, today, start, query, searchResults })} world={world} today={today} mode={display.calendar} future={display.future} colorBy={display.colorBy}
    mobile={mobile} readOnly={readOnly} onMode={mode => setDisplay({ ...display, calendar: mode })} onOpen={openTask} onAdd={preset => openAdd({ ...(project ? { projectId: project.id } : {}), ...(view.kind === 'label' ? { labelIds: [view.id] } : {}), ...preset })}
    onChange={ops => client.apply(ops)} />;
  else if (emptyBoard) body = <div className="todo-state todo-empty"><p>{view.kind === 'today' ? t('오늘 할 일을 모두 끝냈습니다.') : view.kind === 'search' ? (searchResults === null ? t('검색어를 입력하세요.') : t('찾은 작업이 없습니다.')) : t('작업이 없습니다.')}</p>
    {view.kind !== 'search' && !readOnly && <button type="button" className="secondary-button" onClick={() => openAdd()}><Plus size={13} />{t('작업 추가')}</button>}</div>;
  else body = <BoardView columns={columns} context={context} manual={manualOrder(display) && !readOnly} sections={!!project && display.group === 'section' && !readOnly} mobile={mobile} selectedId={openTaskId ?? selectedId}
    card={card} onAdd={column => openAdd({ ...column.preset })} onDrop={onDrop}
    onSectionMove={(id, afterId) => client.apply([{ op: 'section.move', id, afterId }])}
    onAddSection={name => project && client.apply([{ op: 'section.create', id: newId(), projectId: project.id, name }])}
    onSectionMenu={(id, anchor) => { menuAnchor.current = anchor; setSectionRename(null); setSectionMenu(id); }} completed={completedColumn} />;

  return <div className={`todo-page ${sidebarOpen ? 'with-sidebar' : ''} ${drawer ? 'drawer' : ''} ${openTaskId ? 'with-detail' : ''}`}>
    {drawer && sidebarOpen && <button type="button" className="todo-scrim" aria-label={t('목록 닫기')} onClick={() => onSidebarOpen(false)} />}
    {sidebarOpen && state.phase === 'ready' && <TodoSidebar world={world} counts={counts} view={view} query={query} client={client} readOnly={readOnly} searchRef={searchRef} onNavigate={goTo} onAdd={() => { openAdd(); if (drawer) onSidebarOpen(false); }} />}
    <main className="todo-main" aria-label={title}>
      <header className="todo-main-head">
        <div className="todo-title"><h2>{title}</h2>{view.kind === 'today' && <span>{longDate(today)}</span>}</div>
        <div className="todo-tools">
          {state.phase === 'ready' && <div className="todo-segmented todo-layout-switch" role="radiogroup" aria-label={t('레이아웃')}>
            <button type="button" role="radio" aria-checked={layout === 'board'} title={`${t('보드')} (Shift+V)`} onClick={() => setLayout('board')}><Columns3 size={13} /><span>{t('보드')}</span></button>
            <button type="button" role="radio" aria-checked={layout === 'calendar'} title={`${t('캘린더')} (Shift+V)`} onClick={() => setLayout('calendar')}><CalendarDays size={13} /><span>{t('캘린더')}</span></button>
          </div>}
          {view.kind === 'upcoming' && layout === 'board' && <div className="todo-week-nav">
            <button type="button" className="icon-button" aria-label={t('이전 주')} disabled={start <= today} onClick={() => setStart(value => addDays(value, -7) < today ? today : addDays(value, -7))}><ChevronLeft size={15} /></button>
            <button type="button" className="todo-tool" disabled={start === today} onClick={() => setStart(today)}>{t('오늘')}</button>
            <button type="button" className="icon-button" aria-label={t('다음 주')} onClick={() => setStart(value => addDays(value, 7))}><ChevronRight size={15} /></button>
          </div>}
          {state.phase === 'ready' && <DisplayMenu view={view} layout={layout} value={display} onChange={setDisplay} completedAvailable={completedAvailable} />}
          {mobile && !readOnly && state.phase === 'ready' && <button type="button" className="todo-tool todo-add-mobile" aria-label={t('작업 추가')} onClick={() => openAdd()}><Plus size={16} /></button>}
        </div>
      </header>
      {world.availability.state === 'read-only' && <div className="todo-banner" role="status"><TriangleAlert size={13} />{t('읽기 전용')}: {world.availability.reason}</div>}
      {body}
    </main>
    {openTaskId && state.phase === 'ready' && <TaskDetail taskId={openTaskId} world={world} error={state.detailError} today={today} client={client} actions={actions} readOnly={readOnly}
      onClose={closeTask} onOpen={openTask} onProject={id => goTo(world.projects.find(item => item.id === id)?.inbox ? { kind: 'inbox' } : { kind: 'project', id })} onFollowUp={followUp} />}
    {quick && <QuickAdd world={world} today={today} client={client} preset={quick.preset} follow={quick.follow} onClose={() => setQuick(null)} onAdded={id => setSelectedId(id)} />}
    {cardMenu && <Menu anchor={menuAnchor} label={t('작업 메뉴')} items={cardMenuItems(cardMenu.task)} onClose={() => setCardMenu(null)} align="end" />}
    {sectionMenu && section && <Menu anchor={menuAnchor} label={t('섹션 메뉴')} onClose={() => setSectionMenu(null)} items={[
      { key: 'rename', label: t('이름 바꾸기'), icon: <Pencil size={13} />, run: () => setSectionRename(section.id) },
      ...(['left', 'right'] as const).flatMap(direction => { const afterId = sectionMoveTarget(siblings, section.id, direction); return afterId === undefined ? [] : [{
        key: direction, label: direction === 'left' ? t('왼쪽으로 옮기기') : t('오른쪽으로 옮기기'), icon: direction === 'left' ? <ChevronLeft size={13} /> : <ChevronRight size={13} />,
        run: () => client.apply([{ op: 'section.move', id: section.id, afterId }]) }]; }),
      { key: 'delete', label: t('섹션과 작업 삭제'), danger: true, icon: <Trash2 size={13} />, run: () => { if (client.apply([{ op: 'section.delete', id: section.id }])) client.toast(t('“{0}” 삭제', { 0: section.name }), 'info', [{ label: t('되돌리기'), run: () => client.undo() }]); } },
    ]} />}
    {sectionRename && !sectionMenu && section && <SectionRename anchor={menuAnchor} name={section.name} onClose={() => setSectionRename(null)} onSave={name => client.apply([{ op: 'section.update', id: section.id, patch: { name } }])} />}
    {state.toasts.length > 0 && <div className="todo-toasts" role="status" aria-live="polite">{state.toasts.map(toast => <div key={toast.id} className={`todo-toast ${toast.tone}`}>
      <span>{toast.message}</span>
      {toast.actions.map(action => <button key={action.label} type="button" onClick={() => { action.run(); client.dismiss(toast.id); }}>{action.label}</button>)}
      <button type="button" className="icon-button" aria-label={t('알림 닫기')} onClick={() => client.dismiss(toast.id)}><X size={13} /></button>
    </div>)}</div>}
  </div>;
}

export default TodoPage;
