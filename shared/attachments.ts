export const MAX_ATTACHMENTS = 10;
// These bounds apply only to the legacy JSON/base64 transport.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_INLINE_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
export interface AttachmentUploadTarget { kind: 'chat' | 'auto'; sessionId: string }
export interface AttachmentUploadStart { name: string; mimeType: string; size: number }
export interface AttachmentUploadStarted { id: string; offset: number }
export interface AttachmentUploadStatus { offset: number; target: AttachmentUploadTarget }
// Conservative upload limit shared by both provider transports.
export const MAX_IMAGE_ATTACHMENT_BYTES = 5_000_000;
export const IMAGE_ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export function isImageAttachment(mimeType: string): boolean {
  return (IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}
/** Native transports share one bounded selection; every original remains on disk. */
export function selectInlineImages<T extends { mimeType: string; size: number }>(attachments: readonly T[]): T[] {
  let total = 0;
  return attachments.filter(item => {
    if (!isImageAttachment(item.mimeType) || item.size > MAX_IMAGE_ATTACHMENT_BYTES || item.size < 0
      || total + item.size > MAX_INLINE_IMAGE_TOTAL_BYTES) return false;
    total += item.size;
    return true;
  });
}
export function normalizeAttachmentMimeType(mimeType: string, name: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized) return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
  const extension = name.split('.').pop()?.toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[extension || ''] || 'application/octet-stream';
}
