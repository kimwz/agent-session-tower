import { SlidersHorizontal } from 'lucide-react';
import { translate as t } from '../i18n/i18n';
import { Popover, usePopover } from './Popover';
import { groupingsFor, type DisplaySettings, type GroupKey, type SortKey } from './todo-views';
import type { TodoView } from './todo-url';
import type { TodoLayout } from '../../../shared/todo/types';

const GROUP_LABELS: Record<GroupKey, string> = { section: '섹션', date: '날짜', priority: '우선순위', project: '프로젝트' };
const SORT_LABELS: Record<SortKey, string> = { manual: '기본', date: '날짜', priority: '우선순위', name: '이름' };

/** How a list lays out its cards, remembered per list. */
export function DisplayMenu({ view, layout, value, onChange, completedAvailable }: { view: TodoView; layout: TodoLayout; value: DisplaySettings; onChange: (value: DisplaySettings) => void; completedAvailable: boolean }) {
  const popover = usePopover();
  const groups = groupingsFor(view);
  return <>
    <button ref={popover.anchor} type="button" className={`todo-tool ${popover.open ? 'active' : ''}`} aria-expanded={popover.open} onClick={popover.toggle}><SlidersHorizontal size={14} /><span>{t('표시')}</span></button>
    {popover.open && <Popover anchor={popover.anchor} onClose={popover.close} label={t('표시')} className="todo-display" align="end">
      {layout === 'calendar' ? <>
        <div className="todo-display-row"><span>{t('색')}</span><div className="todo-segmented" role="radiogroup" aria-label={t('색')}>
          {(['priority', 'project'] as const).map(color => <button key={color} type="button" role="radio" aria-checked={value.colorBy === color} onClick={() => onChange({ ...value, colorBy: color })}>{t(GROUP_LABELS[color])}</button>)}
        </div></div>
        <label className="todo-display-row todo-check-row"><span>{t('반복 작업의 다음 일정 표시')}</span><input type="checkbox" className="settings-switch" checked={value.future} onChange={event => onChange({ ...value, future: event.target.checked })} /></label>
        {view.kind !== 'search' && <label className="todo-display-row todo-check-row"><span>{t('완료한 작업 표시')}</span><input type="checkbox" className="settings-switch" checked={value.done} onChange={event => onChange({ ...value, done: event.target.checked })} /></label>}
      </> : <>
      {groups.length > 1 && <div className="todo-display-row"><span>{t('그룹')}</span><div className="todo-segmented" role="radiogroup" aria-label={t('그룹')}>
        {groups.map(group => <button key={group} type="button" role="radio" aria-checked={value.group === group} onClick={() => onChange({ ...value, group })}>{t(GROUP_LABELS[group])}</button>)}
      </div></div>}
      <label className="todo-display-row"><span>{t('정렬 기준')}</span><select value={value.sort} onChange={event => onChange({ ...value, sort: event.target.value as SortKey })}>
        {(Object.keys(SORT_LABELS) as SortKey[]).map(sort => <option key={sort} value={sort}>{t(SORT_LABELS[sort])}</option>)}
      </select></label>
      {completedAvailable && <label className="todo-display-row todo-check-row"><span>{t('완료한 작업 표시')}</span><input type="checkbox" className="settings-switch" checked={value.completed} onChange={event => onChange({ ...value, completed: event.target.checked })} /></label>}
      </>}
    </Popover>}
  </>;
}

const DISPLAY_KEY = 'agent-session-tower.todo-display';

export function loadDisplay(key: string, fallback: DisplaySettings): DisplaySettings {
  try {
    const saved = (JSON.parse(window.localStorage.getItem(DISPLAY_KEY) ?? '{}') as Record<string, Partial<DisplaySettings>>)[key];
    return saved ? { ...fallback, ...saved } : fallback;
  } catch { return fallback; } // best-effort: unreadable or blocked storage shows the defaults.
}

export function saveDisplay(key: string, value: DisplaySettings): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(DISPLAY_KEY) ?? '{}') as Record<string, DisplaySettings>;
    all[key] = value;
    window.localStorage.setItem(DISPLAY_KEY, JSON.stringify(all));
  } catch { /* best-effort: without storage the choice lasts until the page reloads. */ }
}
