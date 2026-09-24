import { join } from 'node:path';
import type { AutoUpdateStatus, UpdateStatus } from '../../shared/link.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { newerVersion, runtimePaths } from '../link/service.js';
import { updateActive, type UpdateRequestResult } from '../link/update.js';
import type { LatestRelease } from './latest.js';
import { failedAgain, parseRetry, retryDue, type RetryRecord } from './schedule.js';

const MINUTE = 60_000;
const FIRST_MS = 2 * MINUTE;
const EVERY_MS = 30 * MINUTE;
const JITTER_MS = 5 * MINUTE;

export interface TowerAutoUpdateOptions {
  stateDir: string;
  version: string;
  enabled: boolean;
  updates: { readonly managed: boolean; request(version: unknown): Promise<UpdateRequestResult>; status(): Promise<UpdateStatus | undefined> };
  /** Controllers this computer is paired with: then it follows them and never moves ahead of them by itself. */
  controllers(): number;
  latest(): Promise<LatestRelease | undefined>;
  now?: () => number;
  random?: () => number;
  firstMs?: number;
  everyMs?: number;
  onChange?: () => void;
}

/**
 * What this computer keeps between checks: the retries of a version that failed, which failure was counted, and which
 * update the owner started (by when it started), whose failure is not counted.
 */
interface Saved { retry?: RetryRecord; counted?: string; manual?: string }

/**
 * Keeps a Tower that runs as the background service at the latest release: it looks every half hour and moves with the
 * update helper, which keeps the new version only once it runs and goes back otherwise. A version that failed is tried
 * again on the retry schedule. A Tower run another way only learns what the latest release is.
 */
export class TowerAutoUpdate {
  private latest?: LatestRelease;
  private saved: Saved = {};
  private timer?: ReturnType<typeof setTimeout>;
  private checking?: Promise<void>;
  private stopped = false;
  constructor(private readonly options: TowerAutoUpdateOptions) {}

  private get path(): string { return join(runtimePaths(this.options.stateDir).root, 'auto-update.json'); }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  async start(): Promise<void> {
    const value = await readPrivateJson(this.path).catch(() => undefined) as Partial<Saved> | undefined;
    const retry = parseRetry(value?.retry);
    this.saved = { ...(retry ? { retry } : {}), ...(typeof value?.counted === 'string' ? { counted: value.counted } : {}), ...(typeof value?.manual === 'string' ? { manual: value.manual } : {}) };
    this.schedule(this.options.firstMs ?? FIRST_MS);
  }

  stop(): void { this.stopped = true; clearTimeout(this.timer); }

  status(): AutoUpdateStatus['tower'] {
    const retry = this.saved.retry && this.latest && this.saved.retry.version === this.latest.version ? this.saved.retry : undefined;
    return { kind: this.options.updates.managed ? 'service' : 'unmanaged',
      ...(this.latest ? { latest: this.latest.version, checkedAt: this.latest.checkedAt } : {}),
      ...(retry ? { nextAt: retry.nextAt } : {}),
      ...(this.options.updates.managed && this.options.controllers() > 0 ? { followsController: true } : {}) };
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.check().catch(error => console.error(`Checking for a Tower update failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.schedule((this.options.everyMs ?? EVERY_MS) + ((this.options.random?.() ?? Math.random()) * 2 - 1) * JITTER_MS));
    }, Math.max(1000, ms));
    this.timer.unref();
  }

  /** One look at the latest release, and an update to it when this Tower may move by itself. */
  check(): Promise<void> {
    return this.checking ??= this.look().finally(() => { this.checking = undefined; });
  }

  private async look(): Promise<void> {
    // Turned off (development and fixture instances), nothing is asked of GitHub either; nor by a computer that follows
    // the Tower controlling it, which brings it the version to move to.
    if (!this.options.enabled || (this.options.updates.managed && this.options.controllers() > 0)) return;
    const latest = await this.options.latest();
    if (latest) { this.latest = latest; this.options.onChange?.(); }
    const { updates, version } = this.options;
    if (!this.options.enabled || !updates.managed || this.options.controllers() > 0) return;
    const status = await updates.status();
    if (updateActive(status)) return;
    // Each failure of an update is counted once, when it is first seen here; the owner's own attempt is only marked seen.
    if (status?.stage === 'failed' && status.startedAt !== this.saved.counted && newerVersion(status.version, version)) {
      await this.save(status.startedAt === this.saved.manual ? { ...(this.saved.retry ? { retry: this.saved.retry } : {}), counted: status.startedAt }
        : { retry: failedAgain(this.saved.retry, status.version, Date.parse(status.updatedAt) || this.now()), counted: status.startedAt });
    }
    if (!latest || !newerVersion(latest.version, version)) {
      if (this.saved.retry && !newerVersion(this.saved.retry.version, version)) await this.save({});
      return;
    }
    if (!retryDue(this.saved.retry, latest.version, this.now())) return;
    await updates.request(latest.version);
    this.options.onChange?.();
  }

  /**
   * The owner's "update now": the version asked for, or the latest release. It tries at once, whatever the retry
   * schedule says, and leaves the schedule as it is, even when it fails.
   */
  async updateNow(version?: string): Promise<UpdateRequestResult> {
    const target = version ?? (await this.options.latest())?.version;
    if (!target) return { status: 503, body: { code: 'no-release', error: 'The latest release could not be looked up. Try again in a moment.' } };
    const answer = await this.options.updates.request(target);
    const started = answer.status === 202 ? answer.body.update?.startedAt : undefined;
    if (started && started !== this.saved.counted) await this.save({ ...this.saved, manual: started });
    return answer;
  }

  private async save(saved: Saved): Promise<void> {
    this.saved = saved;
    await writePrivateJson(this.path, JSON.stringify(saved)).catch(error => console.error(`The update retry schedule was not saved: ${(error as Error).message}`));
  }
}
