import { useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { Download, FileText, Paperclip, RotateCcw, Trash2, TriangleAlert, X } from 'lucide-react';
import type { TodoFile } from '../../../../shared/todo/types';
import { translate as t } from '../../i18n/i18n';
import { isPreviewable, sizeLabel, type UploadJob } from './upload';

/** Attachments of a task's description or of a comment, the uploads going to it, and the ways to add files. */

export const fileUrl = (file: Pick<TodoFile, 'id'>, inline = false) => `/api/todos/files/${encodeURIComponent(file.id)}${inline ? '?inline=1' : ''}`;

export function AttachmentList({ files, onDelete }: { files: readonly TodoFile[]; onDelete?: (file: TodoFile) => void }) {
  if (!files.length) return null;
  const images = files.filter(isPreviewable), others = files.filter(file => !isPreviewable(file));
  return <div className="todo-files">
    {images.length > 0 && <ul className="todo-file-thumbs">{images.map(file => <li key={file.id}>
      <a href={fileUrl(file, true)} target="_blank" rel="noreferrer noopener" title={file.name}><img src={fileUrl(file, true)} alt={file.name} loading="lazy" /></a>
      <span className="todo-file-tools">
        <a className="icon-button" href={fileUrl(file)} download={file.name} aria-label={t('“{0}” 내려받기', { 0: file.name })}><Download size={13} /></a>
        {onDelete && <button type="button" className="icon-button" aria-label={t('“{0}” 삭제', { 0: file.name })} onClick={() => onDelete(file)}><Trash2 size={13} /></button>}
      </span>
    </li>)}</ul>}
    {others.length > 0 && <ul className="todo-file-rows">{others.map(file => <li key={file.id} className={file.missing ? 'missing' : ''}>
      {file.missing ? <TriangleAlert size={14} /> : <FileText size={14} />}
      {file.missing ? <span className="todo-file-name" title={file.name}>{file.name}</span>
        : <a className="todo-file-name" href={fileUrl(file)} download={file.name} title={file.name}>{file.name}</a>}
      <span className="todo-file-size">{file.missing ? t('백업에서 찾을 수 없음') : sizeLabel(file.size)}</span>
      {!file.missing && <a className="icon-button" href={fileUrl(file)} download={file.name} aria-label={t('“{0}” 내려받기', { 0: file.name })}><Download size={13} /></a>}
      {onDelete && <button type="button" className="icon-button" aria-label={t('“{0}” 삭제', { 0: file.name })} onClick={() => onDelete(file)}><Trash2 size={13} /></button>}
    </li>)}</ul>}
  </div>;
}

export function UploadRows({ jobs, onCancel, onRetry }: { jobs: readonly UploadJob[]; onCancel: (key: string) => void; onRetry: (key: string) => void }) {
  if (!jobs.length) return null;
  return <ul className="todo-uploads" aria-label={t('올리는 중')}>{jobs.map(job => {
    const percent = job.size ? Math.floor(job.offset / job.size * 100) : 100;
    return <li key={job.key} className={job.status}>
      <div className="todo-upload-line">
        <Paperclip size={13} /><span className="todo-file-name" title={job.name}>{job.name}</span>
        <span className="todo-file-size">{job.status === 'failed' ? t('실패') : job.status === 'waiting' ? t('대기 중') : `${percent}%`}</span>
        {job.status === 'failed' && <button type="button" className="icon-button" aria-label={t('“{0}” 다시 올리기', { 0: job.name })} onClick={() => onRetry(job.key)}><RotateCcw size={13} /></button>}
        <button type="button" className="icon-button" aria-label={t('“{0}” 올리기 취소', { 0: job.name })} onClick={() => onCancel(job.key)}><X size={13} /></button>
      </div>
      <progress max={100} value={percent} aria-label={job.name} />
      {job.error && <p className="todo-error" role="alert">{job.error}</p>}
    </li>;
  })}</ul>;
}

/** A button opening the file picker (a phone offers its camera, photos and files). */
export function AttachButton({ onFiles, disabled, children }: { onFiles: (files: File[]) => void; disabled?: boolean; children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <button type="button" className="todo-link-button" disabled={disabled} onClick={() => input.current?.click()}><Paperclip size={13} />{children ?? t('파일 첨부')}</button>
    <input ref={input} type="file" multiple hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) onFiles(files); }} />
  </>;
}

/** Files dropped on or pasted into an area. */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
  const [over, setOver] = useState(false);
  const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes('Files');
  return {
    over,
    handlers: disabled ? {} : {
      onDragOver: (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setOver(true); },
      onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); },
      onDrop: (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); setOver(false); const files = [...event.dataTransfer.files]; if (files.length) onFiles(files); },
      onPaste: (event: ClipboardEvent) => { const files = [...event.clipboardData.files]; if (!files.length) return; event.preventDefault(); onFiles(files); },
    },
  };
}
