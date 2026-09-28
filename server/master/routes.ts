import type { IncomingMessage, ServerResponse } from 'node:http';
import { ATTACHMENT_BODY_BYTES, readJson } from '../http/requests.js';
import { MASTER_CONVERSATION, sendPicture } from './attachments.js';
import type { MasterClient } from './client.js';
import type { VoiceTurnEnd } from './voice-turn-end.js';

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

/**
 * `/api/master/*` on the owner's pages. Tower's server has already checked who is asking (and the page token for
 * changes) before this runs; `local` says whether the request came from this computer itself.
 */
export function masterRoutes(client: MasterClient, options: { turnEnd?: VoiceTurnEnd } = {}) {
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
      const body = await readJson(req, ATTACHMENT_BODY_BYTES);
      const args = { clientMessageId: body.clientMessageId, text: body.text, viewContext: body.viewContext, local: identity.local,
        ...(body.model !== undefined ? { model: body.model } : {}), ...(body.effort !== undefined ? { effort: body.effort } : {}) };
      const files = body.attachments !== undefined || body.attachmentIds !== undefined;
      if (!files && body.model === undefined && body.effort === undefined) { await call('send', args); return true; }
      // Files are checked and kept here, and only their records go to the host; kept for nothing, they go again.
      let created: string[] = [];
      try {
        // An older host still at work would drop what it does not know yet.
        if (!await client.sameBuild()) throw Object.assign(new Error('마스터가 새 버전으로 바뀌기를 기다리는 중입니다. 하던 일이 끝나면 파일과 모델 선택을 보낼 수 있습니다.'), { statusCode: 503 });
        if (!files) { json(res, 200, await client.call('send', args)); return true; }
        const store = await client.attachments();
        const prepared = await store.prepare(MASTER_CONVERSATION, { attachments: body.attachments as never, attachmentIds: body.attachmentIds as never });
        created = prepared.createdIds;
        const sent = await client.call('send', { ...args, attachments: prepared.attachments });
        json(res, 200, sent);
      } catch (error) {
        const value = error as { message?: string; statusCode?: number };
        // Only a message the host refused lets its pictures go; one whose answer was lost may have been taken.
        const refused = !value.statusCode || (value.statusCode >= 400 && value.statusCode < 500);
        if (created.length && refused) await client.attachments().then(store => store.rollback(created)).catch(() => {});
        json(res, value.statusCode && value.statusCode >= 400 && value.statusCode < 600 ? value.statusCode : 503, { error: value.message ?? '마스터를 사용할 수 없습니다.' });
      }
      return true;
    }
    const picture = /^\/api\/master\/attachments\/([0-9a-f-]{36})$/.exec(path);
    if ((req.method === 'GET' || req.method === 'HEAD') && picture) {
      try { sendPicture(res, await (await client.attachments()).read(picture[1], MASTER_CONVERSATION), req.method === 'HEAD'); }
      catch (error) { json(res, (error as { statusCode?: number }).statusCode === 404 ? 404 : 503, { error: (error as Error).message }); }
      return true;
    }
    if (req.method === 'POST' && path === '/api/master/stop') { await call('stop'); return true; }
    // A request that failed or was stopped goes again as a new message, with what this page is allowed now.
    const retry = /^\/api\/master\/retry\/([0-9a-f-]{36})$/.exec(path);
    if (req.method === 'POST' && retry) {
      const body = await readJson(req, 16 * 1024);
      await call('retry', { id: retry[1], viewContext: body.viewContext, local: identity.local });
      return true;
    }
    // The page says whether it did a screen command, and answers cards (a secret typed into one goes to the host only).
    const answer = /^\/api\/master\/(directives|cards)\/([0-9a-f-]{36})$/.exec(path);
    if (req.method === 'POST' && answer) {
      const body = await readJson(req, 16 * 1024);
      if (answer[1] === 'directives') await call('ack', { id: answer[2], result: body.result, note: body.note });
      else await call('card', { id: answer[2], body, local: identity.local });
      return true;
    }
    if (req.method === 'POST' && path === '/api/master/settings') { await call('settings', { body: await readJson(req, 16 * 1024) }); return true; }
    // Voice: the page turns it on, writes down what is said with a token from here, and plays what is read aloud.
    const voice = /^\/api\/master\/voice\/(on|off|presence|token|usage|request|activity|finished|nudge|played)$/.exec(path);
    if (req.method === 'POST' && voice) {
      const body = await readJson(req, voice[1] === 'request' ? 16 * 1024 : 4 * 1024);
      switch (voice[1]) {
        case 'on': await call('voiceOn', { tabId: body.tabId, local: identity.local }); break;
        case 'off': await call('voiceOff', { session: body.session }); break;
        case 'presence': await call('voicePresence', { session: body.session, listening: body.listening, panelOpen: body.panelOpen }); break;
        case 'token': await call('voiceToken', { session: body.session }); break;
        case 'usage': await call('voiceUsage', { tokenId: body.tokenId, seconds: body.seconds }); break;
        case 'request': await call('voiceRequest', { session: body.session, clientMessageId: body.clientMessageId, text: body.text, viewContext: body.viewContext, local: identity.local }); break;
        case 'activity': await call('voiceActivity', { session: body.session, speaking: body.speaking, sinceSpeechMs: body.sinceSpeechMs }); break;
        // Judged here in the web, where fast judgments live; the host only confirms the session.
        case 'finished': json(res, 200, options.turnEnd ? await options.turnEnd.judge({ session: body.session, text: body.text, pauseMs: body.pauseMs }) : { unavailable: true }); break;
        case 'nudge': await call('voiceNudge', { session: body.session }); break;
        default: await call('voicePlayed', { session: body.session, id: body.id, result: body.result });
      }
      return true;
    }
    if (req.method === 'GET' && path === '/api/master/voice/voices') { await call('voiceVoices'); return true; }
    const audio = /^\/api\/master\/voice\/audio\/((?:clip-[a-f0-9]{64})|[0-9a-f-]{36})$/.exec(path);
    if (req.method === 'GET' && audio) {
      try { await client.pipeAudio(res, audio[1]); }
      catch (error) { if (!res.headersSent) json(res, 503, { error: (error as Error).message }); else res.destroy(); }
      return true;
    }
    json(res, 404, { error: '찾을 수 없습니다.' });
    return true;
  };
}
export type MasterRoutes = ReturnType<typeof masterRoutes>;
