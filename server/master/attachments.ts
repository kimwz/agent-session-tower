import type { ServerResponse } from 'node:http';
import type { Attachment } from '../../shared/types.js';
import { isImageAttachment, normalizeAttachmentMimeType } from '../../shared/attachments.js';
import { attachmentMetadata, AttachmentStore, type StoredAttachment } from '../stores/attachments.js';

/** The conversation every picture sent to the master belongs to in its store. */
export const MASTER_CONVERSATION = 'master';

/**
 * Pictures the owner sends the master, kept in `<state>/master/attachments` with the same checks as a session's
 * attachments. The web writes them as a message arrives; the host reads them for the model and pages show them.
 */
export async function masterAttachments(dataDirectory: string): Promise<AttachmentStore> {
  const store = new AttachmentStore(dataDirectory);
  await store.start();
  return store;
}

/** The master reads pictures only: anything else is refused before it is kept. */
export function onlyImages(uploads: unknown): void {
  if (uploads === undefined) return;
  if (!Array.isArray(uploads)) throw Object.assign(new Error('첨부 파일 목록 형식이 올바르지 않습니다.'), { statusCode: 400 });
  for (const upload of uploads) {
    const { name, mimeType } = (upload ?? {}) as { name?: unknown; mimeType?: unknown };
    if (typeof name !== 'string' || typeof mimeType !== 'string' || !isImageAttachment(normalizeAttachmentMimeType(mimeType, name))) {
      throw Object.assign(new Error('마스터에게는 사진(PNG, JPEG, GIF, WebP)만 보낼 수 있습니다.'), { statusCode: 415 });
    }
  }
}

/** The pictures a message names, as the host keeps them: known, well-formed images, at most ten. */
export function imageList(value: unknown): Attachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw Object.assign(new Error('첨부 사진 목록이 올바르지 않습니다.'), { statusCode: 400 });
  return value.map(item => {
    const metadata = attachmentMetadata(item);
    if (!metadata || !isImageAttachment(metadata.mimeType)) throw Object.assign(new Error('첨부 사진 목록이 올바르지 않습니다.'), { statusCode: 400 });
    return metadata;
  });
}

/** A picture as the model reads it. */
export const imagePart = (picture: StoredAttachment) => ({ type: 'input_image', image_url: `data:${picture.metadata.mimeType};base64,${picture.content.toString('base64')}`, detail: 'auto' });

/** Sends a kept picture to a page, as Tower's own attachment route does. */
export function sendPicture(res: ServerResponse, picture: StoredAttachment, head: boolean): void {
  res.writeHead(200, {
    'Content-Type': picture.metadata.mimeType,
    'Content-Length': picture.content.length,
    'Content-Disposition': `inline; filename="attachment"; filename*=UTF-8''${encodeURIComponent(picture.metadata.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400, immutable',
  });
  res.end(head ? undefined : picture.content);
}
