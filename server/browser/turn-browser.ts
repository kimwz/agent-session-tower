import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext } from 'playwright';
import { newContext, startBrowser, type BrowserTier } from './launch.js';
import { findBrowserPid, forgetBrowser, markerSwitch, recordBrowser, stillRunning, systemProbe, type ProcessProbe } from './live.js';
import { EMPTY_STATE, LoginSaver, readState, type StorageState } from './logins.js';

export interface TurnBrowserOptions { tier: BrowserTier; stateDir: string; savedLogins: boolean }

/** What starts and finds a browser; tests replace these. */
export interface TurnBrowserHooks {
  startBrowser(tier: BrowserTier, marker: string): Promise<{ browser: Browser }>;
  newContext(tier: BrowserTier, browser: Browser, storageState?: StorageState): Promise<BrowserContext>;
  findBrowserPid(marker: string): Promise<number | undefined>;
  probe: ProcessProbe;
  /** Settles before the first browser starts: leftovers of killed servers are ended first. */
  ready?: Promise<unknown>;
  closeTimeoutMs?: number;
  stateTimeoutMs?: number;
  saveDelayMs?: number;
  saveWaitMs?: number;
  goneWaitMs?: number;
}

const DEFAULT_HOOKS: TurnBrowserHooks = { startBrowser, newContext, findBrowserPid, probe: systemProbe };

interface Live { browser: Browser; marker: string; browserPid?: number; context?: BrowserContext }

/**
 * The browser of one turn's tool server. It starts on first use; every browser it starts is tracked from the moment it
 * runs, closed when it fails to set up and when the turn ends, and its record is dropped only once it is confirmed gone,
 * so a browser that would not close is still found by the next server's reaper.
 */
export class TurnBrowser {
  private readonly hooks: TurnBrowserHooks;
  private readonly tracked = new Set<Live>();
  private readonly logins: LoginSaver;
  private active: Live | undefined;
  private starting: Promise<BrowserContext> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private finished = false;

  constructor(private readonly options: TurnBrowserOptions, private readonly log: (error: unknown) => void, hooks: Partial<TurnBrowserHooks> = {}) {
    this.hooks = { ...DEFAULT_HOOKS, ...hooks };
    this.logins = new LoginSaver(options.stateDir, log, { waitMs: this.hooks.saveWaitMs });
  }

  /** The context Playwright's tools work in; a new browser when there is none (or the agent closed it). */
  context(): Promise<BrowserContext> {
    if (this.finished) return Promise.reject(new Error('This turn has ended.'));
    if (this.active?.context) return Promise.resolve(this.active.context);
    return this.starting ??= this.start().finally(() => { this.starting = undefined; });
  }

  private async start(): Promise<BrowserContext> {
    await this.hooks.ready;
    const marker = randomBytes(16).toString('hex');
    const { browser } = await this.hooks.startBrowser(this.options.tier, markerSwitch(marker));
    const live: Live = { browser, marker };
    this.tracked.add(live);
    try {
      live.browserPid = await this.hooks.findBrowserPid(marker);
      if (live.browserPid) await recordBrowser(this.options.stateDir, { serverPid: process.pid, browserPid: live.browserPid, marker, startedAt: new Date().toISOString() });
      if (this.finished) throw new Error('This turn has ended.');
      const loaded = this.options.savedLogins ? await readState(this.options.stateDir) : undefined;
      const context = await this.hooks.newContext(this.options.tier, browser, loaded);
      live.context = context;
      this.logins.started(loaded ?? EMPTY_STATE);
      this.active = live;
      // The agent may close the browser itself; the next tool call starts a new one.
      context.on('close', () => { if (this.active === live) this.active = undefined; void this.close(live); });
      return context;
    } catch (error) {
      await this.close(live);
      throw error;
    }
  }

  /** After a tool call: the logins it changed are saved a moment later, once calls pause. */
  scheduleSave(): void {
    if (!this.options.savedLogins || this.finished) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const context = this.active?.context;
      // best-effort: a context closed meanwhile is saved by the turn's shutdown, or was the agent's to close.
      if (context) void context.storageState().then(state => this.logins.save(state as StorageState), () => {});
    }, this.hooks.saveDelayMs ?? 2_000);
  }

  /**
   * The turn ended: read the logins (briefly — Codex follows its SIGTERM with SIGKILL two seconds later), close every
   * browser, then save. A failed save never keeps a browser open.
   */
  async shutdown(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.saveTimer);
    const timeout = <T>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), this.hooks.stateTimeoutMs ?? 1_000).unref())]);
    // best-effort: a browser still setting up is closed below either way.
    if (this.starting) await timeout(this.starting).catch(() => undefined);
    let state: StorageState | undefined;
    const context = this.active?.context;
    if (context && this.options.savedLogins) {
      try { state = await timeout(context.storageState() as Promise<StorageState>); }
      catch (error) { this.log(new Error(`This turn's logins could not be read before closing: ${error instanceof Error ? error.message : String(error)}`)); }
    }
    await Promise.all([...this.tracked].map(live => this.close(live)));
    await this.logins.idle();
    if (state) await this.logins.save(state);
  }

  private async close(live: Live): Promise<void> {
    if (this.active === live) this.active = undefined;
    // best-effort: whether it closed is checked below by its process.
    await Promise.race([live.browser.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, this.hooks.closeTimeoutMs ?? 5_000).unref())]);
    if (live.browserPid && await this.stillRunningAfterClose(live)) {
      this.log(new Error('The browser did not close; the next browser tool to start will end it.'));
      return;
    }
    this.tracked.delete(live);
    await forgetBrowser(this.options.stateDir, { serverPid: process.pid, marker: live.marker });
  }

  /** A closed browser's process can take a moment to go. */
  private async stillRunningAfterClose(live: Live): Promise<boolean> {
    const deadline = Date.now() + (this.hooks.goneWaitMs ?? 1_000);
    for (;;) {
      if (!await stillRunning(this.hooks.probe, live.browserPid!, live.marker)) return false;
      if (Date.now() >= deadline) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
