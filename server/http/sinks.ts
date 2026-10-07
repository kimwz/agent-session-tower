import { pipeline } from 'node:stream/promises';
import type { AttachmentStore } from '../stores/attachments.js';
import { isImageAttachment } from '../../shared/attachments.js';
import type { ServerResponse } from 'node:http';
import { STATUS } from '../../shared/errors.js';
import type { StreamSink } from '../streams/sink.js';
import type { WorkspaceMediaFile } from '../workspace-files.js';

function sink(res: ServerResponse, head: (length?: number | string) => Record<string, string | number>): StreamSink {
  let opened = false;
  return {
    body: res,
    get opened() { return opened; },
    open(info = {}) { opened = true; res.writeHead(200, head(info.length)); },
    refuse(kind) { res.writeHead(STATUS[kind]).end(); },
    cutOff(graceMs) {
      const socket = res.socket;
      if (!socket || socket.destroyed) { res.destroy(); return; }
      const timer = setTimeout(() => res.destroy(), graceMs);
      socket.once('close', () => clearTimeout(timer));
      socket.end();
    },
  };
}

/** An event stream: never cached, never buffered by a proxy. */
export const sseSink = (res: ServerResponse): StreamSink => sink(res, () => ({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }));

/** Audio read aloud: mp3, never cached; with a length it is a finite file a player can seek in. */
export const audioSink = (res: ServerResponse): StreamSink => sink(res, length => ({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', ...(length !== undefined ? { 'Content-Length': length } : {}) }));

export async function sendStoredAttachment(res: ServerResponse, store: AttachmentStore, id: string, head: boolean,
  authorize: (sessionId: string) => Promise<void> = async () => {}): Promise<void> {
  const value = await store.openVerified(id);
  try {
    await authorize(value.sessionId);
    const { metadata } = value;
    const inline = isImageAttachment(metadata.mimeType);
    res.writeHead(200, { 'Content-Type': inline ? metadata.mimeType : 'application/octet-stream', 'Content-Length': metadata.size, 'Cache-Control': 'no-store',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
    if (head) res.end();
    else await pipeline(value.file.createReadStream({ start: 0, autoClose: false }), res);
  } finally { await value.file.close(); }
}

/**
 * The single byte range a player asks for, as inclusive offsets; `undefined` means the whole file (no header, one the
 * server may ignore, or several ranges) and `null` a range that lies past the end.
 */
export function byteRange(header: string | string[] | undefined, size: number): { start: number; end: number } | null | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return undefined;
    if (suffix === 0 || size === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const last = match[2] ? Number(match[2]) : Infinity;
  if (!Number.isSafeInteger(start) || (match[2] && !Number.isSafeInteger(last)) || last < start) return undefined;
  if (start >= size) return null;
  return { start, end: Math.min(last, size - 1) };
}

/**
 * Sends an opened workspace media file, or the range of it a player asks for, and closes it. The headers keep any
 * file, whatever its bytes really are, from running as a page in Tower's origin.
 */
export async function sendWorkspaceMedia(res: ServerResponse, media: WorkspaceMediaFile, range: string | string[] | undefined, head: boolean): Promise<void> {
  try {
    const headers = { 'Content-Type': media.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'" };
    const wanted = byteRange(range, media.size);
    if (wanted === null) {
      res.writeHead(416, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Range': `bytes */${media.size}`, 'Cache-Control': 'no-store' });
      res.end(head ? undefined : JSON.stringify({ error: 'Requested range is outside the file.' }));
      return;
    }
    const { start, end } = wanted ?? { start: 0, end: media.size - 1 };
    res.writeHead(wanted ? 206 : 200, { ...headers, 'Content-Length': end - start + 1,
      ...(wanted ? { 'Content-Range': `bytes ${start}-${end}/${media.size}` } : {}) });
    if (head || end < start) { res.end(); return; }
    await pipeline(media.handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await media.handle.close(); }
}
