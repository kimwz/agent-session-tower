import type { TodoLayout } from '../../../shared/todo/types';

/**
 * Where the page is, kept in the address so a reload or Back returns to it: `?view=todo` shows the Todo page,
 * `todo=` the list (`today`, `upcoming`, `inbox`, `p:<project>`, `l:<label>`, `search` with `q=`), `layout=` board or
 * calendar and `task=` the open task. The canvas keeps its own parameters (`session=`) meanwhile.
 */

export type TodoView = { kind: 'today' } | { kind: 'upcoming' } | { kind: 'inbox' } | { kind: 'project'; id: string } | { kind: 'label'; id: string } | { kind: 'search' };

export interface TodoLocation {
  view: TodoView;
  layout: TodoLayout;
  task: string | null;
  query: string;
}

const TODO_PARAMS = ['todo', 'layout', 'task', 'q'] as const;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isTodoPage = (search: string) => new URLSearchParams(search).get('view') === 'todo';

export function viewKey(view: TodoView): string {
  switch (view.kind) {
    case 'project': return `p:${view.id}`;
    case 'label': return `l:${view.id}`;
    default: return view.kind;
  }
}

/** The list a `todo=` value names; the Inbox when it names none (the page opens there). */
export function parseView(value: string | null): TodoView {
  if (value === 'inbox' || value === 'today' || value === 'upcoming' || value === 'search') return { kind: value };
  const match = /^([pl]):(.+)$/.exec(value ?? '');
  if (match && ID.test(match[2])) return match[1] === 'p' ? { kind: 'project', id: match[2] } : { kind: 'label', id: match[2] };
  return { kind: 'inbox' };
}

export function readTodoLocation(search: string): TodoLocation {
  const params = new URLSearchParams(search);
  const task = params.get('task');
  return {
    view: parseView(params.get('todo')),
    layout: params.get('layout') === 'calendar' ? 'calendar' : 'board',
    task: task && ID.test(task) ? task : null,
    query: (params.get('q') ?? '').slice(0, 200),
  };
}

/** The address search for `location`, keeping parameters that are not the Todo page's. */
export function todoSearch(search: string, location: TodoLocation): string {
  const params = new URLSearchParams(search);
  params.set('view', 'todo');
  for (const name of TODO_PARAMS) params.delete(name);
  params.set('todo', viewKey(location.view));
  if (location.layout === 'calendar') params.set('layout', 'calendar');
  if (location.task) params.set('task', location.task);
  if (location.view.kind === 'search' && location.query) params.set('q', location.query);
  return `?${params}`;
}

/**
 * Switching pages: the canvas address drops the Todo page's parameters, which come back from `remembered` (the last
 * Todo address) when switching to it again.
 */
export function pageSearch(search: string, page: 'canvas' | 'todo', remembered = ''): string {
  const params = new URLSearchParams(search);
  for (const name of TODO_PARAMS) params.delete(name);
  if (page === 'canvas') params.delete('view');
  else {
    params.set('view', 'todo');
    const previous = new URLSearchParams(remembered);
    for (const name of TODO_PARAMS) { const value = previous.get(name); if (value) params.set(name, value); }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
