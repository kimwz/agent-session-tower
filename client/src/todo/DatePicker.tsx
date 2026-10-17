import { useState } from 'react';
import { Armchair, CalendarArrowUp, CalendarX, ChevronLeft, ChevronRight, Repeat, Sun, Sunrise } from 'lucide-react';
import { addDays, addMonths, dateParts, daysInMonth, formatDate, weekday } from '../../../shared/todo/dates';
import { anchoredRecurrence } from '../../../shared/todo/recurrence';
import type { TodoRecurrence } from '../../../shared/todo/types';
import { getLanguage, translate as t } from '../i18n/i18n';
import { durationLabel, longDate, monthDay, recurrenceLabel, weekdayName } from './todo-format';

/**
 * Picking a date: the usual few in one press, a month to pick from, and for a task's date its time, duration and
 * repeat. The same picker sets a task's date, its deadline (`deadline`: a date only) and Quick Add's date.
 */

export interface DateValue { dueDate: string | null; dueTime: string | null; durationMin: number | null; recurrence: TodoRecurrence | null }

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

export function quickDates(today: string): { key: string; label: string; date: string | null; icon: typeof Sun }[] {
  const saturday = [0, 6].includes(weekday(today)) ? today : addDays(today, 6 - weekday(today));
  const monday = addDays(today, ((8 - weekday(today)) % 7) || 7);
  return [
    { key: 'today', label: t('오늘'), date: today, icon: Sun },
    { key: 'tomorrow', label: t('내일'), date: addDays(today, 1), icon: Sunrise },
    { key: 'weekend', label: t('이번 주말'), date: saturday, icon: Armchair },
    { key: 'next-week', label: t('다음 주'), date: monday, icon: CalendarArrowUp },
    { key: 'none', label: t('날짜 없음'), date: null, icon: CalendarX },
  ];
}

/** The repeat presets for a date: every day, workdays, that weekday, that day of the month, that day of the year. */
export function repeatPresets(date: string): { key: string; rule: TodoRecurrence }[] {
  const { month, day } = dateParts(date);
  return [
    { key: 'day', rule: { freq: 'day', interval: 1 } },
    { key: 'workdays', rule: { freq: 'day', interval: 1, workdays: true } },
    { key: 'week', rule: { freq: 'week', interval: 1, weekdays: [weekday(date)] } },
    { key: 'month', rule: { freq: 'month', interval: 1, monthDays: [day] } },
    { key: 'year', rule: { freq: 'year', interval: 1, yearDate: [month, day] } },
  ];
}

export function MonthGrid({ month, selected, today, onPick }: { month: string; selected: string | null; today: string; onPick: (date: string) => void }) {
  const { year, month: number } = dateParts(month);
  const first = formatDate(year, number, 1);
  // Weeks start on Monday.
  const lead = (weekday(first) + 6) % 7;
  const cells = Array.from({ length: Math.ceil((lead + daysInMonth(year, number)) / 7) * 7 }, (_, index) => addDays(first, index - lead));
  return <div className="todo-month" role="grid" aria-label={monthDay(first).replace(/ 1일$| 1$/, '')}>
    <div className="todo-month-week" role="row">{[1, 2, 3, 4, 5, 6, 0].map(day => <span key={day} role="columnheader">{weekdayName(day)}</span>)}</div>
    {Array.from({ length: cells.length / 7 }, (_, row) => <div key={row} className="todo-month-week" role="row">
      {cells.slice(row * 7, row * 7 + 7).map(date => <button key={date} type="button" role="gridcell" aria-selected={date === selected} aria-label={longDate(date)}
        className={`${dateParts(date).month !== number ? 'outside' : ''} ${date === today ? 'today' : ''} ${date < today ? 'past' : ''} ${date === selected ? 'selected' : ''}`}
        onClick={() => onPick(date)}>{dateParts(date).day}</button>)}
    </div>)}
  </div>;
}

export function DatePicker({ value, today, onChange, deadline = false }: { value: DateValue; today: string; onChange: (patch: Partial<DateValue>) => void; deadline?: boolean }) {
  const [month, setMonth] = useState(() => { const { year, month } = dateParts(value.dueDate ?? today); return formatDate(year, month, 1); });
  const [custom, setCustom] = useState(false);
  const pick = (date: string | null) => onChange(date ? { dueDate: date } : { dueDate: null, dueTime: null, recurrence: null });
  const { year, month: number } = dateParts(month);
  return <div className="todo-date-picker">
    <div className="todo-date-quick">
      {quickDates(today).map(choice => <button key={choice.key} type="button" className={choice.date === value.dueDate ? 'selected' : ''} onClick={() => pick(choice.date)}>
        <choice.icon size={15} /><span>{choice.label}</span><small>{choice.date ? weekdayName(weekday(choice.date)) + (choice.key === 'next-week' || choice.key === 'weekend' ? ` ${monthDay(choice.date)}` : '') : ''}</small>
      </button>)}
    </div>
    <div className="todo-month-head">
      <strong>{getLanguage() === 'en' ? `${monthDay(month).split(' ')[0]} ${year}` : `${year}년 ${number}월`}</strong>
      <button type="button" className="icon-button" aria-label={t('이전 달')} onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={15} /></button>
      <button type="button" className="icon-button" aria-label={t('다음 달')} onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={15} /></button>
    </div>
    <MonthGrid month={month} selected={value.dueDate} today={today} onPick={date => pick(date)} />
    {!deadline && value.dueDate && <div className="todo-date-extra">
      <label><span>{t('시간')}</span><input type="time" value={value.dueTime ?? ''} onChange={event => onChange({ dueTime: event.target.value || null })} /></label>
      <label><span>{t('소요 시간')}</span><select value={value.durationMin ?? ''} onChange={event => onChange({ durationMin: event.target.value ? Number(event.target.value) : null })}>
        <option value="">{t('없음')}</option>
        {[...new Set([...DURATIONS, ...(value.durationMin ? [value.durationMin] : [])])].sort((a, b) => a - b).map(minutes => <option key={minutes} value={minutes}>{durationLabel(minutes)}</option>)}
      </select></label>
      <label><span><Repeat size={12} />{t('반복')}</span><select value={custom ? 'custom' : presetKey(value)} onChange={event => {
        if (event.target.value === 'custom') { setCustom(true); if (!value.recurrence) onChange({ recurrence: { freq: 'week', interval: 1, weekdays: [weekday(value.dueDate!)] } }); return; }
        setCustom(false);
        onChange({ recurrence: event.target.value ? repeatPresets(value.dueDate!).find(item => item.key === event.target.value)!.rule : null });
      }}>
        <option value="">{t('반복 안 함')}</option>
        {repeatPresets(value.dueDate).map(item => <option key={item.key} value={item.key}>{recurrenceLabel(item.rule)}</option>)}
        {value.recurrence && presetKey(value) === 'custom' && <option value="custom-current" disabled>{recurrenceLabel(value.recurrence)}</option>}
        <option value="custom">{t('사용자 지정…')}</option>
      </select></label>
      {(custom || presetKey(value) === 'custom') && value.recurrence && <CustomRepeat rule={value.recurrence} date={value.dueDate} onChange={recurrence => onChange({ recurrence })} />}
    </div>}
  </div>;
}

type NthWeek = NonNullable<TodoRecurrence['nth']>['n'];
const ordinals = (): [NthWeek, string][] => [[1, t('첫째')], [2, t('둘째')], [3, t('셋째')], [4, t('넷째')], [5, t('다섯째')], [-1, t('마지막')]];
/** The nth weekday a date is: its weekday, and which one of the month (the last after the 28th). */
export function nthOf(date: string): { n: NthWeek; weekday: number } {
  const { day } = dateParts(date);
  return { n: day > 28 ? -1 : (Math.ceil(day / 7) as NthWeek), weekday: weekday(date) };
}

/** Which preset a value's rule is, '' for none and 'custom' for another rule. */
function presetKey(value: DateValue): string {
  if (!value.recurrence) return '';
  if (!value.dueDate) return 'custom';
  const rule = JSON.stringify(anchoredRecurrence(value.recurrence, value.dueDate));
  return repeatPresets(value.dueDate).find(item => JSON.stringify(anchoredRecurrence(item.rule, value.dueDate!)) === rule)?.key ?? 'custom';
}

function CustomRepeat({ rule, date, onChange }: { rule: TodoRecurrence; date: string; onChange: (rule: TodoRecurrence) => void }) {
  const set = (patch: Partial<TodoRecurrence>) => {
    const next: TodoRecurrence = { ...rule, ...patch };
    // Fields of another kind of rule, or that a rule counting from completion cannot have, go.
    if (next.freq !== 'week' || next.fromCompletion) delete next.weekdays;
    if (next.freq !== 'month' || next.fromCompletion) { delete next.monthDays; delete next.nth; }
    if (next.freq !== 'year' || next.fromCompletion) delete next.yearDate;
    if (next.freq !== 'day') delete next.workdays;
    if (!next.until) delete next.until;
    if (!next.fromCompletion) delete next.fromCompletion;
    for (const key of Object.keys(next) as (keyof TodoRecurrence)[]) if (next[key] === undefined) delete next[key];
    onChange(next);
  };
  const days = rule.weekdays ?? [weekday(date)];
  return <div className="todo-custom-repeat">
    <div className="todo-custom-row">
      <span>{t('매')}</span>
      <input type="number" min={1} max={999} value={rule.interval} aria-label={t('반복 간격')} onChange={event => set({ interval: Math.min(999, Math.max(1, Number(event.target.value) || 1)) })} />
      <select value={rule.freq} aria-label={t('단위')} onChange={event => set({ freq: event.target.value as TodoRecurrence['freq'] })}>
        <option value="day">{t('일')}</option><option value="week">{t('주')}</option><option value="month">{t('개월')}</option><option value="year">{t('년')}</option>
      </select>
    </div>
    {rule.freq === 'week' && !rule.fromCompletion && <div className="todo-weekday-toggles" role="group" aria-label={t('요일')}>
      {[1, 2, 3, 4, 5, 6, 0].map(day => <button key={day} type="button" aria-pressed={days.includes(day)} onClick={() => {
        const next = days.includes(day) ? days.filter(item => item !== day) : [...days, day];
        if (next.length) set({ weekdays: next.sort((a, b) => a - b) });
      }}>{weekdayName(day)}</button>)}
    </div>}
    {rule.freq === 'month' && !rule.fromCompletion && <div className="todo-custom-row">
      <select aria-label={t('반복 기준')} value={rule.nth ? 'nth' : 'day'} onChange={event => set(event.target.value === 'nth' ? { nth: nthOf(date), monthDays: undefined } : { monthDays: [dateParts(date).day], nth: undefined })}>
        <option value="day">{t('날짜 기준')}</option><option value="nth">{t('요일 기준')}</option>
      </select>
      {rule.nth ? <>
        <select aria-label={t('몇째 주')} value={rule.nth.n} onChange={event => set({ nth: { ...rule.nth!, n: Number(event.target.value) as NthWeek } })}>
          {ordinals().map(([n, label]) => <option key={n} value={n}>{label}</option>)}
        </select>
        <select aria-label={t('요일')} value={rule.nth.weekday} onChange={event => set({ nth: { ...rule.nth!, weekday: Number(event.target.value) } })}>
          {[1, 2, 3, 4, 5, 6, 0].map(day => <option key={day} value={day}>{weekdayName(day)}</option>)}
        </select>
      </> : <select aria-label={t('날짜')} value={rule.monthDays?.[0] ?? dateParts(date).day} onChange={event => set({ monthDays: [Number(event.target.value)] })}>
        {Array.from({ length: 31 }, (_, index) => index + 1).map(day => <option key={day} value={day}>{t('매월 {0}일', { 0: day })}</option>)}
        <option value={-1}>{t('말일')}</option>
      </select>}
    </div>}
    <label className="todo-check-row"><input type="checkbox" checked={!!rule.fromCompletion} onChange={event => set({ fromCompletion: event.target.checked })} /><span>{t('완료한 날부터 계산')}</span></label>
    <label className="todo-custom-row"><span>{t('종료일')}</span><input type="date" value={rule.until ?? ''} min={date} onChange={event => set({ until: event.target.value || undefined })} /></label>
  </div>;
}
