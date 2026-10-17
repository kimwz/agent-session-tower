import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CalendarDays, Flag, Hash, Tag, X } from 'lucide-react';
import { parseQuickAdd, type QuickAddKind, type QuickAddToken } from '../../../shared/todo/quick-add';
import type { TodoPriority, TodoRecurrence } from '../../../shared/todo/types';
import { translate as t } from '../i18n/i18n';
import { DatePicker, type DateValue } from './DatePicker';
import { Menu, Popover, usePopover, type MenuItem } from './Popover';
import { LabelPicker } from './TaskDetail';
import { createTaskOps, quickAddOps, type FollowUp } from './todo-actions';
import { colorOf, dateLabel, durationLabel, monthDay, priorityName, recurrenceLabel } from './todo-format';
import type { TodoWorld } from './todo-model';
import { newId, type TodoClient } from './todo-store';
import { projectTree } from './todo-views';

/**
 * Adding a task in one line. Recognized words are marked in the line and listed under it, where each can be turned
 * back into plain text; the chips set the same properties by hand (replacing the words). Opened to add the task that
 * comes after another, it adds the link too, and completes that task first for "complete and add the next" — all in
 * one request, and nothing at all when cancelled.
 */

export interface QuickAddPreset { projectId?: string; sectionId?: string | null; dueDate?: string; dueTime?: string; durationMin?: number; priority?: TodoPriority; labelIds?: string[]; parentId?: string }

interface Manual { date?: DateValue; priority?: TodoPriority; labelIds?: string[]; deadline?: string | null; place?: { projectId: string; sectionId: string | null } }

const KIND_LABELS: Record<QuickAddKind, string> = { project: '프로젝트', section: '섹션', label: '라벨', priority: '우선순위', deadline: '마감일', repeat: '반복', date: '날짜', time: '시간', duration: '소요 시간' };
const DATE_KINDS: QuickAddKind[] = ['date', 'time', 'repeat', 'duration'];

/** The text without the given tokens. */
const without = (text: string, tokens: QuickAddToken[]) => {
  let result = '', last = 0;
  for (const token of [...tokens].sort((a, b) => a.start - b.start)) { result += text.slice(last, token.start); last = token.end; }
  return (result + text.slice(last)).replace(/\s{2,}/g, ' ').trimStart();
};

export function QuickAdd({ world, today, client, preset, follow, onClose, onAdded }: {
  world: TodoWorld; today: string; client: TodoClient; preset: QuickAddPreset; follow: FollowUp | null; onClose: () => void; onAdded: (id: string) => void;
}) {
  const before = follow ? world.tasks[follow.taskId] : undefined;
  const [text, setText] = useState('');
  const [description, setDescription] = useState('');
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => new Set());
  const [manual, setManual] = useState<Manual>({});
  const input = useRef<HTMLInputElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const inbox = world.projects.find(project => project.inbox);
  const baseProject = preset.projectId ?? before?.projectId ?? inbox?.id ?? '';
  const projects = useMemo(() => world.projects.filter(project => !project.archivedAt).flatMap(project => project.inbox ? [{ id: project.id, name: t('관리함') }, { id: project.id, name: 'Inbox' }] : [{ id: project.id, name: project.name }]), [world.projects]);
  const parsed = useMemo(() => parseQuickAdd(text, { today, projects, sections: world.sections.filter(section => !section.archivedAt), labels: world.labels, defaultProjectId: manual.place?.projectId ?? baseProject, ignored }),
    [text, today, projects, world.sections, world.labels, manual.place, baseProject, ignored]);

  const projectId = manual.place?.projectId ?? parsed.projectId ?? baseProject;
  const sectionId = manual.place ? manual.place.sectionId : parsed.sectionId ?? (projectId === baseProject ? preset.sectionId ?? (before && !preset.projectId ? before.sectionId : null) ?? null : null);
  const parsedDate: DateValue = { dueDate: parsed.dueDate ?? null, dueTime: parsed.dueTime ?? null, durationMin: parsed.durationMin ?? null, recurrence: parsed.recurrence ?? null };
  // A calendar slot starts it at that day and time; typed words replace what they name.
  const presetDate: DateValue = { dueDate: preset.dueDate ?? null, dueTime: preset.dueDate ? preset.dueTime ?? null : null, durationMin: preset.durationMin ?? null, recurrence: null };
  const typedDate = parsed.tokens.some(token => token.kind === 'date' || token.kind === 'repeat');
  const date: DateValue = manual.date ?? {
    dueDate: typedDate ? parsedDate.dueDate : presetDate.dueDate ?? parsedDate.dueDate,
    dueTime: parsedDate.dueTime ?? (typedDate ? null : presetDate.dueTime),
    durationMin: parsedDate.durationMin ?? presetDate.durationMin,
    recurrence: parsedDate.recurrence,
  };
  const priority = manual.priority ?? parsed.priority ?? preset.priority ?? 4;
  const labelIds = [...new Set([...parsed.labelIds, ...(manual.labelIds ?? preset.labelIds ?? [])])];
  const deadline = manual.deadline !== undefined ? manual.deadline : parsed.deadlineDate ?? null;
  const content = parsed.content;

  const dropTokens = (kinds: QuickAddKind[]) => setText(value => without(value, parsed.tokens.filter(token => kinds.includes(token.kind))));
  const submit = () => {
    if (!content.trim()) { input.current?.focus(); return; }
    const draft = { content: content.slice(0, 500), description, result: {
      projectId, sectionId, labelIds, newLabels: parsed.newLabels, priority, dueDate: date.dueDate ?? undefined, dueTime: date.dueTime ?? undefined,
      durationMin: date.durationMin ?? undefined, recurrence: (date.recurrence ?? undefined) as TodoRecurrence | undefined, deadlineDate: deadline ?? undefined,
    } };
    const { ops, id } = preset.parentId ? createTaskOps(draft, { parentId: preset.parentId }) : quickAddOps(draft, follow, before, today);
    if (!client.apply(ops)) return;
    if (follow?.complete && before) client.toast(t('“{0}” 완료, 다음 작업 추가', { 0: before.content }), 'info', client.undoActions());
    onAdded(id);
    onClose();
  };

  const scrollSync = () => { if (backdrop.current && input.current) backdrop.current.scrollLeft = input.current.scrollLeft; };
  const segments: { text: string; kind?: QuickAddKind }[] = [];
  let last = 0;
  for (const token of parsed.tokens) { segments.push({ text: text.slice(last, token.start) }, { text: text.slice(token.start, token.end), kind: token.kind }); last = token.end; }
  segments.push({ text: text.slice(last) });

  return <div className="todo-modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="todo-quick-add" role="dialog" aria-modal="true" aria-label={follow ? t('다음 작업 추가') : t('작업 추가')}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && !document.querySelector('.todo-popover')) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      {before && <div className="todo-quick-follow"><ArrowRight size={13} /><span>{follow!.complete ? t('“{0}” 완료 후 다음 작업', { 0: before.content }) : t('“{0}” 다음 작업', { 0: before.content })}</span></div>}
      {preset.parentId && world.tasks[preset.parentId] && <div className="todo-quick-follow"><span>{t('“{0}”의 하위 작업', { 0: world.tasks[preset.parentId].content })}</span></div>}
      <div className="todo-quick-line">
        <div ref={backdrop} className="todo-quick-backdrop" aria-hidden="true">{segments.map((segment, index) => segment.kind ? <mark key={index} className={segment.kind}>{segment.text}</mark> : <span key={index}>{segment.text}</span>)}{'​'}</div>
        <input ref={input} value={text} maxLength={1000} placeholder={t('예: 견적 회신 내일 오후 3시 #프로젝트 p1')} aria-label={t('작업 이름')} spellCheck={false}
          onChange={event => setText(event.target.value)} onScroll={scrollSync} onSelect={scrollSync}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
      </div>
      <textarea className="todo-quick-description" value={description} rows={description ? 3 : 1} maxLength={16_383} placeholder={t('설명')} aria-label={t('설명')} onChange={event => setDescription(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} />
      {parsed.tokens.length > 0 && <div className="todo-quick-tokens" aria-label={t('인식한 단어')}>
        {parsed.tokens.map(token => <span key={`${token.key}-${token.start}`} className={`todo-token ${token.kind}`}>
          <small>{t(KIND_LABELS[token.kind])}</small>{token.text}
          <button type="button" aria-label={t('“{0}”을 글자로 두기', { 0: token.text })} title={t('글자로 두기')} onClick={() => { setIgnored(previous => new Set([...previous, token.key])); input.current?.focus(); }}><X size={11} /></button>
        </span>)}
      </div>}
      <div className="todo-quick-chips">
        <DateChip value={date} today={today} onChange={patch => { dropTokens(DATE_KINDS); setManual(previous => ({ ...previous, date: { ...date, ...patch } })); }} />
        <PriorityChip value={priority} onChange={value => { dropTokens(['priority']); setManual(previous => ({ ...previous, priority: value })); }} />
        <LabelChip world={world} selected={labelIds} client={client} onChange={ids => { setText(value => without(value, parsed.tokens.filter(token => token.kind === 'label' && unpicked(world, token.text, ids)))); setManual(previous => ({ ...previous, labelIds: ids })); }} />
        <DeadlineChip value={deadline} today={today} onChange={value => { dropTokens(['deadline']); setManual(previous => ({ ...previous, deadline: value })); }} />
        {!preset.parentId && <ProjectChip world={world} projectId={projectId} sectionId={sectionId} onChange={place => { dropTokens(['project', 'section']); setManual(previous => ({ ...previous, place })); }} />}
      </div>
      <footer className="todo-quick-footer">
        <span className="todo-muted todo-quick-hint">{t('Enter 추가 · Esc 취소')}</span>
        <button type="button" className="todo-secondary" onClick={onClose}>{t('취소')}</button>
        <button type="button" className="todo-primary" disabled={!content.trim()} onClick={submit}>{follow?.complete ? t('완료하고 추가') : t('작업 추가')}</button>
      </footer>
    </div>
  </div>;
}

/** A typed `@label` of an existing label the chip has unticked; a new label's word stays to be created. */
const unpicked = (world: TodoWorld, word: string, ids: string[]) => {
  const label = world.labels.find(item => item.name.toLocaleLowerCase() === word.slice(1).toLocaleLowerCase());
  return !!label && !ids.includes(label.id);
};

function DateChip({ value, today, onChange }: { value: DateValue; today: string; onChange: (patch: Partial<DateValue>) => void }) {
  const popover = usePopover();
  const label = value.dueDate ? [dateLabel(value.dueDate, today), value.dueTime, value.durationMin && durationLabel(value.durationMin), value.recurrence && recurrenceLabel(value.recurrence)].filter(Boolean).join(' · ') : t('날짜');
  return <>
    <button ref={popover.anchor} type="button" className={`todo-quick-chip ${value.dueDate ? 'set' : ''}`} onClick={popover.toggle}><CalendarDays size={13} />{label}</button>
    {popover.open && <Popover anchor={popover.anchor} onClose={popover.close} label={t('날짜')} className="todo-date-popover"><DatePicker value={value} today={today} onChange={onChange} /></Popover>}
  </>;
}

function DeadlineChip({ value, today, onChange }: { value: string | null; today: string; onChange: (value: string | null) => void }) {
  const popover = usePopover();
  return <>
    <button ref={popover.anchor} type="button" className={`todo-quick-chip ${value ? 'set' : ''}`} onClick={popover.toggle}><Flag size={13} />{value ? t('마감 {0}', { 0: monthDay(value, today) }) : t('마감일')}</button>
    {popover.open && <Popover anchor={popover.anchor} onClose={popover.close} label={t('마감일')} className="todo-date-popover">
      <DatePicker deadline value={{ dueDate: value, dueTime: null, durationMin: null, recurrence: null }} today={today} onChange={patch => { onChange(patch.dueDate ?? null); popover.close(); }} />
    </Popover>}
  </>;
}

function PriorityChip({ value, onChange }: { value: TodoPriority; onChange: (value: TodoPriority) => void }) {
  const popover = usePopover();
  return <>
    <button ref={popover.anchor} type="button" className={`todo-quick-chip ${value !== 4 ? `set p${value}` : ''}`} onClick={popover.toggle}><Flag size={13} />{value === 4 ? t('우선순위') : `P${value}`}</button>
    {popover.open && <Menu anchor={popover.anchor} onClose={popover.close} label={t('우선순위')} items={([1, 2, 3, 4] as const).map(priority => ({ key: String(priority), label: priorityName(priority), icon: <Flag size={13} className={`p${priority}`} />, run: () => onChange(priority) }))} />}
  </>;
}

function LabelChip({ world, selected, client, onChange }: { world: TodoWorld; selected: string[]; client: TodoClient; onChange: (ids: string[]) => void }) {
  const popover = usePopover();
  const names = selected.map(id => world.labels.find(label => label.id === id)?.name).filter(Boolean);
  return <>
    <button ref={popover.anchor} type="button" className={`todo-quick-chip ${names.length ? 'set' : ''}`} onClick={popover.toggle}><Tag size={13} />{names.length ? names.map(name => `@${name}`).join(' ') : t('라벨')}</button>
    {popover.open && <LabelPicker anchor={popover.anchor} onClose={popover.close} world={world} selected={selected} onChange={onChange}
      onCreate={name => { const id = newId(); return client.apply([{ op: 'label.create', id, name }]) ? id : undefined; }} />}
  </>;
}

function ProjectChip({ world, projectId, sectionId, onChange }: { world: TodoWorld; projectId: string; sectionId: string | null; onChange: (place: { projectId: string; sectionId: string | null }) => void }) {
  const popover = usePopover();
  const project = world.projects.find(item => item.id === projectId);
  const section = world.sections.find(item => item.id === sectionId);
  const items: MenuItem[] = [];
  const inbox = world.projects.find(item => item.inbox);
  const walk = (nodes: ReturnType<typeof projectTree>) => nodes.forEach(node => { add(node.project, node.depth); walk(node.children); });
  const add = (item: TodoWorld['projects'][number], depth: number) => {
    items.push({ key: item.id, label: <span style={{ paddingLeft: depth * 12 }}>{item.inbox ? t('관리함') : item.name}</span>, icon: <Hash size={13} style={{ color: colorOf(item.color) }} />, run: () => onChange({ projectId: item.id, sectionId: null }) });
    for (const entry of world.sections.filter(candidate => candidate.projectId === item.id && !candidate.archivedAt)) items.push({ key: `${item.id}/${entry.id}`, label: <span style={{ paddingLeft: depth * 12 + 18 }}>/ {entry.name}</span>, run: () => onChange({ projectId: item.id, sectionId: entry.id }) });
  };
  if (inbox) add(inbox, 0);
  walk(projectTree(world));
  return <>
    <button ref={popover.anchor} type="button" className="todo-quick-chip set" onClick={popover.toggle}><Hash size={13} style={{ color: colorOf(project?.color ?? 'charcoal') }} />{project?.inbox ? t('관리함') : project?.name}{section && ` / ${section.name}`}</button>
    {popover.open && <Menu anchor={popover.anchor} onClose={popover.close} label={t('프로젝트')} items={items} />}
  </>;
}
