import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isSea } from 'node:sea';
import type { Provider } from '../../shared/types.js';
import { providerDirectories } from '../providers/discovery.js';
import type { SessionMcpServer, SessionMcpServers } from '../runs/session-mcp.js';
import type { StrongBrowser } from './server.js';

/**
 * Which browsers a turn gets. Every turn gets `browser_light` and `browser`; the strong-defense browser acts with the
 * owner's real accounts, so a conversation that holds outside content gets neither it nor the saved logins.
 * The strong browser is Aside when its CLI is installed, otherwise Claude in Chrome for Claude turns when its
 * extension is set up; Codex has no other.
 */
export interface BrowserTools { servers: SessionMcpServers; claudeChrome: boolean }

export interface BrowserEnvironment {
  /** Whether this build can start the Playwright tool servers (not the standalone executable, package installed). */
  playwright: boolean;
  aside?: string;
  claudeInChrome: boolean;
}

export function browserTools(entry: { command: string; args: string[] }, stateDir: string, provider: Provider, outsideContent: boolean, environment: BrowserEnvironment = browserEnvironment()): BrowserTools {
  const strong: StrongBrowser | undefined = outsideContent ? undefined
    : environment.aside ? 'aside' : provider === 'claude' && environment.claudeInChrome ? 'claude-in-chrome' : undefined;
  const servers: SessionMcpServers = {};
  if (environment.playwright) {
    const server = (tier: 'light' | 'general'): SessionMcpServer => ({ command: entry.command, args: [...browserEntry(entry.args), tier, stateDir,
      ...(outsideContent ? ['--outside-content'] : []), ...(strong ? ['--strong', strong] : [])] });
    servers.browser_light = server('light');
    servers.browser = server('general');
  }
  if (strong === 'aside') servers.browser_strong = { command: environment.aside!, args: ['mcp'] };
  return { servers, claudeChrome: strong === 'claude-in-chrome' };
}

/**
 * The line every turn's Tower instructions carry about its browsers. Codex sees a server's own instructions only once
 * it has looked the tools up, and otherwise reaches for its computer-use browser first.
 */
export function browserNote(tools: BrowserTools): string | undefined {
  const uses = [
    tools.servers.browser_light && '`browser_light` for pages this project serves (localhost, previews, UI checks)',
    tools.servers.browser && '`browser` for outside sites',
    tools.servers.browser_strong ? '`browser_strong` (Aside, the owner\'s own logins) when a site blocks `browser`'
      : tools.claudeChrome ? '`claude-in-chrome` (the owner\'s own Chrome) when a site blocks `browser`; close the tabs you open there' : undefined,
  ].filter(Boolean);
  if (!uses.length) return undefined;
  return `Browser tools for this turn (use them for web pages rather than computer use; look them up with your tool search if they are not listed yet): ${uses.join('; ')}.`;
}

/** This build's browser entry beside its main entry (the last argument), with the same Node options. */
function browserEntry(args: string[]): string[] {
  const main = args.at(-1)!;
  return [...args.slice(0, -1), join(dirname(main), 'browser', basename(main).replace(/^index\./, 'entry.'))];
}

/** Looked up at each turn: cheap file checks, so installing Aside or the extension takes effect on the next turn. */
export function browserEnvironment(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): BrowserEnvironment {
  return { playwright: playwrightInstalled(), aside: findAside(env), claudeInChrome: claudeInChromeManifests(home, platform).some(path => existsSync(path)) };
}

let installed: boolean | undefined;
function playwrightInstalled(): boolean {
  if (isSea()) return false;
  try { installed ??= Boolean(createRequire(import.meta.url).resolve('@playwright/mcp')); } catch { installed = false; }
  return installed;
}

function findAside(env: NodeJS.ProcessEnv): string | undefined {
  for (const directory of providerDirectories(env)) {
    const candidate = join(directory, 'aside');
    // best-effort: a directory without an executable `aside` is simply not where it is.
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* Not here. */ }
  }
  return undefined;
}

/** Where Claude Code installs the Claude in Chrome native-messaging host for each Chromium browser it supports. */
export function claudeInChromeManifests(home: string, platform: NodeJS.Platform): string[] {
  const file = join('NativeMessagingHosts', 'com.anthropic.claude_code_browser_extension.json');
  const browsers = platform === 'darwin'
    ? ['Google/Chrome', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Chromium'].map(name => join(home, 'Library', 'Application Support', name))
    : platform === 'linux' ? ['google-chrome', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'chromium'].map(name => join(home, '.config', name)) : [];
  return browsers.map(directory => join(directory, file));
}
