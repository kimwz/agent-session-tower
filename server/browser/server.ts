import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { BrowserTier } from './launch.js';
import { reapBrowsers } from './live.js';
import { TurnBrowser, type TurnBrowserHooks } from './turn-browser.js';

/** The strong-defense browser a turn has besides these two, if any (see tools.ts). */
export type StrongBrowser = 'aside' | 'claude-in-chrome';
export interface BrowserServerOptions { tier: BrowserTier; stateDir: string; savedLogins: boolean; strong?: StrongBrowser }


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
 * One turn's browser tool server: Playwright's MCP tools over stdio, on the turn's browser (turn-browser.ts), which
 * closes when the turn's provider closes this server's input or signals it.
 */
export async function startBrowserMcp(options: BrowserServerOptions, input: Readable = process.stdin, output: Writable = process.stdout, hooks: Partial<TurnBrowserHooks> = {}): Promise<void> {
  const outputDir = join(tmpdir(), 'tower-browser', `${options.tier}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  const log = (error: unknown) => { process.stderr.write(`Tower browser: ${error instanceof Error ? error.message : String(error)}\n`); };
  const ready = hooks.ready ?? reapBrowsers(options.stateDir).catch(error => { log(error); return 0; });
  const browser = new TurnBrowser(options, log, { ...hooks, ready });

  const require = createRequire(import.meta.url);
  const { createConnection } = require('@playwright/mcp') as typeof import('@playwright/mcp');
  const server = await createConnection({ capabilities: ['core'], outputDir, filePaths: 'absolute' }, () => browser.context());
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

  let ended: Promise<void> | undefined;
  const shutdown = () => ended ??= (async () => {
    await browser.shutdown();
    // best-effort: the process exits right after; an unclean close changes nothing.
    await server.close().catch(() => {});
  })();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });

  let buffer = '';
  try {
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
        if (frame.method === 'tools/call') queueMicrotask(() => browser.scheduleSave());
        transport.onmessage?.(frame);
      }
    }
  } finally { await shutdown(); }
}
