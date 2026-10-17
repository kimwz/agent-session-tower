import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Check, ChevronDown, Clock3, Flag, Hash, History, Link2, LoaderCircle, MessageSquare, MoreHorizontal, Paperclip, Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import type { TodoEvent, TodoFile, TodoPriority, TodoTask } from '../../../shared/todo/types';
import { relativeTime } from '../common/lib';
import { translate as t } from '../i18n/i18n';
import { DatePicker, type DateValue } from './DatePicker';
import { Menu, Popover, usePopover, type MenuItem } from './Popover';
import { CheckCircle } from './TaskCard';
import { TodoMarkdown } from './TodoMarkdown';
import { AttachButton, AttachmentList, UploadRows, useFileDrop } from './attachments/Attachments';
import { sizeLabel } from './attachments/upload';
import { useUploads, type TodoUploads } from './attachments/uploads';
import type { TodoActions } from './todo-actions';
import { colorOf, dateLabel, durationLabel, monthDay, priorityName, recurrenceLabel } from './todo-format';
import { byOrder, isOpen, visibleFiles, type TodoWorld } from './todo-model';
import { newId, type TodoClient } from './todo-store';
import { projectTree } from './todo-views';

/**
 * One task: its title and description, properties, sub-tasks, the tasks before and after it, comments and activity.
 * Properties are a list of rows (`DETAIL_PROPERTIES`), so a new property is one entry. Every edit is an operation
 * through the store, shown at once.
 */

export interface DetailContext { task: TodoTask; world: TodoWorld; today: string; client: TodoClient; actions: TodoActions; readOnly: boolean; uploads: TodoUploads }

export interface PropertyRow { key: string; label: string; icon: ReactNode; render: (context: DetailContext) => ReactNode }

const PRIORITIES: TodoPriority[] = [1, 2, 3, 4];

function DateProperty({ task, today, actions, deadline, readOnly }: DetailContext & { deadline?: boolean }) {
  const popover = usePopover();
  const value: DateValue = deadline ? { dueDate: task.deadlineDate, dueTime: null, durationMin: null, recurrence: null } : { dueDate: task.dueDate, dueTime: task.dueTime, durationMin: task.durationMin, recurrence: task.recurrence };
  const label = deadline
    ? task.deadlineDate ? monthDay(task.deadlineDate, today) : t('없음')
    : task.dueDate ? [dateLabel(task.dueDate, today), task.dueTime, task.recurrence && recurrenceLabel(task.recurrence)].filter(Boolean).join(' · ') : t('날짜 없음');
  const overdue = deadline ? !!task.deadlineDate && task.deadlineDate < today : !!task.dueDate && task.dueDate < today;
  return <>
    <button ref={popover.anchor} type="button" className={`todo-property-value ${overdue ? 'overdue' : ''} ${(deadline ? task.deadlineDate : task.dueDate) ? '' : 'empty'}`} disabled={readOnly} onClick={popover.toggle}>{label}</button>
    {popover.open && <Popover anchor={popover.anchor} onClose={popover.close} label={deadline ? t('마감일') : t('날짜')} className="todo-date-popover">
      <DatePicker value={value} today={today} deadline={deadline} onChange={patch => {
        if (deadline) { actions.update(task, { deadlineDate: patch.dueDate ?? null }); popover.close(); return; }
        actions.update(task, patch);
        if (patch.dueDate !== undefined && Object.keys(patch).length <= 3 && patch.dueTime === undefined && patch.recurrence === undefined) popover.close();
      }} />
    </Popover>}
  </>;
}

function ProjectProperty({ task, world, client, readOnly }: DetailContext) {
  const popover = usePopover();
  const project = world.projects.find(item => item.id === task.projectId);
  const section = world.sections.find(item => item.id === task.sectionId);
  const move = (projectId: string, sectionId: string | null) => client.apply([task.parentId ? { op: 'task.move', id: task.id, projectId, sectionId, parentId: null } : { op: 'task.move', id: task.id, projectId, sectionId }]);
  const items: (MenuItem | 'separator')[] = [];
  const inbox = world.projects.find(item => item.inbox);
  const flat = [...(inbox ? [{ project: inbox, depth: 0 }] : []), ...flatten(projectTree(world))];
  for (const { project: item, depth } of flat) {
    items.push({ key: item.id, label: <span style={{ paddingLeft: depth * 12 }}>{item.inbox ? t('관리함') : item.name}</span>, icon: <i className="todo-dot" style={{ background: colorOf(item.color) }} />, checked: item.id === task.projectId && !task.sectionId, run: () => { move(item.id, null); popover.close(); } });
    for (const sectionItem of world.sections.filter(entry => entry.projectId === item.id && !entry.archivedAt)) {
      items.push({ key: `${item.id}/${sectionItem.id}`, label: <span style={{ paddingLeft: depth * 12 + 18 }}>/ {sectionItem.name}</span>, checked: sectionItem.id === task.sectionId, run: () => { move(item.id, sectionItem.id); popover.close(); } });
    }
  }
  return <>
    <button ref={popover.anchor} type="button" className="todo-property-value" disabled={readOnly} onClick={popover.toggle}>
      <i className="todo-dot" style={{ background: colorOf(project?.color ?? 'charcoal') }} />{project?.inbox ? t('관리함') : project?.name}{section && <span className="todo-muted"> / {section.name}</span>}
    </button>
    {popover.open && <Menu anchor={popover.anchor} onClose={popover.close} label={t('프로젝트로 옮기기')} items={items} />}
  </>;
}

const flatten = (nodes: ReturnType<typeof projectTree>): { project: TodoWorld['projects'][number]; depth: number }[] => nodes.flatMap(node => [{ project: node.project, depth: node.depth }, ...flatten(node.children)]);

function PriorityProperty({ task, actions, readOnly }: DetailContext) {
  const popover = usePopover();
  return <>
    <button ref={popover.anchor} type="button" className={`todo-property-value priority p${task.priority}`} disabled={readOnly} onClick={popover.toggle}><Flag size={12} />{priorityName(task.priority)}</button>
    {popover.open && <Menu anchor={popover.anchor} onClose={popover.close} label={t('우선순위')} items={PRIORITIES.map(priority => ({ key: String(priority), label: priorityName(priority), hint: String(priority),
      icon: <Flag size={13} className={`p${priority}`} />, run: () => actions.priority(task, priority) }))} />}
  </>;
}

export function LabelPicker({ selected, world, onChange, anchor, onClose, onCreate }: { selected: string[]; world: TodoWorld; onChange: (ids: string[]) => void; anchor: React.RefObject<HTMLElement | null>; onClose: () => void; onCreate: (name: string) => string | undefined }) {
  const [name, setName] = useState('');
  const matches = world.labels.filter(label => label.name.toLocaleLowerCase().includes(name.trim().toLocaleLowerCase()));
  const exact = world.labels.some(label => label.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  const valid = /^[^\s#@%/]{1,60}$/.test(name.trim());
  return <Menu anchor={anchor} onClose={onClose} label={t('라벨')} header={<form className="todo-menu-search" onSubmit={event => {
    event.preventDefault();
    if (!valid || exact) return;
    const id = onCreate(name.trim());
    if (id) onChange([...selected, id]);
    setName('');
  }}><input autoFocus value={name} placeholder={t('라벨 검색 또는 만들기')} aria-label={t('라벨 검색 또는 만들기')} onChange={event => setName(event.target.value)} />
    {valid && !exact && <button type="submit" className="todo-menu-create"><Plus size={13} />{t('“{0}” 만들기', { 0: name.trim() })}</button>}
  </form>} items={matches.map(label => ({ key: label.id, label: `@${label.name}`, icon: <Tag size={13} style={{ color: colorOf(label.color) }} />, checked: selected.includes(label.id),
    run: () => onChange(selected.includes(label.id) ? selected.filter(id => id !== label.id) : [...selected, label.id]) }))} />;
}

function LabelsProperty({ task, world, client, readOnly }: DetailContext) {
  const popover = usePopover();
  return <>
    <button ref={popover.anchor} type="button" className={`todo-property-value ${task.labelIds.length ? '' : 'empty'}`} disabled={readOnly} onClick={popover.toggle}>
      {task.labelIds.length ? task.labelIds.map(id => world.labels.find(label => label.id === id)).filter(label => !!label).map(label => <span key={label!.id} className="todo-chip label" style={{ color: colorOf(label!.color) }}>@{label!.name}</span>) : t('없음')}
    </button>
    {popover.open && <LabelPicker anchor={popover.anchor} onClose={popover.close} world={world} selected={task.labelIds}
      onChange={labelIds => client.apply([{ op: 'task.update', id: task.id, patch: { labelIds } }])}
      onCreate={name => { const id = newId(); return client.apply([{ op: 'label.create', id, name }]) ? id : undefined; }} />}
  </>;
}

function DurationProperty({ task, actions, readOnly }: DetailContext) {
  return <select className="todo-property-value" value={task.durationMin ?? ''} disabled={readOnly} aria-label={t('소요 시간')} onChange={event => actions.update(task, { durationMin: event.target.value ? Number(event.target.value) : null })}>
    <option value="">{t('없음')}</option>
    {[...new Set([15, 30, 45, 60, 90, 120, 180, 240, 480, ...(task.durationMin ? [task.durationMin] : [])])].sort((a, b) => a - b).map(minutes => <option key={minutes} value={minutes}>{durationLabel(minutes)}</option>)}
  </select>;
}

export const DETAIL_PROPERTIES: PropertyRow[] = [
  { key: 'project', label: '프로젝트', icon: <Hash size={13} />, render: context => <ProjectProperty {...context} /> },
  { key: 'date', label: '날짜', icon: <CalendarDays size={13} />, render: context => <DateProperty {...context} /> },
  { key: 'deadline', label: '마감일', icon: <Flag size={13} />, render: context => <DateProperty {...context} deadline /> },
  { key: 'duration', label: '소요 시간', icon: <Clock3 size={13} />, render: context => <DurationProperty {...context} /> },
  { key: 'priority', label: '우선순위', icon: <Flag size={13} />, render: context => <PriorityProperty {...context} /> },
  { key: 'labels', label: '라벨', icon: <Tag size={13} />, render: context => <LabelsProperty {...context} /> },
];

function EditableTitle({ task, actions, readOnly }: { task: TodoTask; actions: TodoActions; readOnly: boolean }) {
  const [value, setValue] = useState(task.content);
  const cancelled = useRef(false);
  useEffect(() => setValue(task.content), [task.content]);
  const save = () => { if (cancelled.current) { cancelled.current = false; return; } const next = value.replace(/\s+/g, ' ').trim(); if (next && next !== task.content) actions.update(task, { content: next.slice(0, 500) }); else setValue(task.content); };
  return <textarea className="todo-detail-title" value={value} rows={1} maxLength={500} readOnly={readOnly} aria-label={t('작업 제목')}
    onChange={event => setValue(event.target.value)} onBlur={save}
    onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.stopPropagation(); cancelled.current = true; setValue(task.content); event.currentTarget.blur(); } }} />;
}

function Description({ task, client, readOnly }: { task: TodoTask; client: TodoClient; readOnly: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.description);
  // What is being saved: a refused save opens the editor again with it, instead of losing what was written.
  const saving = useRef<string | null>(null);
  const open = useRef(editing);
  open.current = editing;
  useEffect(() => { if (!editing && saving.current === null) setValue(task.description); }, [task.description, editing]);
  const save = () => {
    setEditing(false);
    if (value === task.description) return;
    const text = value.slice(0, 16_383);
    saving.current = text;
    void client.applyAndWait([{ op: 'task.update', id: task.id, patch: { description: text } }]).then(saved => {
      // A newer save, or the editor opened again, holds newer text that started from this one.
      const latest = saving.current === text;
      if (latest) saving.current = null;
      if (!saved && latest && !open.current) { setValue(text); setEditing(true); }
    });
  };
  if (editing) return <textarea className="todo-description-editor" autoFocus value={value} maxLength={16_383} aria-label={t('설명')} placeholder={t('설명 (Markdown)')}
    onChange={event => setValue(event.target.value)} onBlur={save}
    onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); } if (event.key === 'Escape') { event.stopPropagation(); setValue(task.description); setEditing(false); } }} />;
  return <div className={`todo-description ${task.description ? '' : 'empty'}`} role={readOnly ? undefined : 'button'} tabIndex={readOnly ? undefined : 0}
    onClick={event => { if (!readOnly && !(event.target as Element).closest('a')) setEditing(true); }} onKeyDown={event => { if (!readOnly && event.key === 'Enter') { event.preventDefault(); setEditing(true); } }}>
    {task.description ? <TodoMarkdown>{task.description}</TodoMarkdown> : <span>{t('설명 추가')}</span>}
  </div>;
}

function Subtasks({ task, world, actions, client, onOpen, readOnly }: DetailContext & { onOpen: (id: string) => void }) {
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => {
    const result: { task: TodoTask; depth: number }[] = [];
    const walk = (parent: string, depth: number) => {
      for (const child of Object.values(world.tasks).filter(item => item.parentId === parent && !item.deletedAt).sort(byOrder)) { result.push({ task: child, depth }); walk(child.id, depth + 1); }
    };
    walk(task.id, 0);
    return result;
  }, [world.tasks, task.id]);
  const open = rows.filter(row => isOpen(row.task)).length;
  const add = () => { const content = name.trim(); if (!content) return; client.apply([{ op: 'task.create', id: newId(), parentId: task.id, content: content.slice(0, 500) }]); setName(''); };
  return <section className="todo-detail-section">
    <h4>{t('하위 작업')}{rows.length > 0 && <span>{open}/{rows.length}</span>}</h4>
    {rows.length > 0 && <ul className="todo-subtask-list">{rows.map(({ task: child, depth }) => <li key={child.id} className={child.completedAt ? 'done' : ''} style={{ paddingLeft: depth * 20 }}>
      <CheckCircle task={child} size="small" onComplete={() => actions.complete(child)} onReopen={() => void actions.reopen(child)} />
      <button type="button" onClick={() => onOpen(child.id)}>{child.content}</button>
      {child.dueDate && <span className="todo-chip">{dateLabel(child.dueDate, client.today())}</span>}
    </li>)}</ul>}
    {!readOnly && !task.completedAt && (adding ? <form className="todo-inline-add" onSubmit={event => { event.preventDefault(); add(); }}>
      <input autoFocus value={name} maxLength={500} placeholder={t('하위 작업 이름')} aria-label={t('하위 작업 이름')} onChange={event => setName(event.target.value)}
        onBlur={() => { add(); setAdding(false); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setName(''); setAdding(false); } }} />
    </form> : <button type="button" className="todo-link-button" onClick={() => setAdding(true)}><Plus size={13} />{t('하위 작업 추가')}</button>)}
  </section>;
}

function LinkSearch({ task, client, anchor, onClose }: { task: TodoTask; client: TodoClient; anchor: React.RefObject<HTMLElement | null>; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TodoTask[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const text = query.trim();
    if (!text) { setResults([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      client.search(text).then(found => { if (live) { setResults(found.filter(item => item.id !== task.id)); setError(''); } })
        .catch(reason => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [query, client, task.id]);
  return <Popover anchor={anchor} onClose={onClose} label={t('기존 작업 연결')} className="todo-menu">
    <div className="todo-menu-search"><input autoFocus value={query} placeholder={t('다음에 할 작업 검색')} aria-label={t('다음에 할 작업 검색')} onChange={event => setQuery(event.target.value)} /></div>
    {error && <p className="todo-error" role="alert">{error}</p>}
    <div role="menu">{results.map(item => <button key={item.id} type="button" role="menuitem" onClick={() => { client.apply([{ op: 'link.create', id: newId(), fromTaskId: task.id, toTaskId: item.id }]); onClose(); }}>
      <ArrowRight size={13} /><span>{item.content}</span>
    </button>)}</div>
    {query.trim() && !results.length && !error && <p className="todo-muted todo-menu-note">{t('찾은 작업이 없습니다')}</p>}
  </Popover>;
}

function Flow({ task, world, client, onOpen, onFollowUp, readOnly }: DetailContext & { onOpen: (id: string) => void; onFollowUp: (task: TodoTask, complete: boolean) => void }) {
  const detail = world.detail?.task.id === task.id ? world.detail : null;
  const link = usePopover();
  if (!detail) return null;
  const item = (entry: { link: { id: string }; task: TodoTask }, direction: 'previous' | 'next') => <li key={entry.link.id} className={entry.task.completedAt ? 'done' : ''}>
    {direction === 'previous' ? <ArrowLeft size={13} /> : <ArrowRight size={13} />}
    <button type="button" onClick={() => onOpen(entry.task.id)}>{entry.task.content}</button>
    {entry.task.completedAt && <Check size={12} className="todo-muted" />}
    {!readOnly && <button type="button" className="icon-button todo-unlink" aria-label={t('연결 해제')} onClick={() => client.apply([{ op: 'link.delete', id: entry.link.id }])}><X size={12} /></button>}
  </li>;
  return <section className="todo-detail-section todo-flow">
    <h4>{t('흐름')}</h4>
    {detail.previous.length > 0 && <div><span className="todo-flow-label">{t('이전')}</span><ul>{detail.previous.map(entry => item(entry, 'previous'))}</ul></div>}
    <div><span className="todo-flow-label">{t('다음')}</span>
      {detail.next.length > 0 && <ul>{detail.next.map(entry => item(entry, 'next'))}</ul>}
      {!readOnly && <div className="todo-flow-actions">
        <button type="button" className="todo-link-button" onClick={() => onFollowUp(task, false)}><Plus size={13} />{t('후속 작업 추가')}</button>
        <button ref={link.anchor} type="button" className="todo-link-button" onClick={link.toggle}><Link2 size={13} />{t('기존 작업 연결')}</button>
      </div>}
    </div>
    {link.open && <LinkSearch task={task} client={client} anchor={link.anchor} onClose={link.close} />}
  </section>;
}

function CommentEditor({ initial, onSave, onCancel }: { initial: string; onSave: (body: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const save = () => { const text = value.trim(); if (text && text !== initial) onSave(text.slice(0, 15_000)); else onCancel(); };
  return <form className="todo-comment-form" onSubmit={event => { event.preventDefault(); save(); }}>
    <textarea autoFocus value={value} rows={4} maxLength={15_000} aria-label={t('댓글 편집')} onChange={event => setValue(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); } if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }} />
    <div className="todo-comment-actions"><button type="button" className="todo-secondary" onClick={onCancel}>{t('취소')}</button><button type="submit" className="todo-primary">{t('저장')}</button></div>
  </form>;
}

function Comments({ task, world, client, readOnly, uploads }: DetailContext) {
  const [body, setBody] = useState('');
  const [pending, setPending] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const jobs = useUploads(uploads);
  const comments = world.detail?.task.id === task.id ? world.detail.comments : [];
  const files = visibleFiles(world.detail?.task.id === task.id ? world.detail.files : [], new Set(comments.map(comment => comment.id)));
  const add = (picked: File[]) => setPending(previous => [...previous, ...picked]);
  const drop = useFileDrop(add, readOnly);
  // A comment's files are uploaded once the comment is saved: the server attaches them to a comment that exists.
  const send = async () => {
    const text = body.trim() || pending.map(file => file.name).join(', ');
    if (!text || sending) return;
    const id = newId(), attach = pending, sent = body;
    setSending(true);
    // The draft stays until the server has the comment, so a refused one can be sent again; once saved, only what was
    // sent goes, and what was written or picked meanwhile stays.
    const saved = await client.applyAndWait([{ op: 'comment.create', id, taskId: task.id, body: text.slice(0, 15_000) }]);
    setSending(false);
    if (!saved) return;
    setBody(current => current === sent ? '' : current);
    setPending(current => current.filter(file => !attach.includes(file)));
    if (attach.length) uploads.add(attach, { taskId: task.id, commentId: id });
  };
  return <section className="todo-detail-section">
    <h4><MessageSquare size={13} />{t('댓글')}{comments.length > 0 && <span>{comments.length}</span>}</h4>
    {comments.length > 0 && <ul className="todo-comments">{comments.map(comment => <li key={comment.id}>
      <div className="todo-comment-meta"><time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>{relativeTime(comment.createdAt)}{comment.updatedAt !== comment.createdAt && ` · ${t('고침')}`}</time>
        <span className="todo-spacer" />
        {!readOnly && editing !== comment.id && <button type="button" className="icon-button" aria-label={t('댓글 편집')} onClick={() => setEditing(comment.id)}><Pencil size={12} /></button>}
        {!readOnly && <button type="button" className="icon-button" aria-label={t('댓글 삭제')} onClick={() => { if (client.apply([{ op: 'comment.delete', id: comment.id }])) client.toast(t('댓글을 지웠습니다.'), 'info', client.undoActions()); }}><Trash2 size={12} /></button>}
      </div>
      {editing === comment.id
        ? <CommentEditor initial={comment.body} onCancel={() => setEditing(null)} onSave={text => { client.apply([{ op: 'comment.update', id: comment.id, body: text }]); setEditing(null); }} />
        : <TodoMarkdown>{comment.body}</TodoMarkdown>}
      <AttachmentList files={files.filter(file => file.commentId === comment.id)} onDelete={readOnly ? undefined : file => removeFile(client, file)} />
      <UploadRows jobs={jobs.filter(job => job.commentId === comment.id)} onCancel={key => uploads.cancel(key)} onRetry={key => uploads.retry(key)} />
    </li>)}</ul>}
    {!readOnly && <form className={`todo-comment-form ${drop.over ? 'drop-target' : ''}`} onSubmit={event => { event.preventDefault(); void send(); }} {...drop.handlers}>
      <textarea value={body} rows={body.includes('\n') ? 4 : 2} maxLength={15_000} placeholder={t('댓글 (Markdown)')} aria-label={t('댓글')} onChange={event => setBody(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
      {pending.length > 0 && <ul className="todo-pending-files">{pending.map((file, index) => <li key={`${file.name}-${index}`}>
        <Paperclip size={12} /><span>{file.name}</span><small>{sizeLabel(file.size)}</small>
        <button type="button" className="icon-button" aria-label={t('“{0}” 빼기', { 0: file.name })} onClick={() => setPending(previous => previous.filter((_, position) => position !== index))}><X size={12} /></button>
      </li>)}</ul>}
      <div className="todo-comment-actions">
        <AttachButton onFiles={add} />
        <span className="todo-spacer" />
        {(body.trim() || pending.length > 0) && <button type="submit" className="todo-primary" disabled={sending}>{t('댓글 달기')}</button>}
      </div>
    </form>}
  </section>;
}

/** Deleting a file can be undone from its toast (file.restore). */
function removeFile(client: TodoClient, file: TodoFile) {
  if (client.apply([{ op: 'file.delete', id: file.id }])) client.toast(t('“{0}” 삭제', { 0: file.name }), 'info', client.undoActions());
}

/** The description's attachments: listed under it, added with the button, by dropping files on the description or pasting them. */
function DescriptionFiles({ task, world, client, readOnly, uploads }: DetailContext) {
  const jobs = useUploads(uploads).filter(job => job.taskId === task.id && job.commentId === null);
  const files = (world.detail?.task.id === task.id ? world.detail.files : []).filter(file => file.commentId === null && !file.deletedAt);
  return <div className="todo-description-files">
    <AttachmentList files={files} onDelete={readOnly ? undefined : file => removeFile(client, file)} />
    <UploadRows jobs={jobs} onCancel={key => uploads.cancel(key)} onRetry={key => uploads.retry(key)} />
    {!readOnly && <AttachButton onFiles={picked => uploads.add(picked, { taskId: task.id })} />}
  </div>;
}

const EVENT_LABELS: Record<TodoEvent['kind'], string> = {
  created: '만들었습니다', updated: '고쳤습니다', moved: '옮겼습니다', completed: '완료했습니다', uncompleted: '완료를 취소했습니다', deleted: '지웠습니다', restored: '되살렸습니다',
  linked: '연결했습니다', unlinked: '연결을 해제했습니다', commented: '댓글을 달았습니다', attached: '파일을 첨부했습니다',
};

function Activity({ task, world }: DetailContext) {
  const [open, setOpen] = useState(false);
  const events = world.detail?.task.id === task.id ? world.detail.events : [];
  if (!events.length) return null;
  return <section className="todo-detail-section">
    <button type="button" className="todo-section-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><History size={13} />{t('활동')}<span>{events.length}</span><ChevronDown size={12} /></button>
    {open && <ul className="todo-activity">{events.map(event => <li key={event.id}><span>{t(EVENT_LABELS[event.kind])}</span><time dateTime={event.at} title={new Date(event.at).toLocaleString()}>{relativeTime(event.at)}</time></li>)}</ul>}
  </section>;
}

export function CompleteButton({ task, actions, onFollowUp, readOnly }: { task: TodoTask; actions: TodoActions; onFollowUp: (task: TodoTask, complete: boolean) => void; readOnly: boolean }) {
  const menu = usePopover();
  if (task.completedAt) return <button type="button" className="todo-split-main" disabled={readOnly} onClick={() => void actions.reopen(task)}>{t('완료 취소')}</button>;
  return <div className="todo-split">
    <button type="button" className="todo-split-main" disabled={readOnly} onClick={() => actions.complete(task)} title={`${t('완료')} (E)`}><Check size={14} />{t('완료')}</button>
    <button ref={menu.anchor} type="button" className="todo-split-more" disabled={readOnly} aria-label={t('완료 방법')} aria-expanded={menu.open} onClick={menu.toggle}><ChevronDown size={14} /></button>
    {menu.open && <Menu anchor={menu.anchor} onClose={menu.close} label={t('완료 방법')} align="end" items={[
      { key: 'complete', label: t('완료'), hint: 'E', icon: <Check size={13} />, run: () => actions.complete(task) },
      { key: 'complete-next', label: t('완료 및 후속작업'), hint: '⇧E', icon: <ArrowRight size={13} />, run: () => onFollowUp(task, true) },
    ]} />}
  </div>;
}

export interface TaskDetailProps {
  taskId: string;
  world: TodoWorld;
  error: string;
  today: string;
  client: TodoClient;
  actions: TodoActions;
  readOnly: boolean;
  uploads: TodoUploads;
  onClose: () => void;
  onOpen: (id: string) => void;
  onProject: (projectId: string) => void;
  onFollowUp: (task: TodoTask, complete: boolean) => void;
}

export function TaskDetail({ taskId, world, error, today, client, actions, readOnly, uploads, onClose, onOpen, onProject, onFollowUp }: TaskDetailProps) {
  const task = world.tasks[taskId] ?? (world.detail?.task.id === taskId ? world.detail.task : undefined);
  const more = usePopover();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, [taskId]);
  const project = task && world.projects.find(item => item.id === task.projectId);
  const parent = task?.parentId ? world.tasks[task.parentId] : undefined;
  const context: DetailContext | undefined = task && { task, world, today, client, actions, readOnly, uploads };
  const drop = useFileDrop(files => task && uploads.add(files, { taskId: task.id }), readOnly || !task);
  return <aside ref={panel} className="todo-detail" aria-label={task ? task.content : t('작업')} tabIndex={-1}>
    <header className="todo-detail-bar">
      <button type="button" className="icon-button todo-detail-back" aria-label={t('닫기')} onClick={onClose}><ArrowLeft size={17} /></button>
      {project && <button type="button" className="todo-breadcrumb" onClick={() => onProject(project.id)}><i className="todo-dot" style={{ background: colorOf(project.color) }} />{project.inbox ? t('관리함') : project.name}</button>}
      {parent && <><span className="todo-muted">/</span><button type="button" className="todo-breadcrumb" onClick={() => onOpen(parent.id)}>{parent.content}</button></>}
      <span className="todo-spacer" />
      {task && <CompleteButton task={task} actions={actions} onFollowUp={onFollowUp} readOnly={readOnly} />}
      {task && !readOnly && <button ref={more.anchor} type="button" className="icon-button" aria-label={t('작업 메뉴')} onClick={more.toggle}><MoreHorizontal size={16} /></button>}
      <button type="button" className="icon-button todo-detail-close" aria-label={t('닫기')} title={`${t('닫기')} (Esc)`} onClick={onClose}><X size={17} /></button>
      {more.open && task && <Menu anchor={more.anchor} onClose={more.close} label={t('작업 메뉴')} align="end" items={[
        { key: 'next', label: t('후속 작업 추가'), hint: 'N', icon: <ArrowRight size={13} />, run: () => onFollowUp(task, false) },
        'separator',
        { key: 'delete', label: t('삭제'), danger: true, icon: <Trash2 size={13} />, run: () => { actions.remove(task); onClose(); } },
      ]} />}
    </header>
    {!task || !context ? <div className="todo-detail-empty">{error ? <p className="todo-error" role="alert">{error}</p> : <LoaderCircle className="spin" size={18} />}</div> : <div key={task.id} className="todo-detail-body">
      {/* One column on a narrow panel; on a wide one the properties stand on the right (todo.css). */}
      <div className="todo-detail-heading">
        <CheckCircle task={task} onComplete={() => actions.complete(task)} onCompleteNext={() => onFollowUp(task, true)} onReopen={() => void actions.reopen(task)} />
        <EditableTitle key={task.id} task={task} actions={actions} readOnly={readOnly} />
      </div>
      <div className={`todo-description-area ${drop.over ? 'drop-target' : ''}`} {...drop.handlers}>
        <Description key={`d-${task.id}`} task={task} client={client} readOnly={readOnly} />
        <DescriptionFiles {...context} />
      </div>
      <dl className="todo-properties">
        {DETAIL_PROPERTIES.map(row => <div key={row.key} className="todo-property"><dt>{row.icon}{t(row.label)}</dt><dd>{row.render(context)}</dd></div>)}
      </dl>
      <Subtasks {...context} onOpen={onOpen} />
      <Flow {...context} onOpen={onOpen} onFollowUp={onFollowUp} />
      <Comments {...context} />
      <Activity {...context} />
      {error && <p className="todo-error" role="alert">{error}</p>}
    </div>}
  </aside>;
}
