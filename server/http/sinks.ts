import { pipeline } from 'node:stream/promises';
import type { AttachmentStore } from '../stores/attachments.js';
import { isImageAttachment } from '../../shared/attachments.js';
import type { ServerResponse } from 'node:http';
import { STATUS } from '../../shared/errors.js';
import type { StreamSink } from '../streams/sink.js';

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
