import { api, ApiError } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { translate as t } from '../i18n/i18n';
import type { Attachment, AttachmentInput } from '../../../shared/types';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, UPLOAD_CHUNK_BYTES, normalizeAttachmentMimeType, isImageAttachment } from '../../../shared/attachments';
import { localPart, nodeOf, nodePath, pathFor } from '../remote/scope';

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
  return [...current, ...files.map(file => ({ key: crypto.randomUUID(), name: file.name || t("첨부 파일"), mimeType: normalizeAttachmentMimeType(file.type, file.name), size: file.size, file }))];
}

export interface AttachmentUploadContext { kind: 'chat' | 'auto'; sessionId: string; token: string }
const uploads = new WeakMap<File, Map<string, { id: string; attachmentId?: string; chunkBytes?: number }>>();

export async function prepareDraftAttachments(files: readonly DraftAttachment[], context?: AttachmentUploadContext): Promise<{ attachments?: AttachmentInput[]; attachmentIds?: string[] }> {
  const attachments: AttachmentInput[] = [];
  const legacyCompatible = files.reduce((total, item) => total + (item.file?.size ?? item.size), 0) <= MAX_TOTAL_ATTACHMENT_BYTES
    && files.every(item => (item.file?.size ?? item.size) <= (isImageAttachment(item.mimeType) ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES));
  const attachmentIds: string[] = [];
  for (const item of files) {
    if (item.attachmentId) {
      if (context && nodeOf(item.attachmentId) !== nodeOf(context.sessionId)) throw new Error(t("{0}: 파일을 다시 첨부해 주세요.", { 0: item.name }));
      attachmentIds.push(localPart(item.attachmentId)); continue;
    }
    if (!item.file || !context) throw new Error(t("{0}: 파일을 다시 첨부해 주세요.", { 0: item.name }));
    const node = nodeOf(context.sessionId);
    const key = `${context.kind}:${context.sessionId}`;
    const known = uploads.get(item.file) ?? new Map<string, { id: string; attachmentId?: string; chunkBytes?: number }>();
    uploads.set(item.file, known);
    let upload = known.get(key);
    const headers = { [REQUEST_TOKEN_HEADER]: context.token };
    const endpoint = (suffix: string) => nodePath(node, `/api/attachment-uploads/${upload!.id}${suffix}`);
    if (!upload) {
      try {
        upload = await api<{ id: string }>(pathFor(context.sessionId, id => `/api/${context.kind === 'chat' ? 'sessions' : 'auto-prompts'}/${encodeURIComponent(id)}/attachment-uploads`), {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: item.name, mimeType: item.mimeType, size: item.file.size }),
        });
      } catch (error) {
        // Preserve bounded attachments while an active worker or joined computer waits for its update.
        if (!legacyCompatible || !(error instanceof ApiError) || !(error.status === 404 || (error.status === 503 && error.disposition === 'not-admitted'))) throw error;
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
        attachments.push({ name: item.name, mimeType: item.mimeType, data: btoa(chunks.join('')) });
        continue;
      }
      known.set(key, upload);
    }
    if (!upload.attachmentId) {
      let { offset } = await api<{ offset: number }>(endpoint(''));
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.file.size) throw new Error(t('업로드 위치가 올바르지 않습니다.'));
      while (offset < item.file.size) {
        const chunkBytes = upload.chunkBytes ?? UPLOAD_CHUNK_BYTES;
        const started = performance.now();
        let next: { offset: number };
        try {
          next = await api<{ offset: number }>(endpoint(`?offset=${offset}`), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: item.file.slice(offset, offset + chunkBytes) });
        } catch (error) {
          // A retry can make progress on an uplink too slow for a full chunk's request deadline.
          upload.chunkBytes = Math.max(64 * 1024, Math.floor(chunkBytes / 2));
          throw error;
        }
        const elapsed = performance.now() - started;
        if (elapsed > 20_000) upload.chunkBytes = Math.max(64 * 1024, Math.floor(chunkBytes * 20_000 / elapsed));
        if (!Number.isSafeInteger(next.offset) || next.offset <= offset || next.offset > item.file.size) throw new Error(t('업로드 위치가 올바르지 않습니다.'));
        offset = next.offset;
      }
      const completed = await api<{ attachment: Attachment }>(endpoint('/complete'), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
      upload.attachmentId = completed.attachment.id;
    }
    attachmentIds.push(upload.attachmentId);
  }
  return { ...(attachments.length ? { attachments } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) };
}

export const isPreviewableAttachment = (attachment: Pick<DraftAttachment, 'mimeType'>) => isImageAttachment(attachment.mimeType);
export const attachmentUrl = (id: string) => pathFor(id, local => `/api/attachments/${encodeURIComponent(local)}`);
