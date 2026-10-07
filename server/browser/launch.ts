import { createRequire } from 'node:module';
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright';
import { isLoopbackHostname } from '../auth/store.js';

/**
 * How each browser tier starts. Both use the installed Chrome when there is one, Playwright's Chromium otherwise.
 * `light` checks pages this project serves and keeps Playwright's other defaults. `general` visits outside sites
 * without the switches and the user agent that mark an automated or headless browser, so ordinary bot checks see a
 * regular Chrome.
 */
export type BrowserTier = 'light' | 'general';

type Playwright = typeof import('playwright');
type PlaywrightMcp = typeof import('@playwright/mcp');
let mcp: PlaywrightMcp | undefined;
let loaded: Playwright | undefined;
/**
 * Loaded on first use only, so a turn that never browses never loads Playwright. Playwright comes from where
 * `@playwright/mcp` finds it: the exact version it was built with.
 */
export function playwrightMcp(): PlaywrightMcp { return mcp ??= createRequire(import.meta.url)('@playwright/mcp') as PlaywrightMcp; }
export function playwright(): Playwright {
  return loaded ??= createRequire(createRequire(import.meta.url).resolve('@playwright/mcp'))('playwright') as Playwright;
}
export function playwrightMcpVersion(): string {
  return (createRequire(import.meta.url)('@playwright/mcp/package.json') as { version: string }).version;
}

/**
 * Names that reach this computer itself never resolve in a browser of a conversation that holds outside content. The
 * browser's own resolver applies this to every request, redirects included, which Playwright's routes do not see.
 * It covers every form Tower's sign-in bypass accepts (isLoopbackHostname), IPv4-mapped IPv6 included.
 */
export const LOOPBACK_RESOLVER_RULES = '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP *.localhost ~NOTFOUND, MAP 127.* ~NOTFOUND, MAP 0.0.0.0 ~NOTFOUND, '
  + 'MAP [::1] ~NOTFOUND, MAP ::1 ~NOTFOUND, MAP [::] ~NOTFOUND, MAP [::ffff:*] ~NOTFOUND, MAP ::ffff:* ~NOTFOUND';

export function launchOptions(tier: BrowserTier, marker: string, channel: 'chrome' | undefined, outsideContent = false): LaunchOptions {
  // The tool server closes the browser itself, after reading the turn's logins; Playwright's own signal handlers would
  // close it first and lose them.
  const args = [marker, ...(outsideContent ? [LOOPBACK_RESOLVER_RULES] : [])];
  const common: LaunchOptions = { headless: true, args, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, ...(channel ? { channel } : {}) };
  if (tier === 'light') return common;
  return { ...common, args: [...args, '--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] };
}

/** The browser's own user agent, minus the word that gives a headless browser away. */
export function regularUserAgent(userAgent: string): string { return userAgent.replace(/HeadlessChrome\//g, 'Chrome/'); }

/** Starts the tier's browser: the installed Chrome first, Playwright's Chromium otherwise. Tower installs neither. */
export async function startBrowser(tier: BrowserTier, marker: string, options: { outsideContent?: boolean } = {}, chromium: Pick<Playwright['chromium'], 'launch'> = playwright().chromium): Promise<{ browser: Browser }> {
  try { return { browser: await chromium.launch(launchOptions(tier, marker, 'chrome', options.outsideContent)) }; }
  catch (error) { if (!missingBrowser(error)) throw error; }
  try { return { browser: await chromium.launch(launchOptions(tier, marker, undefined, options.outsideContent)) }; }
  catch (error) {
    if (!missingBrowser(error)) throw error;
    throw new Error('No browser is installed on this computer: neither Google Chrome nor Playwright\'s Chromium. '
      + 'Install one if this computer may have it, for example `npx playwright install chromium` '
      + '(on Linux, `sudo npx playwright install-deps chromium` adds the system libraries). Tower installs none itself.');
  }
}

/**
 * The context a turn works in; `general` gets a regular user agent and the saved logins it is given. In a conversation
 * that holds outside content, nothing reaches this computer's own addresses: Tower lets a direct localhost request in
 * without signing in, and the agent there must not act as the owner (see isLoopbackHostname).
 */
export async function newContext(tier: BrowserTier, browser: Browser, options: { storageState?: BrowserContextOptions['storageState']; outsideContent?: boolean } = {}): Promise<BrowserContext> {
  const guarded: BrowserContextOptions = options.outsideContent ? { serviceWorkers: 'block' } : {};
  let context: BrowserContext;
  if (tier === 'light') context = await browser.newContext(guarded);
  else {
    const session = await browser.newBrowserCDPSession();
    const { userAgent } = await session.send('Browser.getVersion') as { userAgent: string };
    // best-effort: the session was only needed for the version; the browser drops it with the context anyway.
    await session.detach().catch(() => {});
    context = await browser.newContext({ ...guarded, userAgent: regularUserAgent(userAgent), ...(options.storageState ? { storageState: options.storageState } : {}) });
  }
  if (options.outsideContent) {
    // Direct requests get a clear answer here (an aborted navigation's error page would cut into the agent's next one);
    // redirects never come through routes, and the resolver rules above stop those.
    await context.route(url => isLoopbackHostname(url.hostname), route => route.fulfill({ status: 403, contentType: 'text/plain; charset=utf-8',
      body: 'Tower blocks this computer\'s own addresses in a conversation that holds outside content.' }));
    await context.routeWebSocket(url => isLoopbackHostname(url.hostname), socket => socket.close());
  }
  return context;
}

export function missingBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /is not found|Executable doesn't exist|Looks like Playwright|not installed/i.test(message);
}
