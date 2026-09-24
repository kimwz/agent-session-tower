import http2, { type ClientHttp2Session, type ClientHttp2Stream, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isImageAttachment } from '../../shared/attachments.js';
import { ATTACHMENT_BODY_BYTES } from '../http/requests.js';

/** Only what the other computer's routes read; cookies, tokens and this browser's origin stay here. */
const REQUEST_HEADERS = ['content-type', 'content-length', 'accept', 'last-event-id', 'x-tower-request-id'] as const;
const ANSWER_TYPES = /^(application\/json|text\/event-stream|application\/octet-stream|image\/(png|jpeg|gif|webp))(\s*;|$)/i;
/** Conversation pages and attachments; a larger answer is not one Tower sends. */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
/** Streams carry a heartbeat every 15 seconds; other answers arrive well within this. */
const QUIET_MS = 60_000;

export const NODE_OFFLINE = 'node-offline';
export const NODE_REFUSED = 'node-refused';

const fail = (res: ServerResponse, status: number, error: string, code: string) => {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error, code }));
};

/**
 * Passes one request from this Tower's page to a joined computer over its link, and its answer back. The other
 * computer decides what exists; this side only limits what crosses: a few request headers, known answer types,
 * sizes, and time without progress. A browser leaving ends the request, never the work it started.
 */
export function proxyToNode(req: IncomingMessage, res: ServerResponse, session: ClientHttp2Session | undefined, path: string): Promise<void> {
  return new Promise(resolve => {
    if (!session || session.destroyed || session.closed) {
      fail(res, 503, '이 컴퓨터에 지금 연결되어 있지 않습니다. 다시 연결되면 다시 시도하세요.', NODE_OFFLINE);
      return resolve();
    }
    const headers: OutgoingHttpHeaders = { ':method': req.method ?? 'GET', ':path': path };
    for (const name of REQUEST_HEADERS) { const value = req.headers[name]; if (typeof value === 'string') headers[name] = value; }
    const bodyless = req.method === 'GET' || req.method === 'HEAD';
    let stream: ClientHttp2Stream;
    try { stream = session.request(headers, { endStream: bodyless }); }
    catch { fail(res, 503, '이 컴퓨터에 지금 연결되어 있지 않습니다. 다시 연결되면 다시 시도하세요.', NODE_OFFLINE); return resolve(); }
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(quiet); resolve(); };
    let quiet = setTimeout(() => timeout(), QUIET_MS);
    const touch = () => { clearTimeout(quiet); quiet = setTimeout(() => timeout(), QUIET_MS); };
    const timeout = () => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      fail(res, 504, '다른 컴퓨터가 제때 응답하지 않았습니다.', NODE_OFFLINE);
      finish();
    };
    // The page went away: stop this request. Anything it already started keeps running over there.
    res.once('close', () => { if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL); finish(); });
    stream.on('error', () => { fail(res, 502, '다른 컴퓨터와의 연결이 끊겼습니다.', NODE_OFFLINE); finish(); });

    if (!bodyless) {
      let sent = 0;
      req.on('data', (chunk: Buffer) => {
        sent += chunk.length;
        if (sent > ATTACHMENT_BODY_BYTES) {
          req.pause();
          stream.close(http2.constants.NGHTTP2_CANCEL);
          fail(res, 413, '요청 본문이 너무 큽니다.', 'too-large');
          finish();
          return;
        }
        touch();
        if (!stream.write(chunk)) { req.pause(); stream.once('drain', () => req.resume()); }
      });
      req.on('end', () => { if (!stream.destroyed) stream.end(); });
      req.on('error', () => { stream.close(http2.constants.NGHTTP2_CANCEL); finish(); });
    }

    stream.on('response', (answer: IncomingHttpHeaders) => {
      touch();
      const status = Number(answer[':status']);
      const type = String(answer['content-type'] ?? '');
      // The other computer refusing this link must not read as this browser being signed out.
      if (status === 401 || status === 403) { stream.close(http2.constants.NGHTTP2_CANCEL); fail(res, 502, '다른 컴퓨터가 이 요청을 거절했습니다.', NODE_REFUSED); finish(); return; }
      if (!ANSWER_TYPES.test(type) || status < 200 || (status >= 300 && status < 400)) { stream.close(http2.constants.NGHTTP2_CANCEL); fail(res, 502, '다른 컴퓨터의 응답을 읽을 수 없습니다.', 'node-answer'); finish(); return; }
      const out: Record<string, string | number> = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (/^text\/event-stream/i.test(type)) out['X-Accel-Buffering'] = 'no';
      else if (!/^application\/json/i.test(type)) {
        // Files from another computer open inline only as images, and never run anything in this page's origin.
        const inline = isImageAttachment(type.split(';')[0].trim().toLowerCase());
        const disposition = String(answer['content-disposition'] ?? '');
        const name = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        out['Content-Type'] = inline ? type : 'application/octet-stream';
        out['Content-Disposition'] = `${inline ? 'inline' : 'attachment'}; filename="attachment"${name && /^[\w.%~!$&+,=@-]+$/.test(name) ? `; filename*=UTF-8''${name}` : ''}`;
        out['Content-Security-Policy'] = "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'";
        const length = Number(answer['content-length']);
        if (Number.isSafeInteger(length) && length >= 0) out['Content-Length'] = length;
      }
      res.writeHead(status, out);
      let received = 0;
      stream.on('data', (chunk: Buffer) => {
        touch();
        received += chunk.length;
        if (received > MAX_ANSWER_BYTES) { stream.close(http2.constants.NGHTTP2_CANCEL); res.destroy(); finish(); return; }
        if (!res.write(chunk)) { stream.pause(); res.once('drain', () => stream.resume()); }
      });
      stream.on('end', () => { res.end(); finish(); });
    });
    stream.on('close', () => { if (!done) { if (!res.headersSent) fail(res, 502, '다른 컴퓨터와의 연결이 끊겼습니다.', NODE_OFFLINE); else res.end(); finish(); } });
  });
}
