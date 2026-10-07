import { lstat, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { APP_VERSION } from '../../shared/app-identity.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { playwrightMcp, playwrightMcpVersion, type BrowserTier } from './launch.js';
import { reapBrowsers } from './live.js';
import { TurnBrowser, type TurnBrowserHooks } from './turn-browser.js';

/** The strong-defense browser a turn has besides these two, if any (see tools.ts). */
export type StrongBrowser = 'aside' | 'claude-in-chrome';
/** `outsideContent`: the conversation holds outside content, so no saved logins, no way to this computer's own addresses. */
export interface BrowserServerOptions { tier: BrowserTier; stateDir: string; savedLogins: boolean; outsideContent: boolean; strong?: StrongBrowser }
/** Tools that would run code outside the browser, past its address guard; not offered where outside content is. */
const OUTSIDE_CONTENT_HIDDEN = new Set(['browser_run_code_unsafe']);


/** `<light|general> <stateDir> [--outside-content] [--strong aside|claude-in-chrome]` */
export function parseBrowserServerArgs(args: string[]): BrowserServerOptions {
  const [tier, stateDir, ...rest] = args;
  if ((tier !== 'light' && tier !== 'general') || !stateDir || !isAbsolute(stateDir)) throw new Error('Usage: <light|general> <state-dir> [--outside-content] [--strong aside|claude-in-chrome]');
  let outsideContent = false;
  let strong: StrongBrowser | undefined;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--outside-content') outsideContent = true;
    else if (rest[index] === '--strong' && (rest[index + 1] === 'aside' || rest[index + 1] === 'claude-in-chrome')) strong = rest[++index] as StrongBrowser;
    else throw new Error(`Unknown browser tool option: ${rest[index]}`);
  }
  return { tier, stateDir, savedLogins: tier === 'general' && !outsideContent, outsideContent, ...(strong ? { strong } : {}) };
}

/** What the agent reads about this browser: when to use it, nothing more. */
export function browserInstructions(options: BrowserServerOptions, outputDir: string): string {
  const strong = options.strong === 'aside' ? 'the `browser_strong` tools (Aside: a real person\'s browser with the owner\'s own logins)'
    : options.strong === 'claude-in-chrome' ? 'the `claude-in-chrome` tools (the owner\'s own Chrome and logins)' : undefined;
  const lines = options.tier === 'light' ? [
    'Browser for pages this project serves: localhost dev servers, preview deployments, checking a UI change, screenshots at desktop and mobile widths (browser_resize), console errors.',
    'A fresh browser for each turn, with no logins. For outside sites use the `browser` tools.',
  ] : [
    'Browser for outside sites: reading docs, news and product pages, research, comparing sources, sites you need to log in to. It looks like a regular Chrome to the sites.',
    options.savedLogins ? 'Logins made here are kept for later turns. When a login is needed, look for the credentials in Tower\'s vault or ask the owner; use your judgment.'
      : 'Logins are not kept in this conversation.',
    strong ? `If a site blocks this browser (CAPTCHA, "this browser may not be secure", a challenge page), switch to ${strong}.`
      : 'If a site blocks this browser (CAPTCHA, "this browser may not be secure", a challenge page), say so; there is no stronger browser on this computer.',
    'Never try to solve CAPTCHAs.',
  ];
  if (options.outsideContent) lines.push('This conversation holds outside content, so this computer\'s own addresses (localhost) are blocked here.');
  if (options.strong === 'claude-in-chrome') lines.push('In the owner\'s Chrome, close the tabs you opened with tabs_close_mcp before you finish; later turns cannot close them.');
  lines.push(`Tower closes this browser when your turn ends. Snapshots and screenshots are saved under ${outputDir}.`);
  return lines.join('\n');
}

interface Transport {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}
type Frame = { jsonrpc?: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const OUTPUT_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const CAPABILITIES = ['core'] as const;

export interface BrowserServerHooks extends Partial<TurnBrowserHooks> {
  createConnection?: typeof import('@playwright/mcp').createConnection;
  /** Signals that end the server; the real process's by default. */
  signals?: Pick<NodeJS.Process, 'once' | 'off'>;
  exit?: (code: number) => void;
}

/**
 * One turn's browser tool server: Playwright's MCP tools over stdio, on the turn's browser (turn-browser.ts), which
 * closes when the turn's provider closes this server's input or signals it. Playwright is loaded only when the agent
 * first uses a tool: until then this server answers `initialize` and `tools/list` itself (the list is kept per
 * Playwright MCP version), so a turn that never browses costs little. `browser_close` is Tower's: it saves the logins,
 * closes the browser and lets the next call start a new one.
 */
export async function startBrowserMcp(options: BrowserServerOptions, input: Readable = process.stdin, output: Writable = process.stdout, hooks: BrowserServerHooks = {}): Promise<void> {
  const log = (error: unknown) => { process.stderr.write(`Tower browser: ${error instanceof Error ? error.message : String(error)}\n`); };
  const outputDir = join(await outputRoot(log), `${options.tier}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  const ready = hooks.ready ?? reapBrowsers(options.stateDir).catch(error => { log(error); return 0; });
  const browser = new TurnBrowser(options, log, { ...hooks, ready });
  const write = (frame: Frame) => { output.write(JSON.stringify(frame) + '\n'); };
  const fail = (id: Frame['id'], message: string) => write({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message } });

  let clientInit: Record<string, unknown> | undefined;
  const pending = new Map<string, (frame: Frame) => void>();
  let ownIds = 0;
  const toolCalls = new Set<string | number>();
  let closeServer: (() => Promise<void>) | undefined;
  let playwright: Promise<Transport> | undefined;
  const ask = (transport: Transport, method: string, params: Record<string, unknown>) => new Promise<Frame>(resolve => {
    const id = `tower-${++ownIds}`;
    pending.set(id, resolve);
    transport.onmessage?.({ jsonrpc: '2.0', id, method, params });
  });
  const open = () => playwright ??= (async () => {
    const createConnection = hooks.createConnection ?? playwrightMcp().createConnection;
    const server = await createConnection({ capabilities: [...CAPABILITIES], outputDir, filePaths: 'absolute' }, () => browser.context());
    const transport: Transport = {
      async start() {},
      async send(message) {
        const frame = message as Frame;
        if (typeof frame.id === 'string' && !frame.method && pending.has(frame.id)) { pending.get(frame.id)!(frame); pending.delete(frame.id); return; }
        if (frame.id !== undefined && frame.id !== null && !frame.method && toolCalls.delete(frame.id)) browser.saveSoon();
        write(frame);
      },
      async close() { this.onclose?.(); },
    };
    await server.connect(transport as never);
    closeServer = () => server.close();
    await ask(transport, 'initialize', clientInit ?? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tower', version: APP_VERSION } });
    transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return transport;
  })();

  const toolsCache = join(options.stateDir, 'browser', `tools-${playwrightMcpVersion()}-${CAPABILITIES.join('-')}.json`);
  const toolList = async (): Promise<unknown[]> => {
    try {
      const cached = await readPrivateJson(toolsCache, 2_000_000);
      if (Array.isArray(cached)) return cached;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(error); }
    const reply = await ask(await open(), 'tools/list', {});
    const tools = reply.result?.tools;
    if (!Array.isArray(tools)) throw new Error('Playwright did not list its tools.');
    await mkdir(join(options.stateDir, 'browser'), { recursive: true, mode: 0o700 });
    await writePrivateJson(toolsCache, JSON.stringify(tools)).catch(log);
    return tools;
  };

  const handle = async (frame: Frame) => {
    const id = frame.id;
    const request = id !== undefined && id !== null && typeof frame.method === 'string';
    if (frame.method === 'initialize' && request) {
      clientInit = frame.params;
      const asked = String(frame.params?.protocolVersion ?? '');
      write({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : '2025-06-18', capabilities: { tools: { listChanged: true } },
        serverInfo: { name: `tower-browser-${options.tier}`, version: APP_VERSION }, instructions: browserInstructions(options, outputDir) } });
      return;
    }
    if (frame.method === 'notifications/initialized') return;
    if (frame.method === 'ping' && request) { write({ jsonrpc: '2.0', id, result: {} }); return; }
    if (frame.method === 'tools/list' && request) {
      try { write({ jsonrpc: '2.0', id, result: { tools: (await toolList()).filter(tool => !(options.outsideContent && OUTSIDE_CONTENT_HIDDEN.has((tool as { name?: string }).name ?? ''))) } }); } catch (error) { fail(id, error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (frame.method === 'tools/call' && request) {
      if (frame.params?.name === 'browser_close') {
        await browser.closeActive();
        write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Closed the browser. The next browser tool call starts a new one.' }] } });
        return;
      }
      if (options.outsideContent && OUTSIDE_CONTENT_HIDDEN.has(String(frame.params?.name))) {
        write({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `${String(frame.params?.name)} is not available in a conversation that holds outside content.` }] } });
        return;
      }
      toolCalls.add(id);
      try { (await open()).onmessage?.(frame); } catch (error) { toolCalls.delete(id); fail(id, error instanceof Error ? error.message : String(error)); }
      return;
    }
    // Anything else (cancellations, answers to Playwright's own requests, other methods) is Playwright's once it runs.
    if (playwright) { (await playwright).onmessage?.(frame); return; }
    if (request) write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  };

  let ended: Promise<void> | undefined;
  const shutdown = () => ended ??= (async () => {
    await browser.shutdown();
    // best-effort: the process exits right after; an unclean close changes nothing.
    await closeServer?.().catch(() => {});
  })();
  const signals = hooks.signals ?? process;
  const exit = hooks.exit ?? ((code: number) => process.exit(code));
  const onSignal = () => { void shutdown().finally(() => exit(0)); };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) signals.once(signal, onSignal);

  // Characters split across chunks are joined before decoding.
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  try {
    for await (const chunk of input) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 10_000_000) throw new Error('MCP input is too large.');
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let frame: Frame;
        try { frame = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
        // Not awaited: Playwright may ask the client something (roots) before it answers, and that answer comes through
        // this same loop. Frames for Playwright still reach it in order: each waits on the same `open()`.
        void handle(frame).catch(log);
      }
    }
  } finally {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) signals.off(signal, onSignal);
    await shutdown();
  }
}

/**
 * Where snapshots and screenshots go: an owner-only folder in the system's temporary directory, so other users of a
 * shared computer can neither read them nor prepare the folder. Anything older than a week is removed.
 */
async function outputRoot(log: (error: unknown) => void): Promise<string> {
  const root = join(tmpdir(), `tower-browser-${process.getuid?.() ?? 'user'}`);
  try {
    await mkdir(root, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const info = await lstat(root);
    if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error(`${root} is not this user's private folder.`);
  } catch (error) {
    log(error);
    return mkdtemp(join(tmpdir(), 'tower-browser-'));
  }
  const now = Date.now();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const path = join(root, name);
    // best-effort: an old folder that cannot be removed now is tried again by the next server.
    if (now - (await stat(path).then(info => info.mtimeMs, () => now)) > OUTPUT_KEPT_MS) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
  return root;
}
