import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext } from 'playwright';
import { newContext, startBrowser, type BrowserTier } from './launch.js';
import { findBrowserPid, forgetBrowser, markerSwitch, recordBrowser, stillRunning, systemProbe, type ProcessProbe } from './live.js';
import { LoginSaver, readState, type StorageState } from './logins.js';

export interface TurnBrowserOptions { tier: BrowserTier; stateDir: string; savedLogins: boolean; outsideContent?: boolean }

/** What starts and finds a browser; tests replace these. */
export interface TurnBrowserHooks {
  startBrowser(tier: BrowserTier, marker: string): Promise<{ browser: Browser }>;
  newContext(tier: BrowserTier, browser: Browser, options: { storageState?: StorageState; outsideContent?: boolean }): Promise<BrowserContext>;
  findBrowserPid(marker: string): Promise<number | undefined>;
  probe: ProcessProbe;
  /** Settles before the first browser starts: leftovers of killed servers are ended first. */
  ready?: Promise<unknown>;
  closeTimeoutMs?: number;
  stateTimeoutMs?: number;
  saveWaitMs?: number;
  goneWaitMs?: number;
}

const DEFAULT_HOOKS: TurnBrowserHooks = { startBrowser, newContext, findBrowserPid, probe: systemProbe };

/** One browser of the turn; each keeps its own saves, so a browser started after the agent closed one never takes the
 * earlier one's unsaved state as its own starting point. */
/** `work`, or a timeout error after `ms`; the timer keeps the process alive meanwhile and is cleared either way. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); })]).finally(() => clearTimeout(timer));
}

interface Live { browser: Browser; marker: string; browserPid?: number; context?: BrowserContext; logins?: LoginSaver }

/**
 * The browser of one turn's tool server. It starts on first use; every browser it starts is tracked from the moment it
 * runs, closed when it fails to set up and when the turn ends, and its record is dropped only once it is confirmed gone,
 * so a browser that would not close is still found by the next server's reaper.
 */
export class TurnBrowser {
  private readonly hooks: TurnBrowserHooks;
  private readonly tracked = new Set<Live>();
  /** Every browser's saves, finished or not; a new browser reads the logins only after them. */
  private readonly savers = new Set<LoginSaver>();
  private active: Live | undefined;
  private starting: Promise<BrowserContext> | undefined;
  private saving: Promise<void> | undefined;
  private saveAgain = false;
  private finished = false;

  constructor(private readonly options: TurnBrowserOptions, private readonly log: (error: unknown) => void, hooks: Partial<TurnBrowserHooks> = {}) {
    this.hooks = { ...DEFAULT_HOOKS, ...hooks };
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
      let loaded: StorageState | undefined;
      if (this.options.savedLogins) {
        await Promise.all([...this.savers].map(saver => saver.idle()));
        loaded = await readState(this.options.stateDir, this.log);
        live.logins = new LoginSaver(this.options.stateDir, this.log, { waitMs: this.hooks.saveWaitMs });
        live.logins.started(loaded);
        this.savers.add(live.logins);
      }
      const context = await this.hooks.newContext(this.options.tier, browser, { storageState: loaded, outsideContent: this.options.outsideContent });
      live.context = context;
      this.active = live;
      // The agent may close the browser itself; the next tool call starts a new one.
      context.on('close', () => { if (this.active === live) this.active = undefined; void this.close(live); });
      return context;
    } catch (error) {
      await this.close(live);
      throw error;
    }
  }

  /**
   * After each tool call: what it changed in the logins is saved at once, so a browser that is closed or dies before the
   * turn ends loses nothing earlier calls did. Calls that finish while a save runs share one more save.
   */
  saveSoon(): void {
    if (!this.options.savedLogins || this.finished) return;
    if (this.saving) { this.saveAgain = true; return; }
    this.saving = (async () => {
      do {
        this.saveAgain = false;
        const live = this.active;
        if (!live?.context || !live.logins) break;
        try { await live.logins.save(await live.context.storageState() as StorageState); }
        catch (error) { this.log(new Error(`This turn's logins could not be read: ${error instanceof Error ? error.message : String(error)}`)); }
      } while (this.saveAgain && !this.finished);
    })().finally(() => { this.saving = undefined; });
  }

  /** The agent asked to close the browser: its logins are saved first, and the next tool call starts a new one. */
  async closeActive(): Promise<void> {
    const live = this.active;
    if (!live) return;
    await this.saving;
    let state: StorageState | undefined;
    if (live.context && live.logins) {
      try { state = await within(live.context.storageState() as Promise<StorageState>, this.hooks.stateTimeoutMs ?? 1_000); }
      catch (error) { this.log(new Error(`This turn's logins could not be read before closing: ${error instanceof Error ? error.message : String(error)}`)); }
    }
    await this.close(live);
    if (state) await live.logins!.save(state);
  }

  /**
   * The turn ended: read the logins (briefly — Codex follows its SIGTERM with SIGKILL two seconds later), close every
   * browser, then save. A failed save never keeps a browser open.
   */
  async shutdown(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.saving;
    const timeout = <T>(work: Promise<T>) => within(work, this.hooks.stateTimeoutMs ?? 1_000);
    // best-effort: a browser still setting up is closed below either way.
    if (this.starting) await timeout(this.starting).catch(() => undefined);
    let state: StorageState | undefined;
    const last = this.active;
    if (last?.context && last.logins) {
      try { state = await timeout(last.context.storageState() as Promise<StorageState>); }
      catch (error) { this.log(new Error(`This turn's logins could not be read before closing: ${error instanceof Error ? error.message : String(error)}`)); }
    }
    await Promise.all([...this.tracked].map(live => this.close(live)));
    if (state) void last!.logins!.save(state);
    await Promise.all([...this.savers].map(saver => saver.idle()));
  }

  private async close(live: Live): Promise<void> {
    if (this.active === live) this.active = undefined;
    // best-effort: whether it closed is checked below by its process.
    await within(live.browser.close(), this.hooks.closeTimeoutMs ?? 5_000).catch(() => {});
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
