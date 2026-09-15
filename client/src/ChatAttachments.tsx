import { memo, useEffect, useState } from 'react';
import { Download, File, X } from 'lucide-react';
import type { Attachment } from '../../shared/types';
import { attachmentUrl, formatAttachmentSize, isPreviewableAttachment, savedAttachmentDraft, type DraftAttachment } from './chat-attachments';

const AttachmentTile = memo(function AttachmentTile({ attachment, onRemove, disabled }: { attachment: DraftAttachment; onRemove?: (key: string) => void; disabled?: boolean }) {
  const [preview, setPreview] = useState('');
  const image = isPreviewableAttachment(attachment);
  useEffect(() => {
    if (!attachment.file || !image) { setPreview(''); return; }
    const url = URL.createObjectURL(attachment.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.file, image]);
  const url = attachment.attachmentId ? attachmentUrl(attachment.attachmentId) : undefined;
  const contents = <>{image && (preview || url) ? <img className="attachment-thumbnail" src={preview || url} alt={attachment.name} loading="lazy" /> : <span className="attachment-file-icon"><File size={21} aria-hidden="true" /></span>}<span className="attachment-info"><strong title={attachment.name}>{attachment.name}</strong><span>{formatAttachmentSize(attachment.size)}</span></span></>;
  return <li className={`attachment-tile ${image ? 'attachment-image' : ''}`}>
    {url ? <a className="attachment-download" href={url} download={attachment.name} title={`${attachment.name} 다운로드`}>{contents}<Download size={13} aria-hidden="true" /></a> : <div className="attachment-local">{contents}</div>}
    {onRemove && <button className="attachment-remove" type="button" aria-label={`${attachment.name} 첨부 제거`} disabled={disabled} onClick={() => onRemove(attachment.key)}><X size={13} aria-hidden="true" /></button>}
  </li>;
});

export function DraftAttachments({ attachments, onRemove, disabled }: { attachments: readonly DraftAttachment[]; onRemove: (key: string) => void; disabled: boolean }) {
  return <ul className="attachment-list draft-attachments" aria-label="첨부할 파일">{attachments.map(attachment => <AttachmentTile key={attachment.key} attachment={attachment} onRemove={onRemove} disabled={disabled} />)}</ul>;
}

export const SavedAttachments = memo(function SavedAttachments({ attachments }: { attachments: readonly Attachment[] }) {
  return <ul className="attachment-list saved-attachments" aria-label="보낸 첨부 파일">{attachments.map(attachment => <AttachmentTile key={attachment.id} attachment={savedAttachmentDraft(attachment)} />)}</ul>;
});
