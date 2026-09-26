import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Session, SessionDetail } from '../../shared/types.js';
import { httpError } from './requests.js';

const secret = randomBytes(32);
export const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;
const missing = () => httpError(404, '이미지를 찾을 수 없습니다.');
const within = (root: string, path: string) => { const part = relative(root, path); return part !== '..' && !part.startsWith('../') && !isAbsolute(part); };
function roots(session: Session): string[] {
  const nativeHome = session.provider === 'codex' && session.filePath?.match(/^(.*)\/(?:sessions|archived_sessions)\//)?.[1];
  return [session.cwd, ...(session.provider === 'codex' ? [join(nativeHome || process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images')] : [])];
}
const sign = (value: string) => createHmac('sha256', secret).update(value).digest('base64url');
function ticket(session: Session, path: string): string {
  const value = Buffer.from(JSON.stringify({ sessionId: session.id, path })).toString('base64url');
  return `${value}.${sign(value)}`;
}
export function chatImageReference(value: string): { sessionId: string; path: string } {
  if (value.length > 12000) throw missing();
  const [body, mac, extra] = value.split('.');
  const expected = sign(body || '');
  if (extra || !mac || !/^[A-Za-z0-9_-]{43}$/.test(mac) || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw missing();
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof data.sessionId !== 'string' || typeof data.path !== 'string') throw missing();
    return data;
  } catch { throw missing(); }
}
/** Only image references actually present in a returned conversation receive a capability. */
export function withChatImages(page: SessionDetail): SessionDetail {
  return { ...page, messages: page.messages.map(message => {
    const sources = new Set<string>();
    // Markdown destinations, including angle-bracket paths containing spaces and ordinary image links.
    for (const match of message.text.matchAll(/!?\[[^\]\n]*\]\(<?([^>\n]*?\.(?:png|jpe?g|gif|webp))>?(?:\s+"[^"\n]*")?\)/gi)) sources.add(match[1]);
    // Codex image generation also reports its saved output in tool-result prose.
    if (message.role === 'tool') for (const match of message.text.matchAll(/\/[^\s"'<>`]*\/generated_images\/[^\s"'<>`]*\.(?:png|jpe?g|gif|webp)/gi)) sources.add(match[0]);
    const images = [...sources].slice(0, 20).flatMap(source => {
      let decoded: string;
      try { decoded = decodeURIComponent(source); } catch { return []; }
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(decoded) || decoded.includes('\0')) return [];
      const path = resolve(page.session.cwd, decoded);
      if (!roots(page.session).some(root => within(root, path))) return [];
      return [{ source, name: basename(path), url: `/api/chat-images/${ticket(page.session, path)}` }];
    });
    return images.length ? { ...message, images } : message;
  }) };
}
export async function readChatImage(session: Session, path: string): Promise<{ content: Buffer; mime: string; path: string }> {
  try {
    const canonical = await realpath(path);
    const allowed = await Promise.all(roots(session).map(root => realpath(root).catch(() => '')));
    if (!allowed.some(root => root && within(root, canonical))) throw missing();
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_CHAT_IMAGE_BYTES) throw missing();
      const content = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(content, 0, content.length, 0);
      if (bytesRead !== stat.size) throw missing();
      const mime = content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
        : content[0] === 255 && content[1] === 216 && content[2] === 255 ? 'image/jpeg'
        : /^GIF8[79]a$/.test(content.subarray(0, 6).toString()) ? 'image/gif'
        : content.subarray(0, 4).toString() === 'RIFF' && content.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : undefined;
      if (!mime) throw missing();
      return { content, mime, path: canonical };
    } finally { await file.close(); }
  } catch { throw missing(); }
}
export function sendChatImage(res: ServerResponse, image: Awaited<ReturnType<typeof readChatImage>>, head: boolean): void {
  res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.content.length, 'Cache-Control': 'no-store',
    'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'" });
  res.end(head ? undefined : image.content);
}
