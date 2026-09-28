import { memo, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { File as FileIcon, Paperclip, X } from 'lucide-react';
import type { Attachment } from '../../../shared/types';
import { isImageAttachment } from '../../../shared/attachments';
import { addDraftFiles, formatAttachmentSize, prepareDraftAttachments, type DraftAttachment } from '../chat/chat-attachments';
import { currentDraft, updateDraft, useMasterDraft } from './master-draft';
import { useWords } from './strings';
import './master-pictures.css';

const fileUrl = (id: string) => `/api/master/attachments/${encodeURIComponent(id)}`;

/** A file kept with an earlier message, taken into a new draft: it goes again by its id, without uploading it again. */
export const keptDraftFile = (attachment: Attachment): DraftAttachment => ({ key: `kept:${attachment.id}`, attachmentId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size });

/**
 * Files the owner adds to a message for the master: chosen, pasted or dropped, shown before sending, and sent with
 * the message. Pictures and PDFs are read by the model itself, short text files as their text; any other file is
 * kept on this computer for the master to hand to a session.
 */
export function useMasterFiles(onError: (message: string) => void, enabled: boolean) {
  const words = useWords();
  const { files } = useMasterDraft();
  const [dragging, setDragging] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);
  const add = (chosen: File[]) => {
    if (!chosen.length || !enabled) return;
    try { updateDraft({ files: addDraftFiles(currentDraft().files, chosen) }); onError(''); }
    catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  return {
    files,
    dragging,
    chooser,
    remove: (key: string) => updateDraft(draft => ({ files: draft.files.filter(item => item.key !== key) })),
    /** The files as the message carries them: new ones uploaded, kept ones by their id. */
    prepare: () => prepareDraftAttachments(files),
    onPaste: (event: ClipboardEvent) => {
      const pasted = Array.from(event.clipboardData.files);
      if (!pasted.length) return;
      // A clipboard can hold a picture and ordinary text; the text still pastes.
      if (!event.clipboardData.getData('text/plain')) event.preventDefault();
      add(pasted);
    },
    drop: {
      onDragOver: (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = enabled ? 'copy' : 'none'; if (enabled) setDragging(true); },
      onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
      onDrop: (event: DragEvent) => { if (event.dataTransfer.files.length) { event.preventDefault(); add(Array.from(event.dataTransfer.files)); } setDragging(false); },
    },
    input: <input ref={chooser} className="attachment-file-input" type="file" multiple aria-label={words('보낼 파일 선택', 'Choose files to send')} disabled={!enabled}
      onChange={event => { add(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ''; }} />,
  };
}
export type MasterFiles = ReturnType<typeof useMasterFiles>;

const DraftTile = memo(function DraftTile({ file, disabled, onRemove }: { file: DraftAttachment; disabled: boolean; onRemove(key: string): void }) {
  const words = useWords();
  const image = isImageAttachment(file.mimeType);
  const [preview, setPreview] = useState('');
  useEffect(() => {
    if (!file.file || !image) { setPreview(''); return; }
    const url = URL.createObjectURL(file.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file.file, image]);
  const source = preview || (image && file.attachmentId ? fileUrl(file.attachmentId) : '');
  return <li className={`attachment-tile ${image ? 'attachment-image' : ''}`}>
    <div className="attachment-local">
      {source ? <img className="attachment-thumbnail" src={source} alt={file.name} loading="lazy" /> : <span className="attachment-file-icon"><FileIcon size={21} aria-hidden="true" /></span>}
      <span className="attachment-info"><strong title={file.name}>{file.name}</strong><span>{formatAttachmentSize(file.size)}</span></span>
    </div>
    <button className="attachment-remove" type="button" aria-label={words(`${file.name} 첨부 빼기`, `Remove ${file.name}`)} disabled={disabled} onClick={() => onRemove(file.key)}><X size={13} aria-hidden="true" /></button>
  </li>;
});

/** The chosen files above the message box, and the hint while files are dragged over the panel. */
export function FileDrafts({ files, disabled }: { files: MasterFiles; disabled: boolean }) {
  const words = useWords();
  return <>
    {files.input}
    {files.dragging && <div className="master-drop-hint" aria-live="polite"><Paperclip size={16} />{words('파일을 놓아 첨부하기', 'Drop files to attach')}</div>}
    {!!files.files.length && <div className="master-pictures"><ul className="attachment-list draft-attachments" aria-label={words('보낼 파일', 'Files to send')}>
      {files.files.map(file => <DraftTile key={file.key} file={file} disabled={disabled} onRemove={files.remove} />)}
    </ul></div>}
  </>;
}

export function FileButton({ files, disabled }: { files: MasterFiles; disabled: boolean }) {
  const words = useWords();
  const label = words('파일·사진 첨부 (붙여넣기·끌어다 놓기도 됩니다)', 'Attach files or pictures (paste or drop works too)');
  return <button className="master-attach" type="button" onClick={() => files.chooser.current?.click()} disabled={disabled} title={label} aria-label={label}><Paperclip size={16} /></button>;
}

/** Files sent with a message, as the master kept them: pictures as thumbnails, other files to download. */
export function SentFiles({ attachments }: { attachments: Attachment[] }) {
  const words = useWords();
  const pictures = attachments.filter(item => isImageAttachment(item.mimeType));
  const others = attachments.filter(item => !isImageAttachment(item.mimeType));
  return <>
    {!!pictures.length && <div className="master-sent-pictures">{pictures.map(item => <a key={item.id} href={fileUrl(item.id)} target="_blank" rel="noreferrer" title={item.name}><img src={fileUrl(item.id)} alt={item.name} loading="lazy" /></a>)}</div>}
    {!!others.length && <div className="master-sent-files">{others.map(item => <a key={item.id} href={fileUrl(item.id)} download={item.name} title={words(`${item.name} 받기`, `Download ${item.name}`)}><FileIcon size={12} aria-hidden="true" /><span>{item.name}</span><small>{formatAttachmentSize(item.size)}</small></a>)}</div>}
  </>;
}
