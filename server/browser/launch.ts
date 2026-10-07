import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright';

/**
 * How each browser tier starts. `light` checks pages this project serves: Playwright's defaults, nothing kept.
 * `general` visits outside sites: real Chrome when it is installed, without the switches and the user agent that mark an
 * automated or headless browser, so ordinary bot checks see a regular Chrome.
 */
export type BrowserTier = 'light' | 'general';

type Playwright = typeof import('playwright');
const require = createRequire(import.meta.url);
let loaded: Playwright | undefined;
/** Loaded on first use only, so no other part of Tower ever loads Playwright. */
export function playwright(): Playwright { return loaded ??= require('playwright') as Playwright; }

export function launchOptions(tier: BrowserTier, marker: string, channel: 'chrome' | undefined): LaunchOptions {
  const common: LaunchOptions = { headless: true, args: [marker], ...(channel ? { channel } : {}) };
  if (tier === 'light') return common;
  return { ...common, args: [marker, '--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] };
}

/** The browser's own user agent, minus the word that gives a headless browser away. */
export function regularUserAgent(userAgent: string): string { return userAgent.replace(/HeadlessChrome\//g, 'Chrome/'); }

/**
 * Starts the tier's browser: installed Chrome first, Playwright's Chromium otherwise, installing it once when neither
 * is there. Answers which one started, for the agent's instructions and errors.
 */
export async function startBrowser(tier: BrowserTier, marker: string, options: { install?: () => Promise<void> } = {}): Promise<{ browser: Browser; kind: 'chrome' | 'chromium' }> {
  const { chromium } = playwright();
  try { return { browser: await chromium.launch(launchOptions(tier, marker, 'chrome')), kind: 'chrome' }; }
  catch (error) { if (!missingBrowser(error)) throw error; }
  try { return { browser: await chromium.launch(launchOptions(tier, marker, undefined)), kind: 'chromium' }; }
  catch (error) { if (!missingBrowser(error)) throw error; }
  await (options.install ?? installChromium)();
  return { browser: await chromium.launch(launchOptions(tier, marker, undefined)), kind: 'chromium' };
}

/** The context a turn works in; `general` gets a regular user agent and the saved logins it is given. */
export async function newContext(tier: BrowserTier, browser: Browser, storageState?: BrowserContextOptions['storageState']): Promise<BrowserContext> {
  if (tier === 'light') return browser.newContext();
  const session = await browser.newBrowserCDPSession();
  const { userAgent } = await session.send('Browser.getVersion') as { userAgent: string };
  // best-effort: the session was only needed for the version; the browser drops it with the context anyway.
  await session.detach().catch(() => {});
  return browser.newContext({ userAgent: regularUserAgent(userAgent), ...(storageState ? { storageState } : {}) });
}

function missingBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /is not found|Executable doesn't exist|Looks like Playwright|not installed/i.test(message);
}

/** Playwright's own installer for Chromium, as `npx playwright install chromium` would run it. */
export async function installChromium(): Promise<void> {
  const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  const output: string[] = [];
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => output.push(String(chunk)));
    child.stderr.on('data', chunk => output.push(String(chunk)));
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) throw new Error(`No browser is installed and installing Chromium failed: ${output.join('').trim().slice(-1500)}\n`
    + 'On Linux, missing system libraries need `sudo npx playwright install-deps chromium`; Tower never runs sudo.');
}
