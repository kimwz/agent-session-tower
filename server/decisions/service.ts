import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DECISION_PROVIDER_IDS, DEFAULT_DECISION_FEATURES, type DecisionFeatures, type DecisionOverview, type DecisionProviderId } from '../../shared/decisions.js';
import { httpError } from '../http/requests.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { DecisionError, type DecisionEngine } from './engine.js';
import { DECISION_PROVIDERS, type DecisionProvider } from './providers.js';

interface Saved { provider: DecisionProviderId; apiKey?: string; features: DecisionFeatures }

const FILE = 'decisions.json';
const provider = (value: unknown): value is DecisionProviderId => typeof value === 'string' && (DECISION_PROVIDER_IDS as readonly string[]).includes(value);
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length >= 8 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);

function parseFeatures(value: unknown, fallback: DecisionFeatures): DecisionFeatures {
  if (value === undefined) return fallback;
  const features = value as Record<string, unknown>;
  if (!features || typeof features !== 'object' || Array.isArray(features) || Object.entries(features).some(([key, item]) => !(key in DEFAULT_DECISION_FEATURES) || typeof item !== 'boolean')) {
    throw httpError(400, '빠른 판단 기능 설정이 올바르지 않습니다.');
  }
  return { ...fallback, ...features as Partial<DecisionFeatures> };
}

/**
 * The owner's fast-judgment settings and the engine features use. Features ask `engine(feature)` and keep their
 * usual behaviour when it returns nothing: no API key, or that feature turned off.
 */
export class DecisionService {
  private readonly path: string;
  private saved: Saved = { provider: 'jev', features: { ...DEFAULT_DECISION_FEATURES } };
  private cached?: { key: string; provider: DecisionProviderId; engine: DecisionEngine };
  private writes: Promise<void> = Promise.resolve();
  /** Each change reads, merges and saves before the next starts, so a removed key never comes back. */
  private changes: Promise<unknown> = Promise.resolve();

  constructor(private readonly stateDir: string, private readonly providers: Record<DecisionProviderId, DecisionProvider> = DECISION_PROVIDERS, private readonly fetcher?: typeof fetch) {
    this.path = join(stateDir, FILE);
  }

  async start(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    let raw: unknown;
    try { raw = await readPrivateJson(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const saved = raw as Partial<Saved> | undefined;
    if (!saved || typeof saved !== 'object') return;
    let features: DecisionFeatures;
    try { features = parseFeatures(saved.features, DEFAULT_DECISION_FEATURES); } catch { features = { ...DEFAULT_DECISION_FEATURES }; }
    this.saved = { provider: provider(saved.provider) ? saved.provider : 'jev', features, ...(validKey(saved.apiKey) ? { apiKey: saved.apiKey } : {}) };
  }

  overview(): DecisionOverview {
    const { provider: id, apiKey, features } = this.saved;
    return { provider: id, label: this.providers[id].label, configured: Boolean(apiKey), ...(apiKey ? { keyHint: `…${apiKey.slice(-4)}` } : {}),
      features: { ...features }, providers: DECISION_PROVIDER_IDS.map(item => ({ id: item, label: this.providers[item].label })) };
  }

  /** The engine for one feature, or nothing when that feature should keep its usual behaviour. */
  engine(feature: keyof DecisionFeatures): DecisionEngine | undefined {
    const { provider: id, apiKey, features } = this.saved;
    if (!apiKey || !features[feature]) return undefined;
    if (this.cached?.key !== apiKey || this.cached.provider !== id) this.cached = { key: apiKey, provider: id, engine: this.providers[id].create(apiKey, this.fetcher) };
    return this.cached.engine;
  }

  /** `apiKey: null` forgets the key. A new key is saved as given; `test()` checks it. Changes apply one at a time. */
  update(body: Record<string, unknown>): Promise<DecisionOverview> {
    const change = this.changes.then(() => this.apply(body));
    this.changes = change.catch(() => {});
    return change;
  }

  private async apply(body: Record<string, unknown>): Promise<DecisionOverview> {
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['provider', 'apiKey', 'features'].includes(key))) throw httpError(400, '빠른 판단 설정 요청 형식이 올바르지 않습니다.');
    if (body.provider !== undefined && !provider(body.provider)) throw httpError(400, '지원하지 않는 판단 서비스입니다.');
    let apiKey = this.saved.apiKey;
    if (body.apiKey === null) apiKey = undefined;
    else if (body.apiKey !== undefined) {
      const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : body.apiKey;
      if (!validKey(key)) throw httpError(400, 'API 키는 공백 없는 8~512자여야 합니다.');
      apiKey = key;
    }
    const features = parseFeatures(body.features, this.saved.features);
    const next: Saved = { provider: (body.provider as DecisionProviderId | undefined) ?? this.saved.provider, features, ...(apiKey ? { apiKey } : {}) };
    await this.save(next);
    this.saved = next;
    return this.overview();
  }

  /** Asks the service one question about made-up content, so no conversation leaves this computer. */
  async test(): Promise<DecisionOverview> {
    const { provider: id, apiKey } = this.saved;
    if (!apiKey) throw httpError(409, '먼저 API 키를 저장하세요.');
    const engine = this.providers[id].create(apiKey, this.fetcher);
    try {
      await engine.decide({ state: { message: 'The build finished and every test passed.' }, questions: { finished: { type: 'yesNo', instructions: 'Does the message say that the work finished?' } } });
    } catch (error) {
      const kind = error instanceof DecisionError ? error.kind : 'unavailable';
      if (kind === 'unauthorized') throw httpError(400, `${engine.label}가 API 키를 거부했습니다. 키를 확인하세요.`);
      if (kind === 'rate-limited') throw httpError(429, `${engine.label} 요청 한도에 걸렸습니다. 잠시 후 다시 확인하세요.`);
      throw httpError(502, `${engine.label}에 연결하지 못했습니다. 잠시 후 다시 확인하세요.`);
    }
    return this.overview();
  }

  async close(): Promise<void> { await this.changes; await this.writes; }

  private save(next: Saved): Promise<void> {
    const write = this.writes.then(() => writePrivateJson(this.path, `${JSON.stringify(next)}\n`));
    this.writes = write.catch(() => {});
    return write;
  }
}
