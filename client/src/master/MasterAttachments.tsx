import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { ImagePlus } from 'lucide-react';
import type { Attachment } from '../../../shared/types';
import { IMAGE_ATTACHMENT_MIME_TYPES, isImageAttachment, normalizeAttachmentMimeType } from '../../../shared/attachments';
import { DraftAttachments } from '../chat/ChatAttachments';
import { addDraftFiles, prepareDraftAttachments, type DraftAttachment } from '../chat/chat-attachments';
import { useWords } from './strings';
import './master-pictures.css';

/**
 * Pictures the owner adds to a message for the master: chosen, pasted or dropped, shown before sending, and sent
 * with the message. The master reads pictures only, so other files are refused here already.
 */
export function useMasterPictures(onError: (message: string) => void, enabled: boolean) {
  const words = useWords();
  const [pictures, setPictures] = useState<DraftAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);
  const add = (files: File[]) => {
    if (!files.length || !enabled) return;
    if (files.some(file => !isImageAttachment(normalizeAttachmentMimeType(file.type, file.name)))) {
      onError(words('마스터에게는 사진(PNG, JPEG, GIF, WebP)만 보낼 수 있습니다.', 'The master takes pictures only (PNG, JPEG, GIF, WebP).'));
      return;
    }
    try { setPictures(current => addDraftFiles(current, files)); onError(''); }
    catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  return {
    pictures,
    dragging,
    chooser,
    remove: (key: string) => setPictures(current => current.filter(item => item.key !== key)),
    clear: () => setPictures([]),
    /** The pictures as the message carries them. */
    prepare: async () => (await prepareDraftAttachments(pictures)).attachments,
    onPaste: (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData.files);
      if (!files.length) return;
      // A clipboard can hold a picture and ordinary text; the text still pastes.
      if (!event.clipboardData.getData('text/plain')) event.preventDefault();
      add(files);
    },
    drop: {
      onDragOver: (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = enabled ? 'copy' : 'none'; if (enabled) setDragging(true); },
      onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
      onDrop: (event: DragEvent) => { if (event.dataTransfer.files.length) { event.preventDefault(); add(Array.from(event.dataTransfer.files)); } setDragging(false); },
    },
    input: <input ref={chooser} className="attachment-file-input" type="file" multiple accept={IMAGE_ATTACHMENT_MIME_TYPES.join(',')} aria-label={words('보낼 사진 선택', 'Choose pictures to send')} disabled={!enabled}
      onChange={event => { add(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ''; }} />,
  };
}
export type MasterPictures = ReturnType<typeof useMasterPictures>;

/** The chosen pictures above the message box, and the button that chooses more. */
export function PictureDrafts({ pictures, disabled }: { pictures: MasterPictures; disabled: boolean }) {
  const words = useWords();
  return <>
    {pictures.input}
    {pictures.dragging && <div className="master-drop-hint" aria-live="polite"><ImagePlus size={16} />{words('사진을 놓아 첨부하기', 'Drop pictures to attach')}</div>}
    {!!pictures.pictures.length && <div className="master-pictures"><DraftAttachments attachments={pictures.pictures} disabled={disabled} onRemove={pictures.remove} /></div>}
  </>;
}

export function PictureButton({ pictures, disabled }: { pictures: MasterPictures; disabled: boolean }) {
  const words = useWords();
  const label = words('사진 첨부 (붙여넣기·끌어다 놓기도 됩니다)', 'Attach pictures (paste or drop works too)');
  return <button className="master-attach" type="button" onClick={() => pictures.chooser.current?.click()} disabled={disabled} title={label} aria-label={label}><ImagePlus size={16} /></button>;
}

/** Pictures sent with a message, as the master kept them. */
export function SentPictures({ attachments }: { attachments: Attachment[] }) {
  return <div className="master-sent-pictures">{attachments.map(item => {
    const url = `/api/master/attachments/${encodeURIComponent(item.id)}`;
    return <a key={item.id} href={url} target="_blank" rel="noreferrer" title={item.name}><img src={url} alt={item.name} loading="lazy" /></a>;
  })}</div>;
}
