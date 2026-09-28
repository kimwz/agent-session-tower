import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { APP_VERSION } from '../../shared/app-identity.js';
import { MASTER_EFFORTS, type MasterEffort, type MasterStreamEvent } from '../../shared/master.js';
import { acquireStateLock, MonitorAlreadyRunning } from '../instance/state-lock.js';
import { fileList, masterAttachments } from './attachments.js';
import { MasterJournal } from './journal.js';
import { LiveState } from './live-state.js';
import { lookupsSupported, ReadDatabase } from './read-db.js';
import { openAiResponses, type ModelCall } from './model-openai.js';
import { anthropicMessages, routedModel } from './model-anthropic.js';
import { masterPaths } from './paths.js';
import { MasterRoom } from './room.js';
import { MasterService } from './service.js';
import { MasterSettingsStore } from './settings.js';
import { TowerClient, type WebCredentials } from './tower-client.js';
import { ElevenLabs, type ElevenLabsOptions } from './elevenlabs.js';
import { MasterVoice, type VoiceTiming } from './voice.js';

export const MASTER_PROTOCOL = 1;
const MAX_REQUEST = 256 * 1024;
const IDLE_MS = 10 * 60_000;

export interface MasterHostReply { protocol: number; stateDir: string; version: string; result?: unknown; error?: { message: string; statusCode: number } }

export interface MasterHostOptions {
  stateDir: string;
  releaseStateLock?: () => Promise<void>;
  model?: ModelCall;
  idleMs?: number;
  taskPollMs?: number;
  onClosed?: () => void;
  /** Tests talk to fake GPT-Live servers, faster. */
  voice?: { elevenLabs?: Omit<ElevenLabsOptions, 'key'>; timing?: Partial<VoiceTiming> };
}

const failure = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/**
 * The master agent's own process. The web starts it on first use and talks to it over an owner-only socket; it keeps
 * running when the web restarts, so a turn in progress is never cut off by a deployment. It exits once nothing waits,
 * runs or listens for a while.
 */
export async function startMasterHost(options: MasterHostOptions) {
  const paths = await masterPaths(options.stateDir);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  const release = options.releaseStateLock ?? await acquireStateLock(paths.runtime, 0);
  const token = randomBytes(32).toString('hex');
  const settings = new MasterSettingsStore(paths.data);
  const room = new MasterRoom(paths.data);
  const journal = new MasterJournal(paths.data);
  const tower = new TowerClient();
  const live = new LiveState((path, signal) => tower.stream(path, signal));
  const readDb = lookupsSupported() ? new ReadDatabase() : undefined;
  let service: MasterService | undefined;
  let voice: MasterVoice | undefined;
  let lastRequest = Date.now();
  let pending = 0;
  let closing = false;
  const streams = new Set<ServerResponse>();

  const credentials = (value: unknown) => {
    const web = value as Partial<WebCredentials> | undefined;
    if (web && Number.isInteger(web.port) && typeof web.token === 'string' && /^[a-f0-9]{64}$/.test(web.token) && typeof web.callerSecret === 'string' && /^[a-f0-9]{64}$/.test(web.callerSecret)) {
      tower.setCredentials({ port: web.port!, token: web.token, callerSecret: web.callerSecret });
    }
  };
  const busy = () => service!.busy();
  // A host of another build steps aside unless it is in the middle of something only it holds.
  const working = () => service!.working();
  const dispatch = async (method: string, args: Record<string, unknown>) => {
    const master = service!;
    const speech = voice!;
    switch (method) {
      case 'ping': return { busy: working(), streams: streams.size };
      case 'hello': return true;
      case 'overview': return master.overview();
      case 'checkpoint': {
        // The position is taken first: whatever happens while the page is read is replayed after it, never skipped.
        const position = room.position();
        const draft = room.currentDraft();
        const overview = master.overview();
        const page = await room.page(undefined, typeof args.limit === 'number' ? args.limit : 80);
        return { ...position, ...page, ...(draft ? { draft } : {}), overview };
      }
      case 'page': return room.page(typeof args.before === 'number' ? args.before : undefined, typeof args.limit === 'number' ? args.limit : 80);
      case 'send': {
        if (typeof args.clientMessageId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(args.clientMessageId)) throw failure('메시지 ID가 올바르지 않습니다.', 400);
        const attachments = fileList(args.attachments);
        if (typeof args.text !== 'string' || (!args.text.trim() && !attachments.length) || args.text.length > 32_000) throw failure('메시지가 비었거나 너무 깁니다.', 400);
        if (args.model !== undefined && (typeof args.model !== 'string' || !/^[a-zA-Z0-9._:-]{1,80}$/.test(args.model))) throw failure('모델 이름이 올바르지 않습니다.', 400);
        if (args.effort !== undefined && !(MASTER_EFFORTS as readonly unknown[]).includes(args.effort)) throw failure('추론 수준이 올바르지 않습니다.', 400);
        return master.send({ clientMessageId: args.clientMessageId, text: args.text, local: args.local === true, ...(attachments.length ? { attachments } : {}),
          ...(args.model !== undefined ? { model: args.model as string } : {}), ...(args.effort !== undefined ? { effort: args.effort as MasterEffort } : {}),
          ...(args.viewContext && typeof args.viewContext === 'object' ? { viewContext: viewContext(args.viewContext) } : {}) });
      }
      case 'retry': {
        if (typeof args.id !== 'string') throw failure('다시 보낼 요청이 올바르지 않습니다.', 400);
        return master.retry(args.id, { local: args.local === true, ...(args.viewContext && typeof args.viewContext === 'object' ? { viewContext: viewContext(args.viewContext) } : {}) });
      }
      case 'stop': return master.stop();
      case 'ack': {
        if (typeof args.id !== 'string' || !['done', 'unavailable', 'failed'].includes(String(args.result))) throw failure('화면 응답이 올바르지 않습니다.', 400);
        return master.ack(args.id, args.result as 'done' | 'unavailable' | 'failed', typeof args.note === 'string' ? args.note : undefined);
      }
      case 'card': {
        if (typeof args.id !== 'string' || !args.body || typeof args.body !== 'object') throw failure('카드 응답이 올바르지 않습니다.', 400);
        return master.card(args.id, args.body as Record<string, unknown>, args.local === true);
      }
      case 'settings': {
        const overview = await master.updateSettings(args.body && typeof args.body === 'object' ? args.body as Record<string, unknown> : {});
        speech.broadcast();
        return overview;
      }
      case 'voiceOn': return speech.voiceOn({ tabId: args.tabId, local: args.local === true });
      case 'voiceOff': return speech.voiceOff({ session: args.session });
      case 'voicePresence': return speech.voicePresence({ session: args.session, listening: args.listening, panelOpen: args.panelOpen });
      case 'voiceToken': return speech.voiceToken({ session: args.session });
      case 'voiceUsage': return speech.voiceUsage({ tokenId: args.tokenId, seconds: args.seconds });
      case 'voiceRequest': return speech.voiceRequest({ session: args.session, clientMessageId: args.clientMessageId, text: args.text, local: args.local === true, ...(args.viewContext && typeof args.viewContext === 'object' ? { viewContext: viewContext(args.viewContext) } : {}) });
      case 'voiceActivity': return speech.voiceActivity({ session: args.session, speaking: args.speaking, sinceSpeechMs: args.sinceSpeechMs });
      case 'voiceKnown': return speech.voiceKnown({ session: args.session });
      case 'voiceNudge': return speech.voiceNudge({ session: args.session });
      case 'voicePlayed': return speech.voicePlayed({ session: args.session, id: args.id, result: args.result });
      case 'voiceVoices': return speech.voiceVoices();
      case 'shutdown': {
        if (working()) return false;
        setImmediate(() => { void close(true); });
        return true;
      }
    }
    throw failure('Unknown master operation.', 400);
  };

  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (closing || !service || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://master.invalid');
    if (req.method === 'GET' && url.pathname === '/events') { lastRequest = Date.now(); events(res, url.searchParams.get('epoch') ?? '', Number(url.searchParams.get('after') ?? '-1')); return; }
    // Audio read aloud, streamed to the page through the web as it is made.
    const audio = /^\/audio\/((?:clip-[a-f0-9]{64})|[0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && audio) { lastRequest = Date.now(); void voice!.serveAudio(audio[1], res).catch(() => { if (!res.headersSent) res.writeHead(500); res.destroy(); }); return; }
    if (req.method !== 'POST' || url.pathname !== '/rpc') { res.writeHead(404); res.end(); return; }
    pending++;
    const reply: MasterHostReply = { protocol: MASTER_PROTOCOL, stateDir: paths.stateDir, version: APP_VERSION };
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST) throw failure('Master request too large.', 413);
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { protocol?: number; method?: string; args?: Record<string, unknown>; web?: unknown };
      if (input.protocol !== MASTER_PROTOCOL || typeof input.method !== 'string') throw failure('Incompatible master request.', 409);
      credentials(input.web);
      // A web's heartbeat or version check is not use: an idle master may still exit while pages are open.
      if (!['hello', 'ping', 'voiceActivity', 'voicePresence'].includes(input.method)) lastRequest = Date.now();
      reply.result = await dispatch(input.method, input.args && typeof input.args === 'object' ? input.args : {}) ?? null;
    } catch (error) {
      const value = error as { message?: string; statusCode?: number };
      reply.error = { message: value.message ?? 'Master operation failed.', statusCode: value.statusCode ?? 500 };
    } finally { pending--; }
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)); }
  });
  server.requestTimeout = 0;

  /** Live changes for one page: what it missed since `(epoch, after)`, then everything new. */
  function events(res: ServerResponse, epoch: string, after: number) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    // Opens the page's stream at once, before anything has happened.
    res.write(': connected\n\n');
    const missed = Number.isInteger(after) ? room.since(epoch, after) : undefined;
    if (!missed) { res.end(`event: resync\ndata: {}\n\n`); return; }
    const send = (event: MasterStreamEvent) => { if (!res.writableEnded) res.write(`id: ${room.epoch}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`); };
    for (const event of missed) send(event);
    const unsubscribe = room.subscribe(send);
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 15_000);
    streams.add(res);
    res.on('close', () => { unsubscribe(); clearInterval(heartbeat); streams.delete(res); lastRequest = Date.now(); });
  }

  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const close = async (idle = false) => {
    if (closing) return;
    closing = true;
    if (idleTimer) clearInterval(idleTimer);
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(paths.socket).catch(() => {});
    await unlink(paths.token).catch(() => {});
    live.close();
    readDb?.close();
    try { await voice?.close(); await service?.close(); } finally {
      await release();
      if (idle) options.onClosed?.();
    }
  };

  try {
    await settings.start();
    await room.start();
    await journal.start();
    service = new MasterService({ settings, room, journal, tower, live, readDb, attachments: await masterAttachments(paths.data), model: options.model ?? routedModel(openAiResponses(() => settings.key()), anthropicMessages(() => settings.anthropicKey())), ...(options.taskPollMs ? { taskPollMs: options.taskPollMs } : {}) });
    const elevenLabs = new ElevenLabs({ key: () => settings.voiceKey(), ...options.voice?.elevenLabs });
    voice = new MasterVoice({ dataDir: paths.data, settings, room, hooks: service.voiceHooks(), elevenLabs, ...(options.voice?.timing ? { timing: options.voice.timing } : {}) });
    service.setVoice(voice);
    // The voice's records first: what the master answers from the start knows whether to be spoken.
    await voice.start();
    await service.start();
    await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(paths.token).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, () => { server.off('error', reject); resolve(); }); });
    await chmod(paths.socket, 0o600);
    // The credential appears last: a web that can read it can already talk to this host.
    await writeFile(paths.token, token, { flag: 'wx', mode: 0o600 });
    idleTimer = setInterval(() => {
      if (closing || pending || streams.size || busy() || Date.now() - lastRequest < (options.idleMs ?? IDLE_MS)) return;
      void close(true).catch(error => { console.error(`Master host idle cleanup failed: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}`); });
    }, 1000);
    idleTimer.unref();
    return { socketPath: paths.socket, close, service };
  } catch (error) { await close(); throw error; }
}

function viewContext(value: object) {
  const input = value as Record<string, unknown>;
  const text = (item: unknown, max: number) => typeof item === 'string' && item.length <= max ? item : undefined;
  const tabId = text(input.tabId, 80), sessionId = text(input.sessionId, 400), node = text(input.node, 32), cwd = text(input.cwd, 4096);
  return { ...(tabId ? { tabId } : {}), ...(sessionId ? { sessionId } : {}), ...(node && /^[a-f0-9]{32}$/.test(node) ? { node } : {}), ...(cwd ? { cwd } : {}) };
}

export async function runMasterHost(stateDir: string): Promise<void> {
  const paths = await masterPaths(stateDir);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try { release = await acquireStateLock(paths.runtime, 0); }
  catch (error) { if (error instanceof MonitorAlreadyRunning) return; throw error; }
  await startMasterHost({ stateDir, releaseStateLock: release, onClosed: () => process.exit(0) });
  // The master's work belongs to the owner, never to a parent terminal or a web shutdown.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
}
