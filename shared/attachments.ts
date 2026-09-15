export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Conservative upload limit shared by both provider transports.
export const MAX_IMAGE_ATTACHMENT_BYTES = 5_000_000;
export const IMAGE_ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export function isImageAttachment(mimeType: string): boolean {
  return (IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}
export function normalizeAttachmentMimeType(mimeType: string, name: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized) return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
  const extension = name.split('.').pop()?.toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[extension || ''] || 'application/octet-stream';
}
