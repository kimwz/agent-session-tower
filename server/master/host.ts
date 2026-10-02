import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { APP_VERSION } from '../../shared/app-identity.js';
import type { MasterOverview, MasterStreamEvent } from '../../shared/master.js';
import type { Provider } from '../../shared/types.js';
import { acquireStateLock, MonitorAlreadyRunning } from '../instance/state-lock.js';
import { LiveState } from '../tower-tools/live-state.js';
import { lookupsSupported, ReadDatabase } from '../tower-tools/read-db.js';
import { masterPaths } from './paths.js';
import { MasterRoom } from './room.js';
import { MasterSession } from './session.js';
import { MasterSettingsStore } from './settings.js';
import { MASTER_TOOLS, MasterTools } from './tools.js';
import { TowerClient, type WebCredentials } from '../tower-tools/tower-client.js';
import { ElevenLabs, type ElevenLabsOptions } from './elevenlabs.js';
import { FirstReplyMaker } from './first-reply.js';
import { MasterVoice, type MasterVoiceOptions, type VoiceTiming } from './voice.js';
import { keepEndpoint } from '../runs/endpoint-keeper.js';

export const MASTER_PROTOCOL = 1;
const MAX_REQUEST = 256 * 1024;
const IDLE_MS = 10 * 60_000;

export interface MasterHostReply { protocol: number; stateDir: string; version: string; result?: unknown; error?: { message: string; statusCode: number } }

export interface MasterHostOptions {
  stateDir: string;
  releaseStateLock?: () => Promise<void>;
  idleMs?: number;
  followMs?: number;
  onClosed?: () => void;
  /** Tests talk to fake ElevenLabs servers, faster. */
  voice?: { elevenLabs?: Omit<ElevenLabsOptions, 'key'>; timing?: Partial<VoiceTiming>; firstReply?: MasterVoiceOptions['firstReply'] };
}

const failure = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/**
 * The master's own process: it keeps the master session's guide, gives the session Tower's page tools, follows the
 * work the master hands out and reports when it ends, and runs the voice. The web starts it and talks to it over an
 * owner-only socket; the session's tool server reaches it the same way. It keeps running when the web restarts, and
 * while a master session exists, so no report is missed.
 */
export async function startMasterHost(options: MasterHostOptions) {
  const paths = await masterPaths(options.stateDir);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  const release = options.releaseStateLock ?? await acquireStateLock(paths.runtime, 0);
  const token = randomBytes(32).toString('hex');
  const settings = new MasterSettingsStore(paths.data);
  // The voice's ledger lives beside the conversation the master kept before it became a session, which stays as it was.
  const room = new MasterRoom(join(paths.data, 'voice'));
  const tower = new TowerClient();
  const live = new LiveState((path, signal) => tower.stream(path, signal));
  const readDb = lookupsSupported() ? new ReadDatabase() : undefined;
  let session: MasterSession | undefined;
  let tools: MasterTools | undefined;
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
  const overview = (): MasterOverview => {
    const current = settings.current();
    const binding = current.session;
    const shown = binding ? live.snapshot()?.sessions.find(item => item.id === binding.sessionId) : undefined;
    const voiceConfigured = Boolean(settings.voiceKey());
    return {
      available: true, version: APP_VERSION, settings: current,
      ...(binding ? { session: { id: binding.sessionId, provider: binding.provider, ...(shown ? { status: shown.status, title: shown.customTitle || shown.title } : {}) } } : {}),
      voiceConfigured, ...(voiceConfigured ? { voiceKeyHint: settings.voiceKeyHint() } : {}),
      activeTasks: session?.activeTasks() ?? 0,
      ...(session?.failedReports() ? { failedReports: session.failedReports() } : {}),
      ...(voice ? { voice: voice.status() } : {}),
    };
  };
  const broadcastOverview = () => room.broadcast({ type: 'overview', seq: 0, overview: overview() });
  // A host of another build steps aside unless a report is on its way, a tool is being answered, or something is being
  // read aloud (a turn read while it is written, audio being made, or a page's word awaited).
  const working = () => pending > 1 || Boolean(session?.busy()) || Boolean(voice?.busy());
  const dispatch = async (method: string, args: Record<string, unknown>) => {
    const master = session!;
    const speech = voice!;
    switch (method) {
      case 'ping': return { busy: working(), streams: streams.size };
      case 'hello': return true;
      case 'overview': return overview();
      case 'checkpoint': return { ...room.position(), overview: overview() };
      case 'start': {
        if (args.provider !== 'claude' && args.provider !== 'codex') throw failure('Claude 또는 Codex를 선택하세요.', 400);
        if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 32_000) throw failure('첫 메시지를 적어 주세요.', 400);
        const text = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value) ? value : undefined;
        const binding = await master.begin({ provider: args.provider as Provider, text: args.text.trim(), replace: args.replace === true,
          ...(text(args.model, /^[a-zA-Z0-9._:\[\]-]{1,80}$/) ? { model: args.model as string } : {}), ...(text(args.effort, /^[a-z]{1,20}$/) ? { effort: args.effort as string } : {}) });
        broadcastOverview();
        return { binding, overview: overview() };
      }
      case 'release': { await master.release(); broadcastOverview(); return overview(); }
      case 'presence': {
        if (typeof args.tabId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(args.tabId)) throw failure('탭 ID가 올바르지 않습니다.', 400);
        tools!.present(args.tabId);
        return true;
      }
      case 'ack': {
        if (typeof args.id !== 'string' || !['done', 'unavailable', 'failed'].includes(String(args.result))) throw failure('화면 응답이 올바르지 않습니다.', 400);
        return tools!.ack(args.id, args.result as 'done' | 'unavailable' | 'failed', typeof args.note === 'string' ? args.note : undefined);
      }
      case 'settings': {
        await settings.update(args.body && typeof args.body === 'object' ? args.body as Record<string, unknown> : {});
        speech.broadcast();
        broadcastOverview();
        return overview();
      }
      case 'tools': return MASTER_TOOLS;
      case 'tool': {
        if (typeof args.name !== 'string' || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) throw failure('도구 호출이 올바르지 않습니다.', 400);
        return tools!.call(args.name, args.arguments as Record<string, unknown>);
      }
      case 'voiceOn': return speech.voiceOn({ tabId: args.tabId, local: args.local === true });
      case 'voiceOff': return speech.voiceOff({ session: args.session });
      case 'voicePresence': return speech.voicePresence({ session: args.session, listening: args.listening });
      case 'voiceToken': return speech.voiceToken({ session: args.session });
      case 'voiceUsage': return speech.voiceUsage({ tokenId: args.tokenId, seconds: args.seconds });
      case 'voiceRequest': return speech.voiceRequest({ session: args.session, clientMessageId: args.clientMessageId, text: args.text, local: args.local === true });
      case 'voiceActivity': return speech.voiceActivity({ session: args.session, speaking: args.speaking, sinceSpeechMs: args.sinceSpeechMs });
      case 'voiceKnown': return speech.voiceKnown({ session: args.session });
      case 'voicePlayed': return speech.voicePlayed({ session: args.session, id: args.id, result: args.result, startedMs: args.startedMs, detail: args.detail, playback: args.playback });
      case 'voiceMissed': return speech.voiceMissed({ session: args.session, entry: args.entry, action: args.action });
      case 'voiceProgress': return speech.voiceProgress({ session: args.session, id: args.id, event: args.event, elapsedMs: args.elapsedMs, gate: args.gate, playback: args.playback });
      case 'voiceTimings': return speech.timings.list();
      case 'voiceVoices': return speech.voiceVoices();
      case 'voicePreview': return speech.voicePreview({ voiceId: args.voiceId });
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
    if (closing || !session || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://master.invalid');
    if (req.method === 'GET' && url.pathname === '/events') { lastRequest = Date.now(); events(res, url.searchParams.get('epoch') ?? '', Number(url.searchParams.get('after') ?? '-1')); return; }
    // Audio read aloud, streamed to the page through the web as it is made.
    const audio = /^\/audio\/((?:(?:clip|preview)-[a-f0-9]{64})|[0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && audio) {
      lastRequest = Date.now();
      const at = Number(url.searchParams.get('at') ?? '0');
      void voice!.serveAudio(audio[1], res, Number.isFinite(at) && at > 0 && at <= 1_200 ? at : 0).catch(() => { if (!res.headersSent) res.writeHead(500); res.destroy(); });
      return;
    }
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
      if (!['hello', 'ping', 'voiceActivity', 'voicePresence', 'presence'].includes(input.method)) lastRequest = Date.now();
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
  let stopKeeping: (() => Promise<void>) | undefined;
  const close = async (idle = false) => {
    if (closing) return;
    closing = true;
    await stopKeeping?.();
    if (idleTimer) clearInterval(idleTimer);
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(paths.socket).catch(() => {});
    await unlink(paths.token).catch(() => {});
    try { await voice?.close(); await session?.close(); await room.flush(); } finally {
      live.close();
      readDb?.close();
      await release();
      if (idle) options.onClosed?.();
    }
  };

  try {
    await settings.start();
    await room.start();
    session = new MasterSession({ stateDir: paths.stateDir, dataDir: paths.data, settings, tower, live, room, onChange: broadcastOverview, ...(options.followMs ? { followMs: options.followMs } : {}) });
    tools = new MasterTools({ tower, live, ...(readDb ? { readDb } : {}), broadcast: event => room.broadcast(event), started: (target, body, answer) => session!.started(target, body, answer), delegated: () => session!.delegatedTable() });
    const elevenLabs = new ElevenLabs({ key: () => settings.voiceKey(), ...options.voice?.elevenLabs });
    voice = new MasterVoice({ dataDir: paths.data, settings, room, elevenLabs, firstReply: options.voice?.firstReply ?? new FirstReplyMaker({ stateDir: paths.stateDir }), ...(options.voice?.timing ? { timing: options.voice.timing } : {}),
      hooks: { hide: text => text, connectedSince: () => tower.connectedSince(), send: input => session!.spoken({ text: input.text, key: input.voice.key, voiceSession: input.voice.session ?? '' }),
        streamState: (turn, state) => session!.voicedState(turn, state) } });
    session.setVoice(voice);
    await voice.start();
    await session.start();
    await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(paths.token).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, () => { server.off('error', reject); resolve(); }); });
    await chmod(paths.socket, 0o600);
    // The credential appears last: a web that can read it can already talk to this host.
    await writeFile(paths.token, token, { flag: 'wx', mode: 0o600 });
    stopKeeping = keepEndpoint({ socket: paths.socket, token: paths.token, value: token });
    idleTimer = setInterval(() => {
      // With a master session it stays, to report the work handed out whenever it ends.
      if (closing || pending || streams.size || settings.current().session || Date.now() - lastRequest < (options.idleMs ?? IDLE_MS)) return;
      void close(true).catch(error => { console.error(`Master host idle cleanup failed: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}`); });
    }, 1000);
    idleTimer.unref();
    return { socketPath: paths.socket, close, session, tools };
  } catch (error) { await close(); throw error; }
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
