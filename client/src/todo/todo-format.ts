import { dateParts, daysBetween, weekday } from '../../../shared/todo/dates';
import type { TodoPriority, TodoRecurrence } from '../../../shared/todo/types';
import { getLanguage, translate as t } from '../i18n/i18n';

/** How todo values read on the page, in the page's language. */

const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const weekdayName = (day: number) => getLanguage() === 'en' ? WEEKDAYS_EN[day] : WEEKDAYS_KO[day];

/** `10월 20일` / `Oct 20`, with the year when it is not this year's. */
export function monthDay(date: string, today?: string): string {
  const { year, month, day } = dateParts(date);
  const withYear = today !== undefined && dateParts(today).year !== year;
  if (getLanguage() === 'en') return `${MONTHS_EN[month - 1]} ${day}${withYear ? `, ${year}` : ''}`;
  return `${withYear ? `${year}년 ` : ''}${month}월 ${day}일`;
}

/** 오늘, 내일, 어제, a weekday within the next week, or the date. */
export function dateLabel(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return t('오늘');
  if (days === 1) return t('내일');
  if (days === -1) return t('어제');
  if (days > 1 && days < 7) return getLanguage() === 'en' ? WEEKDAYS_EN[weekday(date)] : `${WEEKDAYS_KO[weekday(date)]}요일`;
  return monthDay(date, today);
}

/** `10월 16일 목` / `Thu Oct 16`. */
export function longDate(date: string): string {
  const { month, day } = dateParts(date);
  return getLanguage() === 'en' ? `${WEEKDAYS_EN[weekday(date)]} ${MONTHS_EN[month - 1]} ${day}` : `${month}월 ${day}일 ${WEEKDAYS_KO[weekday(date)]}`;
}

export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (getLanguage() === 'en') return [hours ? `${hours}h` : '', rest ? `${rest}m` : ''].filter(Boolean).join(' ');
  return [hours ? `${hours}시간` : '', rest ? `${rest}분` : ''].filter(Boolean).join(' ');
}

const ORDINAL_KO: Record<number, string> = { 1: '첫째', 2: '둘째', 3: '셋째', 4: '넷째', 5: '다섯째', [-1]: '마지막' };
const ORDINAL_EN: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', [-1]: 'last' };

export function recurrenceLabel(rule: TodoRecurrence): string {
  const en = getLanguage() === 'en';
  const every = rule.interval > 1;
  let text: string;
  switch (rule.freq) {
    case 'day':
      text = rule.workdays ? (every ? t('{0}평일마다', { 0: rule.interval }) : t('평일')) : every ? t('{0}일마다', { 0: rule.interval }) : t('매일');
      break;
    case 'week': {
      const days = rule.weekdays?.length ? rule.weekdays.map(weekdayName).join(', ') : '';
      text = every ? t('{0}주마다', { 0: rule.interval }) : t('매주');
      if (days) text += ` ${days}`;
      break;
    }
    case 'month': {
      text = every ? t('{0}개월마다', { 0: rule.interval }) : t('매월');
      if (rule.nth) text += en ? ` ${ORDINAL_EN[rule.nth.n]} ${WEEKDAYS_EN[rule.nth.weekday]}` : ` ${ORDINAL_KO[rule.nth.n]} ${WEEKDAYS_KO[rule.nth.weekday]}요일`;
      else if (rule.monthDays?.length) text += ` ${rule.monthDays.map(day => day === -1 ? t('말일') : en ? ordinal(day) : `${day}일`).join(', ')}`;
      break;
    }
    case 'year':
      text = every ? t('{0}년마다', { 0: rule.interval }) : t('매년');
      if (rule.yearDate) text += ` ${en ? `${MONTHS_EN[rule.yearDate[0] - 1]} ${rule.yearDate[1]}` : `${rule.yearDate[0]}월 ${rule.yearDate[1]}일`}`;
      break;
  }
  if (rule.fromCompletion) text = t('완료 후 {0}', { 0: text });
  if (rule.until) text += ` · ${t('{0}까지', { 0: monthDay(rule.until) })}`;
  return text;
}
const ordinal = (day: number) => `${day}${day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'}`;

export const priorityName = (priority: TodoPriority) => priority === 4 ? t('우선순위 없음') : t('우선순위 {0}', { 0: priority });

/** Project and label colors: names the server keeps, shades for the dark page. */
export const TODO_COLORS: Record<string, string> = {
  'berry-red': '#d9708f', red: '#e57373', orange: '#e9a06a', yellow: '#e2c46b', olive: '#b5b867', lime: '#9fcf6c', green: '#78c38c', mint: '#71cdb2',
  teal: '#6cbcc4', sky: '#73b9e6', 'light-blue': '#93b6ef', blue: '#7f9cf2', grape: '#a98be3', violet: '#c28be0', lavender: '#b9a8e6', magenta: '#de84c4',
  salmon: '#e79a8c', charcoal: '#8a96a8', grey: '#a3adbb', taupe: '#b8a48f',
};
export const colorOf = (name: string) => TODO_COLORS[name] ?? TODO_COLORS.charcoal;
