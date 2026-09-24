import { translate as t } from '../i18n/i18n';
import type { Attachment, AttachmentInput } from '../../../shared/types';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, normalizeAttachmentMimeType, isImageAttachment } from '../../../shared/attachments';
import { localPart, pathFor } from '../remote/scope';

export interface DraftAttachment {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  file?: File;
  attachmentId?: string;
}

export function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

export function savedAttachmentDraft(attachment: Attachment): DraftAttachment {
  return { key: `saved:${attachment.id}`, attachmentId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size };
}

export function addDraftFiles(current: readonly DraftAttachment[], files: readonly File[]): DraftAttachment[] {
  if (current.length + files.length > MAX_ATTACHMENTS) throw new Error(t("파일은 최대 {0}개까지 첨부할 수 있습니다.", { 0: MAX_ATTACHMENTS }));
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(t("{0}: 파일 하나는 {1} 이하여야 합니다.", { 0: file.name, 1: formatAttachmentSize(MAX_ATTACHMENT_BYTES) }));
    if (isImageAttachment(normalizeAttachmentMimeType(file.type, file.name)) && file.size > MAX_IMAGE_ATTACHMENT_BYTES) throw new Error(t("{0}: 이미지는 {1} 이하여야 합니다.", { 0: file.name, 1: formatAttachmentSize(MAX_IMAGE_ATTACHMENT_BYTES) }));
  }
  if ([...current, ...files].reduce((total, file) => total + file.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(t("첨부 파일의 전체 크기는 {0} 이하여야 합니다.", { 0: formatAttachmentSize(MAX_TOTAL_ATTACHMENT_BYTES) }));
  }
  return [...current, ...files.map(file => ({ key: crypto.randomUUID(), name: file.name || t("첨부 파일"), mimeType: normalizeAttachmentMimeType(file.type, file.name), size: file.size, file }))];
}

export async function prepareDraftAttachments(files: readonly DraftAttachment[]): Promise<{ attachments?: AttachmentInput[]; attachmentIds?: string[] }> {
  const attachments: AttachmentInput[] = [];
  const attachmentIds: string[] = [];
  for (const item of files) {
    if (item.attachmentId) { attachmentIds.push(localPart(item.attachmentId)); continue; }
    if (!item.file) throw new Error(t("{0}: 파일을 다시 첨부해 주세요.", { 0: item.name }));
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    // Bound each conversion to avoid overflowing the argument stack for large files.
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    attachments.push({ name: item.name, mimeType: item.mimeType, data: btoa(chunks.join('')) });
  }
  return { ...(attachments.length ? { attachments } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) };
}

export const isPreviewableAttachment = (attachment: Pick<DraftAttachment, 'mimeType'>) => isImageAttachment(attachment.mimeType);
export const attachmentUrl = (id: string) => pathFor(id, local => `/api/attachments/${encodeURIComponent(local)}`);
