import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext } from 'playwright';
import { newContext, startBrowser, type BrowserTier } from './launch.js';
import { findBrowserPid, forgetBrowser, markerSwitch, recordBrowser, stillRunning, systemProbe, type ProcessProbe } from './live.js';
import { LoginSaver, readState, type Cookie, type OriginState, type StorageState } from './logins.js';

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
  /** How long closing may spend saving the last logins, all steps together. */
  lastSaveMs?: number;
  saveWaitMs?: number;
  goneWaitMs?: number;
}

const DEFAULT_HOOKS: TurnBrowserHooks = { startBrowser, newContext, findBrowserPid, probe: systemProbe };

/** `work`, or a timeout error after `ms`; the timer keeps the process alive meanwhile and is cleared either way. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), Math.max(0, ms)); })]).finally(() => clearTimeout(timer));
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * One browser of the turn. Each keeps its own saves, so a browser started after the agent closed one never takes the
 * earlier one's unsaved state as its own starting point. `end` is the browser's own close.
 */
interface Live { browser: Browser; end: () => Promise<void>; marker: string; browserPid?: number; context?: BrowserContext; logins?: LoginSaver; reads: number; retiring?: Promise<void>; closing?: Promise<void> }

/**
 * The browser of one turn's tool server. It starts on first use; every browser it starts is tracked from the moment it
 * runs, closed when it fails to set up and when the turn ends, and its record is dropped only once it is confirmed gone,
 * so a browser that would not close is still found by the next server's reaper.
 *
 * Logins: after every tool call, and once more whenever a browser stops being the turn's (the turn ends, the agent's
 * browser_close, or code the agent runs closing the context or the browser itself), the cookies and the local storage of
 * the pages open then are saved. Playwright's own storageState() is not used: it visits every origin the browser ever
 * saw, which takes seconds once there are dozens.
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
    const live: Live = { browser, end: browser.close.bind(browser), marker, reads: 0 };
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
      // Code the agent runs may close the context or the browser itself; what that call changed is saved first.
      const closeContext = context.close.bind(context);
      context.close = async (...args: Parameters<BrowserContext['close']>) => { await this.retire(live); return closeContext(...args); };
      browser.close = async () => { await this.retire(live); return this.close(live); };
      this.active = live;
      // A browser that closes some other way (it crashed): the next tool call starts a new one.
      context.on('close', () => { if (this.active === live) this.active = undefined; void this.close(live); });
      return context;
    } catch (error) {
      await this.close(live);
      throw error;
    }
  }

  /** After each tool call: its login changes are saved at once. Calls that finish while a save runs share one more. */
  saveSoon(): void {
    if (!this.options.savedLogins || this.finished) return;
    if (this.saving) { this.saveAgain = true; return; }
    this.saving = (async () => {
      do {
        this.saveAgain = false;
        const live = this.active;
        if (!live?.context || !live.logins) break;
        const read = ++live.reads;
        try { await live.logins.save(await this.capture(live.context), read); }
        catch (error) { this.log(new Error(`This turn's logins could not be read: ${message(error)}`)); }
      } while (this.saveAgain && !this.finished);
    })().finally(() => { this.saving = undefined; });
  }

  /** The agent asked to close the browser: its logins are saved first, and the next tool call starts a new one. */
  async closeActive(): Promise<void> {
    // best-effort: a browser that failed to start has nothing to close.
    if (this.starting) await this.starting.catch(() => undefined);
    const live = this.active;
    if (!live) return;
    await this.retire(live);
    await this.close(live);
  }

  /**
   * The turn ended: save the last logins and close every browser, within one short deadline (Codex follows its SIGTERM
   * with SIGKILL two seconds later). A save already under way for a browser the agent closed is waited for too. A failed
   * save never keeps a browser open.
   */
  async shutdown(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const deadline = Date.now() + (this.hooks.lastSaveMs ?? 1_200);
    // best-effort: a browser still setting up is closed below either way.
    if (this.starting) await within(this.starting, deadline - Date.now()).catch(() => undefined);
    if (this.active) void this.retire(this.active, deadline);
    // best-effort: what is not saved by the deadline is lost with the turn; the browsers close regardless.
    await within(Promise.all([...this.tracked].map(live => live.retiring)), deadline - Date.now()).catch(() => undefined);
    await Promise.all([...this.tracked].map(live => this.close(live)));
    await Promise.all([...this.savers].map(saver => saver.idle()));
  }

  /** A browser stops being the turn's: its logins are read once more and saved, by the deadline. Once per browser. */
  private retire(live: Live, deadline = Date.now() + (this.hooks.lastSaveMs ?? 1_200)): Promise<void> {
    if (this.active === live) this.active = undefined;
    return live.retiring ??= (async () => {
      if (!live.context || !live.logins) return;
      const read = ++live.reads;
      try { await within(live.logins.save(await this.capture(live.context, deadline), read), Math.max(200, deadline - Date.now())); }
      catch (error) { this.log(new Error(`This turn's logins could not be saved before closing: ${message(error)}`)); }
    })();
  }

  /**
   * The cookies, and the local storage of each open page (opaque and non-web pages have none). Cheap: no navigation.
   * A page that does not answer by the deadline (or within half a second) is left out.
   */
  private async capture(context: BrowserContext, deadline = Infinity): Promise<StorageState> {
    const cookies = await within(context.cookies(), Math.min(1_000, deadline - Date.now())) as Cookie[];
    const origins = new Map<string, OriginState>();
    for (const page of context.pages()) {
      try {
        const origin = await within(page.evaluate(() => /^https?:$/.test(location.protocol)
          ? { origin: location.origin, localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })) } : undefined), Math.min(500, deadline - Date.now()));
        if (origin) origins.set(origin.origin, origin);
      // best-effort: a page that is navigating or closing has nothing to read now; the next save sees it.
      } catch { /* See above. */ }
    }
    return { cookies, origins: [...origins.values()] };
  }

  /** Once per browser: closing it fires its context's `close`, which asks for this again. */
  private close(live: Live): Promise<void> { return live.closing ??= Promise.resolve().then(() => this.closeOnce(live)); }

  private async closeOnce(live: Live): Promise<void> {
    if (this.active === live) this.active = undefined;
    // best-effort: whether it closed is checked below by its process.
    await within(live.end(), this.hooks.closeTimeoutMs ?? 5_000).catch(() => {});
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
