import { finishedSlackDelegatedSessionIds } from '../../shared/slack-delegated-sessions.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import type { AutoPromptRequest, CreateSessionRequest, MessageAttachments, RunApprovalResponse, Snapshot } from '../../shared/types.js';
import { APP_VERSION } from '../../shared/app-identity.js';
import { AutoPromptManager } from '../auto-prompt/manager.js';
import { SlackService } from '../slack/service.js';
import { acquireStateLock, MonitorAlreadyRunning } from '../instance/state-lock.js';
import { getProviderHealth } from '../providers/discovery.js';
import { trustWorkspace } from '../providers/workspace-trust.js';
import { SessionService } from '../sessions/service.js';
import { projectSessionStates } from '../sessions/snapshot.js';
import { ClosedSessionStore } from '../stores/closed-sessions.js';
import { ProjectGroupStore } from '../stores/project-groups.js';
import { WorkspaceTerminals } from '../workspace-terminals.js';
import { SessionTitleStore } from '../stores/session-titles.js';
import { openCodexBridgeRun } from './codex-bridge.js';
import { RunManager, type RunAdmission } from './manager.js';
import { MAX_RPC_BYTES, RUNNER_PROTOCOL, runnerPaths, type RunnerReply, type RunnerSnapshot } from './runner-protocol.js';

const SNAPSHOT_FREE_OPERATIONS = new Set(['terminalInput', 'terminalResize', 'terminalCreate', 'terminalClose', 'attachment']);

export interface RunnerHostOptions {
  stateDir: string;
  runs: RunManager;
  sessions: SessionService;
  autoPrompts?: AutoPromptManager;
  slack?: SlackService;
  terminals?: WorkspaceTerminals;
  idleMs?: number;
  onIdle?: () => void | Promise<void>;
  /** Startup owns this lock before loading any engine state. */
  releaseStateLock?: () => Promise<void>;
}

/** Hosts an already-started engine, including one adopted during an in-place upgrade. */
export async function startRunnerHost(options: RunnerHostOptions) {
  options.runs.setSessionMcpResolver(id => options.slack?.sessionMcp(id));
  const paths = await runnerPaths(options.stateDir);
  const release = options.releaseStateLock ?? await acquireStateLock(paths.runtime, 0);
  let context: Awaited<ReturnType<typeof runnerContext>> | undefined;
  try {
    if (options.autoPrompts) { context = await runnerContext(options); options.autoPrompts.updateContext(context); }
  } catch (error) { await release(); throw error; }
  const instance = randomUUID();
  const token = randomBytes(32).toString('hex');
  let revision = 1;
  let lastRequest = Date.now();
  let pending = 0;
  let closing = false;
  const changed = () => { revision++; };
  const snapshot = (): RunnerSnapshot => {
    const sessions = options.runs.sessionList(options.sessions.list());
    return { instance, revision: ++revision, runs: options.runs.list(), sessions,
      nativeIds: Object.fromEntries(sessions.map(session => [session.id, options.runs.nativeSessionId(session.id)])),
      settled: [...options.runs.settledRunIds()], autoPrompts: options.autoPrompts?.list() ?? [] };
  };
  // Explicit dispatch prevents access to prototype methods or lifecycle controls.
  const dispatch = async (method: string, args: unknown[]) => {
    switch (method) {
      case 'snapshot': return undefined;
      case 'create': return options.runs.create(args[0] as CreateSessionRequest, admission(args[1]));
      case 'enqueue': {
        const admitted = admission(args[3]);
        const prompt = options.slack && !admitted.autoPromptId
          ? await options.slack.ownerChat(args[0] as string, args[1] as string) : args[1] as string;
        return options.runs.enqueue(args[0] as string, prompt, args[2] as MessageAttachments, admitted);
      }
      case 'steer': return options.runs.steer(args[0] as string);
      case 'cancel': return options.runs.cancel(args[0] as string);
      case 'respondToApproval': return options.runs.respondToApproval(args[0] as string, args[1] as string, args[2] as RunApprovalResponse);
      case 'attachment': {
        const attachment = await options.runs.attachment(args[0] as string);
        return { metadata: attachment.metadata, content: attachment.content.toString('base64') };
      }
      case 'terminalCreate': if (options.terminals) return options.terminals.create(args[0] as string, args[1], args[2]); break;
      case 'terminalInput': if (options.terminals) return options.terminals.input(args[0] as string, args[1]); break;
      case 'terminalResize': if (options.terminals) return options.terminals.resize(args[0] as string, args[1], args[2]); break;
      case 'terminalClose': if (options.terminals) return options.terminals.close(args[0] as string); break;
      case 'submitAutoPrompt': if (options.autoPrompts) { await context?.refresh(); return options.autoPrompts.submit(args[0] as AutoPromptRequest); } break;
      case 'cancelAutoPrompt': if (options.autoPrompts) return options.autoPrompts.cancel(args[0] as string); break;
      case 'slackOverview': if (options.slack) return options.slack.overview(); break;
      case 'slackMutate': if (options.slack) return options.slack.mutate(args[0] as string, args[1] as Record<string, unknown>); break;
      case 'slackTool': if (options.slack) return options.slack.tool(args[0] as string, args[1] as string, args[2] as Record<string, unknown>); break;
    }
    throw Object.assign(new Error('Unknown runner operation.'), { statusCode: 400 });
  };
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (closing || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403); res.end(); return;
    }
    const terminalMatch = req.url?.match(/^\/terminals\/([0-9a-f-]{36})\/events$/);
    if (req.method === 'GET' && terminalMatch && options.terminals && req.headers['x-runner-instance'] === instance) {
      const cursor = req.headers['last-event-id'];
      try {
        if (Array.isArray(cursor)) throw Object.assign(new Error('Invalid terminal cursor.'), { statusCode: 400 });
        options.terminals.attach(terminalMatch[1], res, cursor);
      } catch (error) { res.writeHead((error as { statusCode?: number }).statusCode || 500); res.end(); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404); res.end(); return; }
    lastRequest = Date.now(); pending++;
    const reply: RunnerReply = { protocol: RUNNER_PROTOCOL, stateDir: paths.stateDir, instance };
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_RPC_BYTES) throw Object.assign(new Error('Runner request too large.'), { statusCode: 413 });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { protocol?: number; method?: string; args?: unknown[]; instance?: string; revision?: number };
      if (input.protocol !== RUNNER_PROTOCOL || typeof input.method !== 'string' || !Array.isArray(input.args) || (input.instance && input.instance !== instance)) {
        throw Object.assign(new Error('Incompatible runner request.'), { statusCode: 409 });
      }
      reply.result = await dispatch(input.method, input.args);
      // Keystrokes, resizes and attachment downloads do not change run state.
      // Keep their replies small; the regular snapshot poll publishes engine changes.
      if (input.method !== 'slackTool' && (input.instance !== instance || (input.method === 'snapshot' ? input.revision !== revision : !SNAPSHOT_FREE_OPERATIONS.has(input.method)))) reply.snapshot = snapshot();
    } catch (error) {
      const value = error as { message?: string; statusCode?: number; disposition?: string };
      reply.error = { message: value.message ?? 'Runner operation failed.', statusCode: value.statusCode ?? 500, ...(value.disposition ? { disposition: value.disposition } : {}) };
      reply.snapshot = snapshot();
    } finally { pending--; }
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)); }
  });
  server.requestTimeout = 65_000;
  options.runs.on('change', changed);
  options.sessions.on('change', changed);
  options.autoPrompts?.on('change', changed);
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const close = async (idle = false) => {
    if (closing) return;
    closing = true;
    if (idleTimer) clearInterval(idleTimer);
    options.runs.off('change', changed); options.sessions.off('change', changed); options.autoPrompts?.off('change', changed);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(paths.socket).catch(() => {});
    try { if (idle) await options.onIdle?.(); } finally { await release(); }
  };
  try {
    await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(paths.token).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await writeFile(paths.token, token, { flag: 'wx', mode: 0o600 });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, () => { server.off('error', reject); resolve(); }); });
    await chmod(paths.socket, 0o600);
    if (options.onIdle) {
      idleTimer = setInterval(() => {
        if (closing || pending || Date.now() - lastRequest < (options.idleMs ?? 30_000)) return;
        if (options.runs.list().some(run => run.status === 'running' || run.status === 'queued')) return;
        if (options.autoPrompts?.list().some(job => !['completed', 'error', 'cancelled'].includes(job.status))) return;
        if (options.terminals?.hasActive()) return;
        if (options.slack?.hasActive()) return;
        // Stop accepting requests and finish writes before releasing the worker lock.
        void close(true).catch(error => { console.error('Runner idle cleanup failed:', error); });
      }, 1000);
      idleTimer.unref();
    }
    return { instance, socketPath: paths.socket, close };
  } catch (error) { await close(); throw error; }
}

function admission(value: unknown): RunAdmission {
  if (!value || typeof value !== 'object') return {};
  return { autoPromptId: (value as { autoPromptId?: string }).autoPromptId };
}

async function runnerContext({ stateDir, runs, sessions, slack }: Pick<RunnerHostOptions, 'stateDir' | 'runs' | 'sessions' | 'slack'>) {
  let titles = new SessionTitleStore(stateDir);
  let closed = new ClosedSessionStore(stateDir);
  let groups = new ProjectGroupStore(stateDir);
  const metadata = async () => {
    const nextTitles = new SessionTitleStore(stateDir), nextClosed = new ClosedSessionStore(stateDir), nextGroups = new ProjectGroupStore(stateDir);
    await Promise.all([nextTitles.start(), nextClosed.start(), nextGroups.start()]);
    titles = nextTitles; closed = nextClosed; groups = nextGroups;
  };
  await metadata();
  const providers = await getProviderHealth();
  const visibleSessions = () => {
    const projected = projectSessionStates(runs.sessionList(sessions.list()), runs.list(), runs.settledRunIds());
    const finished = finishedSlackDelegatedSessionIds(slack?.automation.list() ?? [], projected, runs.list());
    return projected.filter(session => !finished.has(session.id) && !slack?.coordinatorSessionIds().includes(session.id)).map(session => closed.apply(titles.apply(session)));
  };
  const snapshot = (): Snapshot => ({ sessions: visibleSessions(),
    runs: runs.list(), groups: groups.list(), providers, scanning: false, hostname: hostname(), version: APP_VERSION, updatedAt: new Date().toISOString() });
  return { snapshot,
    refresh: async () => { await Promise.all([sessions.refresh(true), metadata()]); },
    detail: async (id: string) => { const session = runs.getSession(id); if (!session) return undefined; const history = await sessions.detail(runs.nativeSessionId(id)); return { ...(history ?? { messages: [], hasMore: false }), session: closed.apply(titles.apply(session)) }; },
  };
}

export async function runRunnerWorker(stateDir: string): Promise<void> {
  const paths = await runnerPaths(stateDir);
  let release: () => Promise<void>;
  try { release = await acquireStateLock(paths.runtime, 0); }
  catch (error) { if (error instanceof MonitorAlreadyRunning) return; throw error; }
  const sessions = new SessionService();
  const terminals = new WorkspaceTerminals({ keepAliveOnDisconnect: true });
  const runs = new RunManager({ stateDir, getSession: id => sessions.get(id), refreshSessions: () => sessions.refresh(true),
    openCodexBridge: options => openCodexBridgeRun({ ...options, codexHome: sessions.codexHome }), trustWorkspace });
  try {
    await sessions.start();
    await runs.start();
    const context = await runnerContext({ stateDir, runs, sessions });
    const autoPrompts = new AutoPromptManager({ stateDir, runs, ...context });
    await autoPrompts.start();
    const slack = new SlackService({ stateDir, runs, autoPrompts, refresh: context.refresh });
    runs.setSessionMcpResolver(id => slack.sessionMcp(id));
    autoPrompts.updateContext(await runnerContext({ stateDir, runs, sessions, slack }));
    await slack.start();
    await startRunnerHost({ stateDir, sessions, runs, autoPrompts, terminals, slack, releaseStateLock: release,
      onIdle: async () => { slack.close(); sessions.stop(); terminals.dispose(); await autoPrompts.close(); await runs.close(); } });
    // A parent terminal or Tower shutdown must not interrupt provider work.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
  } catch (error) { sessions.stop(); await release(); throw error; }
}
