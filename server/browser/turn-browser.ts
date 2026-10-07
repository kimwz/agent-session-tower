import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext } from 'playwright';
import { newContext, startBrowser, type BrowserTier } from './launch.js';
import { findBrowserPid, forgetBrowser, markerSwitch, recordBrowser, stillRunning, systemProbe, type ProcessProbe } from './live.js';
import { LoginSaver, readState, type StorageState } from './logins.js';

export interface TurnBrowserOptions { tier: BrowserTier; stateDir: string; savedLogins: boolean; outsideContent?: boolean }

/** What starts and finds a browser; tests replace these. */
export interface TurnBrowserHooks {
  startBrowser(tier: BrowserTier, marker: string, options: { outsideContent?: boolean }): Promise<{ browser: Browser }>;
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

interface Live { browser: Browser; marker: string; browserPid?: number; context?: BrowserContext; logins?: LoginSaver; closing?: Promise<void> }

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
    const { browser } = await this.hooks.startBrowser(this.options.tier, markerSwitch(marker), { outsideContent: this.options.outsideContent });
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
      // Code the agent runs may close the context itself; what that call changed in the logins is saved first.
      const closeContext = context.close.bind(context);
      context.close = async (...args: Parameters<BrowserContext['close']>) => {
        if (this.active === live) { this.active = undefined; await this.saveLast(live); }
        return closeContext(...args);
      };
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
    // best-effort: a browser that failed to start has nothing to close.
    if (this.starting) await this.starting.catch(() => undefined);
    const live = this.active;
    if (!live) return;
    this.active = undefined;
    await this.saveLast(live);
    await this.close(live);
  }

  /** Reads a browser's logins once more, briefly, and saves them; a running save is waited for only as briefly. */
  private async saveLast(live: Live): Promise<void> {
    // best-effort: a save still waiting for the lock goes on by itself; this one is queued behind it.
    if (this.saving) await within(this.saving, this.hooks.stateTimeoutMs ?? 1_000).catch(() => undefined);
    if (!live.context || !live.logins) return;
    let state: StorageState;
    try { state = await within(live.context.storageState() as Promise<StorageState>, this.hooks.stateTimeoutMs ?? 1_000); }
    catch (error) { this.log(new Error(`This turn's logins could not be read before closing: ${error instanceof Error ? error.message : String(error)}`)); return; }
    // best-effort: a save that waits longer for another turn's lock finishes by itself; shutdown waits for every saver.
    await within(live.logins.save(state), this.hooks.stateTimeoutMs ?? 1_000).catch(() => undefined);
  }

  /**
   * The turn ended: read the logins (briefly — Codex follows its SIGTERM with SIGKILL two seconds later), close every
   * browser, then save. A failed save never keeps a browser open.
   */
  async shutdown(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    // best-effort: a browser still setting up is closed below either way.
    if (this.starting) await within(this.starting, this.hooks.stateTimeoutMs ?? 1_000).catch(() => undefined);
    const last = this.active;
    this.active = undefined;
    if (last) await this.saveLast(last);
    await Promise.all([...this.tracked].map(live => this.close(live)));
    await Promise.all([...this.savers].map(saver => saver.idle()));
  }

  /** Once per browser: closing it fires its context's `close`, which asks for this again. */
  private close(live: Live): Promise<void> { return live.closing ??= Promise.resolve().then(() => this.closeOnce(live)); }

  private async closeOnce(live: Live): Promise<void> {
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
