import type { ServerResponse } from 'node:http';
import type { Attachment } from '../../shared/types.js';
import { isImageAttachment } from '../../shared/attachments.js';
import { attachmentMetadata, AttachmentStore, type StoredAttachment } from '../stores/attachments.js';

/** The conversation every picture sent to the master belongs to in its store. */
export const MASTER_CONVERSATION = 'master';

/**
 * Files the owner sends the master, kept in `<state>/master/attachments` with the same checks as a session's
 * attachments. The web writes them as a message arrives; the host reads them for the model and pages show them.
 */
export async function masterAttachments(dataDirectory: string): Promise<AttachmentStore> {
  const store = new AttachmentStore(dataDirectory);
  await store.start();
  return store;
}

/** The files a message names, as the host keeps them: known, well-formed records, at most ten. */
export function fileList(value: unknown): Attachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw Object.assign(new Error('첨부 파일 목록이 올바르지 않습니다.'), { statusCode: 400 });
  return value.map(item => {
    const metadata = attachmentMetadata(item);
    if (!metadata) throw Object.assign(new Error('첨부 파일 목록이 올바르지 않습니다.'), { statusCode: 400 });
    return metadata;
  });
}

/** Longest text file whose content is given to the model as it is. */
export const MAX_TEXT_FILE = 100_000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|x-sh|javascript|typescript|sql|csv|x-ndjson)$)/;
const TEXT_NAMES = /\.(txt|md|markdown|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env\.example|csv|tsv|log|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|diff|patch|lua|dart|vue|svelte)$/i;

/**
 * How the model reads a kept file: a picture as an image, a PDF as a file it reads itself, a short text file as its
 * text, and anything else only by where it is kept, so a session on this computer can be given it.
 */
export function modelFile(file: StoredAttachment): { part?: Record<string, unknown>; text?: string } {
  const { metadata, content } = file;
  if (isImageAttachment(metadata.mimeType)) return { part: { type: 'input_image', image_url: `data:${metadata.mimeType};base64,${content.toString('base64')}`, detail: 'auto' } };
  if (content.subarray(0, 5).toString('latin1') === '%PDF-') return { part: { type: 'input_file', filename: metadata.name, file_data: `data:application/pdf;base64,${content.toString('base64')}` } };
  if (content.length <= MAX_TEXT_FILE && (TEXT_TYPES.test(metadata.mimeType) || TEXT_NAMES.test(metadata.name)) && !content.includes(0)) {
    const text = new TextDecoder('utf-8', { fatal: true });
    try { return { text: text.decode(content) }; } catch { /* not UTF-8: named only */ }
  }
  return {};
}

/** Sends a kept file to a page, as Tower's own attachment route does: pictures inline, anything else as a download. */
export function sendPicture(res: ServerResponse, picture: StoredAttachment, head: boolean): void {
  const inline = isImageAttachment(picture.metadata.mimeType);
  res.writeHead(200, {
    'Content-Type': inline ? picture.metadata.mimeType : 'application/octet-stream',
    'Content-Length': picture.content.length,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(picture.metadata.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400, immutable',
  });
  res.end(head ? undefined : picture.content);
}
