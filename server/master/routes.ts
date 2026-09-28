import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson } from '../http/requests.js';
import type { MasterClient } from './client.js';

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

/**
 * `/api/master/*` on the owner's pages. Tower's server has already checked who is asking (and the page token for
 * changes) before this runs; `local` says whether the request came from this computer itself.
 */
export function masterRoutes(client: MasterClient) {
  return async function handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL, identity: { local: boolean }): Promise<boolean> {
    if (!path.startsWith('/api/master')) return false;
    const call = async (method: string, args: Record<string, unknown> = {}) => {
      try { return json(res, 200, await client.call(method, args)); }
      catch (error) {
        const value = error as { message?: string; statusCode?: number };
        return json(res, value.statusCode && value.statusCode >= 400 && value.statusCode < 600 ? value.statusCode : 503, { error: value.message ?? '마스터를 사용할 수 없습니다.' });
      }
    };
    if (req.method === 'GET' && path === '/api/master') { await call('overview'); return true; }
    if (req.method === 'GET' && path === '/api/master/state') { await call('checkpoint', { limit: 80 }); return true; }
    if (req.method === 'GET' && path === '/api/master/room') {
      const before = Number(url.searchParams.get('before'));
      await call('page', { ...(Number.isInteger(before) && before >= 0 ? { before } : {}), limit: 80 });
      return true;
    }
    if (req.method === 'GET' && path === '/api/master/events') {
      const after = Number(url.searchParams.get('after'));
      try { await client.pipe(res, url.searchParams.get('epoch') ?? '', Number.isInteger(after) ? after : -1); }
      catch (error) { if (!res.headersSent) json(res, 503, { error: (error as Error).message }); else res.end(); }
      return true;
    }
    if (req.method === 'POST' && path === '/api/master/messages') {
      const body = await readJson(req, 64 * 1024);
      await call('send', { clientMessageId: body.clientMessageId, text: body.text, viewContext: body.viewContext, local: identity.local });
      return true;
    }
    if (req.method === 'POST' && path === '/api/master/stop') { await call('stop'); return true; }
    // The page says whether it did a screen command, and answers cards (a secret typed into one goes to the host only).
    const answer = /^\/api\/master\/(directives|cards)\/([0-9a-f-]{36})$/.exec(path);
    if (req.method === 'POST' && answer) {
      const body = await readJson(req, 16 * 1024);
      if (answer[1] === 'directives') await call('ack', { id: answer[2], result: body.result, note: body.note });
      else await call('card', { id: answer[2], body, local: identity.local });
      return true;
    }
    if (req.method === 'POST' && path === '/api/master/settings') { await call('settings', { body: await readJson(req, 16 * 1024) }); return true; }
    // A voice call: the page makes it with its own connection, the host follows it with the owner's key.
    const voice = /^\/api\/master\/voice\/(start|ready|stop|activity|notice)$/.exec(path);
    if (req.method === 'POST' && voice) {
      const body = await readJson(req, voice[1] === 'start' ? 160 * 1024 : 4 * 1024);
      if (voice[1] === 'start') await call('voiceStart', { attemptId: body.attemptId, sdp: body.sdp, tabId: body.tabId, wake: body.wake, local: identity.local });
      else if (voice[1] === 'ready') await call('voiceReady', { attemptId: body.attemptId });
      else if (voice[1] === 'stop') await call('voiceStop', { attemptId: body.attemptId, reason: body.reason });
      else if (voice[1] === 'activity') await call('voiceActivity', { attemptId: body.attemptId, speaking: body.speaking, playing: body.playing, sinceSpeechMs: body.sinceSpeechMs, sincePlaybackMs: body.sincePlaybackMs });
      else await call('voiceNotice', { noticeId: body.noticeId, result: body.result });
      return true;
    }
    json(res, 404, { error: '찾을 수 없습니다.' });
    return true;
  };
}
export type MasterRoutes = ReturnType<typeof masterRoutes>;
