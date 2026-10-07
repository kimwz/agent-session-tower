import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { Browser, BrowserContext } from 'playwright';
import { newContext, startBrowser, type BrowserTier } from './launch.js';
import { findBrowserPid, forgetBrowser, markerSwitch, reapBrowsers, recordBrowser } from './live.js';
import { EMPTY_STATE, readState, saveChanges, type StorageState } from './logins.js';

/** The strong-defense browser a turn has besides these two, if any (see tools.ts). */
export type StrongBrowser = 'aside' | 'claude-in-chrome';
export interface BrowserServerOptions { tier: BrowserTier; stateDir: string; savedLogins: boolean; strong?: StrongBrowser }

const SAVE_DELAY_MS = 2_000;
const CLOSE_TIMEOUT_MS = 5_000;

/** `--browser-mcp <light|general> <stateDir> [--no-saved-logins] [--strong aside|claude-in-chrome]` */
export function parseBrowserServerArgs(args: string[]): BrowserServerOptions {
  const [tier, stateDir, ...rest] = args;
  if ((tier !== 'light' && tier !== 'general') || !stateDir || !isAbsolute(stateDir)) throw new Error('Usage: --browser-mcp <light|general> <state-dir> [--no-saved-logins] [--strong aside|claude-in-chrome]');
  let savedLogins = tier === 'general';
  let strong: StrongBrowser | undefined;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--no-saved-logins') savedLogins = false;
    else if (rest[index] === '--strong' && (rest[index + 1] === 'aside' || rest[index + 1] === 'claude-in-chrome')) strong = rest[++index] as StrongBrowser;
    else throw new Error(`Unknown browser tool option: ${rest[index]}`);
  }
  return { tier, stateDir, savedLogins, ...(strong ? { strong } : {}) };
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

/**
 * One turn's browser tool server: Playwright's MCP tools over stdio, on a browser this process starts on first use and
 * closes when the turn's provider closes its input or signals it. The `general` tier adds what the turn changed in its
 * logins to the saved ones, after tool calls and once more at the end.
 */
export async function startBrowserMcp(options: BrowserServerOptions, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const outputDir = join(tmpdir(), 'tower-browser', `${options.tier}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  const log = (error: unknown) => { process.stderr.write(`Tower browser: ${error instanceof Error ? error.message : String(error)}\n`); };
  const reaped = reapBrowsers(options.stateDir).catch(error => { log(error); return 0; });
  let active: { browser: Browser; context: BrowserContext } | undefined;
  let baseline: StorageState = EMPTY_STATE;
  let saving: Promise<void> = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const closeBrowser = async (current: { browser: Browser; context: BrowserContext }) => {
    if (active === current) active = undefined;
    // best-effort: a browser that will not close is ended by the next reaper once this process is gone.
    await Promise.race([current.browser.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref())]);
    await forgetBrowser(options.stateDir, process.pid);
  };

  const save = (state: StorageState) => {
    const from = baseline;
    baseline = state;
    saving = saving.then(() => saveChanges(options.stateDir, from, state)).catch(log);
    return saving;
  };
  const scheduleSave = () => {
    if (!options.savedLogins || !active) return;
    clearTimeout(saveTimer);
    // best-effort: a context closed meanwhile was saved by its own shutdown.
    saveTimer = setTimeout(() => { const context = active?.context; if (context) void context.storageState().then(state => save(state as StorageState), () => {}); }, SAVE_DELAY_MS);
  };

  const contextGetter = async (): Promise<BrowserContext> => {
    if (finished) throw new Error('This turn has ended.');
    if (active) return active.context;
    await reaped;
    const marker = randomBytes(16).toString('hex');
    const { browser } = await startBrowser(options.tier, markerSwitch(marker));
    const browserPid = await findBrowserPid(marker);
    if (browserPid) await recordBrowser(options.stateDir, { serverPid: process.pid, browserPid, marker, startedAt: new Date().toISOString() });
    if (options.savedLogins) baseline = await readState(options.stateDir);
    const context = await newContext(options.tier, browser, options.savedLogins ? baseline : undefined);
    const current = { browser, context };
    active = current;
    // The agent may close the browser itself; the next tool call starts a new one.
    context.on('close', () => { void closeBrowser(current); });
    return context;
  };

  const require = createRequire(import.meta.url);
  const { createConnection } = require('@playwright/mcp') as typeof import('@playwright/mcp');
  const server = await createConnection({ capabilities: ['core'], outputDir, filePaths: 'absolute' }, contextGetter);
  const pendingInitialize = new Set<string | number>();
  const write = (message: unknown) => { output.write(JSON.stringify(message) + '\n'); };
  const transport: Transport = {
    async start() {},
    async send(message) {
      const frame = message as { id?: string | number; result?: Record<string, unknown> };
      if (frame.id !== undefined && pendingInitialize.delete(frame.id) && frame.result) frame.result = { ...frame.result, instructions: browserInstructions(options, outputDir) };
      write(frame);
    },
    async close() { this.onclose?.(); },
  };
  await server.connect(transport as never);

  const shutdown = async () => {
    if (finished) return;
    finished = true;
    clearTimeout(saveTimer);
    const current = active;
    let state: StorageState | undefined;
    if (current) {
      try { if (options.savedLogins) state = await current.context.storageState() as StorageState; }
      // best-effort: the browser is already gone; nothing more to save.
      catch { /* See above. */ }
      finally { await closeBrowser(current); }
    }
    await saving;
    if (state) await save(state);
    // best-effort: the process exits right after; an unclean close changes nothing.
    await server.close().catch(() => {});
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });

  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer) > 10_000_000) throw new Error('MCP input is too large.');
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let frame: { id?: string | number; method?: string };
      try { frame = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
      if (frame.method === 'initialize' && frame.id !== undefined) pendingInitialize.add(frame.id);
      if (frame.method === 'tools/call') queueMicrotask(scheduleSave);
      transport.onmessage?.(frame);
    }
  }
  await shutdown();
}
