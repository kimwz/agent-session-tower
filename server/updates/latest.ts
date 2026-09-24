import { releasePublished } from '../link/join-code.js';

/** The newest release of Tower whose built package is published, and how that was learned. */
export interface LatestRelease { version: string; checkedAt: string; source: 'api' | 'redirect' }

const REPOSITORY = 'kimwz/agent-session-tower';
const RELEASE = /^v(\d+\.\d+\.\d+)$/;
const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

export interface LatestOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Only tests point these elsewhere. */
  api?: string;
  web?: string;
  published?: (version: string) => Promise<boolean>;
}

/**
 * Asks GitHub for the latest release: its API first, which lists the package, and when that is unavailable (it allows
 * 60 unauthenticated requests an hour per address), the release page's redirect plus a check that the package is
 * there. Drafts and prereleases are never the latest. An answer is kept for ten minutes.
 */
export class LatestReleases {
  private cached?: { at: number; value: LatestRelease | undefined };
  constructor(private readonly options: LatestOptions = {}) {}

  async latest(): Promise<LatestRelease | undefined> {
    const now = this.options.now?.() ?? Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.value;
    const value = await this.fromApi(now).catch(() => undefined) ?? await this.fromRedirect(now).catch(() => undefined);
    this.cached = { at: now, value };
    return value;
  }

  private async fromApi(now: number): Promise<LatestRelease | undefined> {
    const response = await (this.options.fetch ?? fetch)(this.options.api ?? `https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-session-tower' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const release = await response.json() as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: Array<{ name?: unknown; state?: unknown }> };
    const version = typeof release.tag_name === 'string' ? RELEASE.exec(release.tag_name)?.[1] : undefined;
    if (!version || release.draft === true || release.prerelease === true) return undefined;
    const packaged = Array.isArray(release.assets) && release.assets.some(asset => asset?.name === `agent-session-tower-${version}.tgz` && (asset.state === undefined || asset.state === 'uploaded'));
    return packaged ? { version, checkedAt: new Date(now).toISOString(), source: 'api' } : undefined;
  }

  private async fromRedirect(now: number): Promise<LatestRelease | undefined> {
    const response = await (this.options.fetch ?? fetch)(this.options.web ?? `https://github.com/${REPOSITORY}/releases/latest`, {
      method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'agent-session-tower' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = response.headers.get('location') ?? '';
    const tag = /\/releases\/tag\/([^/?#]+)$/.exec(location)?.[1];
    const version = tag ? RELEASE.exec(decodeURIComponent(tag))?.[1] : undefined;
    if (!version || !await (this.options.published ?? releasePublished)(version)) return undefined;
    return { version, checkedAt: new Date(now).toISOString(), source: 'redirect' };
  }
}
