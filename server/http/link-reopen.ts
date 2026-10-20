import type { ServerResponse } from 'node:http';
import { isChatImageLink } from './chat-images.js';
import { isTodoFileLink } from './todo-routes.js';

/**
 * The links Tower hands out that the owner may open from another site: a conversation image and a todo attachment.
 * Each is matched whole on the raw request target, so a match needs no escaping.
 */
export const isReopenableLink = (url: string) => isChatImageLink(url) || isTodoFileLink(url);

/**
 * Answers a top-level navigation to such a link that came from another site (a link in another app or page, a window
 * that does not share the page's session, or back from a login such as Cloudflare Access). That load carries no Tower
 * session (SameSite=Strict), so this page only opens the same link again from Tower itself, and that request passes
 * every usual check.
 */
export function sendLinkReopen(res: ServerResponse, url: string, head: boolean): void {
  if (!isReopenableLink(url)) throw new Error('Not a link that opens again from Tower.');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
  res.end(head ? undefined : `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${url}"><title>Agent Session Tower</title><a href="${url}">${isChatImageLink(url) ? '이미지 열기' : '파일 열기'}</a>\n`);
}
