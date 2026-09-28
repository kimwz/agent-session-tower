import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_MASTER_SETTINGS, DEFAULT_MASTER_VOICE, MASTER_EFFORTS, masterProvider, MASTER_TTS_MODELS, type MasterEffort, type MasterGuards, type MasterSettings, type MasterTtsModel, type MasterVoiceSettings } from '../../shared/master.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length >= 8 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
const NODE_ID = /^[a-f0-9]{32}$/;

function readGuards(value: unknown, fallback: MasterGuards): MasterGuards {
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('마스터 안전 설정이 올바르지 않습니다.');
  const input = value as Record<string, unknown>;
  const next = { ...fallback };
  for (const [key, item] of Object.entries(input)) {
    if (key === 'hideSecrets' || key === 'localOnlyPages' || key === 'eventTurnsReadOnly') {
      if (typeof item !== 'boolean') throw invalid('마스터 안전 설정이 올바르지 않습니다.');
      next[key] = item;
    } else if (key === 'readOnlyNodes') {
      if (!Array.isArray(item) || item.length > 64 || item.some(node => typeof node !== 'string' || !NODE_ID.test(node))) throw invalid('읽기 전용 컴퓨터 목록이 올바르지 않습니다.');
      next.readOnlyNodes = [...new Set(item as string[])];
    } else if (key === 'maxIrreversiblePerTurn') {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 1000) throw invalid('한 번에 할 수 있는 작업 수가 올바르지 않습니다.');
      next.maxIrreversiblePerTurn = item;
    } else throw invalid('마스터 안전 설정이 올바르지 않습니다.');
  }
  return next;
}

/** Voice settings kept before voice moved to ElevenLabs (GPT-Live, 1.52–1.55); read and dropped. */
const LEGACY_VOICE_KEYS = new Set(['voice', 'silenceSeconds', 'dailyMinutes', 'autoWake']);

function readVoice(value: unknown, fallback: MasterVoiceSettings, saved: boolean): MasterVoiceSettings {
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('음성 설정이 올바르지 않습니다.');
  const next = { ...fallback };
  const whole = (item: unknown, min: number, max: number) => typeof item === 'number' && Number.isInteger(item) && item >= min && item <= max;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'voiceId') {
      if (typeof item !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(item)) throw invalid('목소리가 올바르지 않습니다.');
      next.voiceId = item;
    } else if (key === 'model') {
      if (!(MASTER_TTS_MODELS as readonly unknown[]).includes(item)) throw invalid('음성 모델이 올바르지 않습니다.');
      next.model = item as MasterTtsModel;
    } else if (key === 'endSilenceMs') {
      if (!whole(item, 600, 3000)) throw invalid('말 끝 대기 시간이 올바르지 않습니다.');
      next.endSilenceMs = item as number;
    } else if (key === 'listenMinutes') {
      if (!whole(item, 1, 30)) throw invalid('듣기 시간이 올바르지 않습니다.');
      next.listenMinutes = item as number;
    } else if (key === 'readReports') {
      if (typeof item !== 'boolean') throw invalid('음성 설정이 올바르지 않습니다.');
      next.readReports = item;
    } else if (key === 'dailyDollars') {
      if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1000) throw invalid('하루 한도가 올바르지 않습니다.');
      next.dailyDollars = Math.round(item * 100) / 100;
    } else if (saved && LEGACY_VOICE_KEYS.has(key)) continue;
    else throw invalid('음성 설정이 올바르지 않습니다.');
  }
  return next;
}

/** Parses a settings change against the current settings; unknown fields are refused. */
export function mergeSettings(current: MasterSettings, value: unknown, saved = false): MasterSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('마스터 설정이 올바르지 않습니다.');
  const input = value as Record<string, unknown>;
  const next: MasterSettings = { ...current, guards: { ...current.guards }, voice: { ...(current.voice ?? DEFAULT_MASTER_VOICE) } };
  for (const [key, item] of Object.entries(input)) {
    if (key === 'enabled' || key === 'showResults') {
      if (typeof item !== 'boolean') throw invalid('마스터 설정이 올바르지 않습니다.');
      next[key] = item;
    } else if (key === 'model') {
      if (typeof item !== 'string' || !/^[a-zA-Z0-9._:-]{1,80}$/.test(item)) throw invalid('모델 이름이 올바르지 않습니다.');
      next.model = item;
    } else if (key === 'effort') {
      if (!(MASTER_EFFORTS as readonly unknown[]).includes(item)) throw invalid('추론 수준이 올바르지 않습니다.');
      next.effort = item as MasterEffort;
    } else if (key === 'guards') next.guards = readGuards(item, next.guards);
    else if (key === 'voice') next.voice = readVoice(item, next.voice, saved);
    else throw invalid('마스터 설정이 올바르지 않습니다.');
  }
  return next;
}

/**
 * The owner's master settings, OpenAI key, Anthropic key and ElevenLabs key, each in its own owner-only file. Keys
 * are never returned; only their last four characters are shown.
 */
export class MasterSettingsStore {
  private settings: MasterSettings = structuredClone(DEFAULT_MASTER_SETTINGS);
  private apiKey?: string;
  private voiceApiKey?: string;
  private anthropicApiKey?: string;
  private changes: Promise<unknown> = Promise.resolve();
  private readonly settingsPath: string;
  private readonly keyPath: string;
  private readonly voiceKeyPath: string;
  private readonly anthropicKeyPath: string;

  constructor(private readonly directory: string) {
    this.settingsPath = join(directory, 'settings.json');
    this.keyPath = join(directory, 'openai-key.json');
    this.voiceKeyPath = join(directory, 'elevenlabs-key.json');
    this.anthropicKeyPath = join(directory, 'anthropic-key.json');
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const saved = await readPrivateJson(this.settingsPath).catch(() => undefined);
    try { if (saved) this.settings = mergeSettings(DEFAULT_MASTER_SETTINGS, saved, true); }
    catch { this.settings = structuredClone(DEFAULT_MASTER_SETTINGS); }
    const key = await readPrivateJson(this.keyPath).catch(() => undefined) as { apiKey?: unknown } | undefined;
    if (validKey(key?.apiKey)) this.apiKey = key.apiKey;
    const voiceKey = await readPrivateJson(this.voiceKeyPath).catch(() => undefined) as { apiKey?: unknown } | undefined;
    if (validKey(voiceKey?.apiKey)) this.voiceApiKey = voiceKey.apiKey;
    const anthropicKey = await readPrivateJson(this.anthropicKeyPath).catch(() => undefined) as { apiKey?: unknown } | undefined;
    if (validKey(anthropicKey?.apiKey)) this.anthropicApiKey = anthropicKey.apiKey;
  }

  current(): MasterSettings { return structuredClone(this.settings); }
  key(): string | undefined { return this.apiKey; }
  keyHint(): string | undefined { return this.apiKey ? `…${this.apiKey.slice(-4)}` : undefined; }
  voiceKey(): string | undefined { return this.voiceApiKey; }
  voiceKeyHint(): string | undefined { return this.voiceApiKey ? `…${this.voiceApiKey.slice(-4)}` : undefined; }
  anthropicKey(): string | undefined { return this.anthropicApiKey; }
  anthropicKeyHint(): string | undefined { return this.anthropicApiKey ? `…${this.anthropicApiKey.slice(-4)}` : undefined; }
  /** The key a model's requests are sent with: Anthropic's for Claude models, OpenAI's for the rest. */
  keyFor(model: string): string | undefined { return masterProvider(model) === 'anthropic' ? this.anthropicApiKey : this.apiKey; }
  /** Some model can be asked: the master has at least one model key. */
  anyKey(): boolean { return Boolean(this.apiKey || this.anthropicApiKey); }

  /** `apiKey`/`anthropicKey`/`voiceKey: null` removes that key; any other field goes through `mergeSettings`. */
  update(body: Record<string, unknown>): Promise<MasterSettings> {
    const next = this.changes.then(async () => {
      const { apiKey, anthropicKey, voiceKey, ...rest } = body;
      if (apiKey !== undefined && apiKey !== null && !validKey(apiKey)) throw invalid('OpenAI API 키 형식이 올바르지 않습니다.');
      if (anthropicKey !== undefined && anthropicKey !== null && !validKey(anthropicKey)) throw invalid('Anthropic API 키 형식이 올바르지 않습니다.');
      if (voiceKey !== undefined && voiceKey !== null && !validKey(voiceKey)) throw invalid('ElevenLabs API 키 형식이 올바르지 않습니다.');
      const settings = Object.keys(rest).length ? mergeSettings(this.settings, rest) : this.settings;
      if (apiKey !== undefined) {
        await writePrivateJson(this.keyPath, JSON.stringify(apiKey === null ? {} : { apiKey }));
        this.apiKey = apiKey === null ? undefined : apiKey as string;
      }
      if (anthropicKey !== undefined) {
        await writePrivateJson(this.anthropicKeyPath, JSON.stringify(anthropicKey === null ? {} : { apiKey: anthropicKey }));
        this.anthropicApiKey = anthropicKey === null ? undefined : anthropicKey as string;
      }
      if (voiceKey !== undefined) {
        await writePrivateJson(this.voiceKeyPath, JSON.stringify(voiceKey === null ? {} : { apiKey: voiceKey }));
        this.voiceApiKey = voiceKey === null ? undefined : voiceKey as string;
      }
      if (settings !== this.settings) {
        await writePrivateJson(this.settingsPath, JSON.stringify(settings));
        this.settings = settings;
      }
      return this.current();
    });
    this.changes = next.catch(() => {});
    return next;
  }
}
