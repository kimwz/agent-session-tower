import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_MASTER_SETTINGS, DEFAULT_MASTER_VOICE, MASTER_PLAYBACK_RATES, MASTER_TTS_MODELS, type MasterBinding, type MasterSettings, type MasterTtsModel, type MasterVoiceSettings } from '../../shared/master.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length >= 8 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
/** Settings of the master that answered through a model API (1.44–1.64): read and dropped. */
const LEGACY_KEYS = new Set(['enabled', 'model', 'effort', 'showResults', 'guards']);
/** Keys that master used for its conversation. The master never talks through an API key, so they are removed. */
const LEGACY_KEY_FILES = ['openai-key.json', 'anthropic-key.json'];

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
    } else if (key === 'playbackRate') {
      if (typeof item !== 'number' || !Number.isFinite(item) || item < MASTER_PLAYBACK_RATES[0] || item > MASTER_PLAYBACK_RATES[MASTER_PLAYBACK_RATES.length - 1]) throw invalid('읽는 속도가 올바르지 않습니다.');
      next.playbackRate = Math.round(item * 20) / 20;
    } else if (saved && LEGACY_VOICE_KEYS.has(key)) continue;
    else throw invalid('음성 설정이 올바르지 않습니다.');
  }
  return next;
}

/** Parses a settings change against the current settings; unknown fields are refused (saved legacy ones are dropped). */
export function mergeSettings(current: MasterSettings, value: unknown, saved = false): MasterSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('마스터 설정이 올바르지 않습니다.');
  const next: MasterSettings = { ...current, voice: { ...(current.voice ?? DEFAULT_MASTER_VOICE) } };
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'voice') next.voice = readVoice(item, next.voice, saved);
    else if (key === 'session' && saved) { const binding = readBinding(item); if (binding) next.session = binding; }
    else if (saved && LEGACY_KEYS.has(key)) continue;
    else throw invalid('마스터 설정이 올바르지 않습니다.');
  }
  return next;
}

function readBinding(value: unknown): MasterBinding | undefined {
  const input = value as Partial<MasterBinding> | undefined;
  if (!input || typeof input.sessionId !== 'string' || input.sessionId.length > 200 || (input.provider !== 'claude' && input.provider !== 'codex') || typeof input.startedAt !== 'string') return undefined;
  return { sessionId: input.sessionId, provider: input.provider, startedAt: input.startedAt };
}

/** The master's settings and its ElevenLabs key, each in an owner-only file. The key is never returned, only its end. */
export class MasterSettingsStore {
  private settings: MasterSettings = structuredClone(DEFAULT_MASTER_SETTINGS);
  private voiceApiKey?: string;
  private changes: Promise<unknown> = Promise.resolve();
  private readonly settingsPath: string;
  private readonly voiceKeyPath: string;

  constructor(private readonly directory: string) {
    this.settingsPath = join(directory, 'settings.json');
    this.voiceKeyPath = join(directory, 'elevenlabs-key.json');
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const saved = await readPrivateJson(this.settingsPath).catch(() => undefined);
    let parsed = false;
    try { if (saved) { this.settings = mergeSettings(DEFAULT_MASTER_SETTINGS, saved, true); parsed = true; } }
    catch { this.settings = structuredClone(DEFAULT_MASTER_SETTINGS); }
    const voiceKey = await readPrivateJson(this.voiceKeyPath).catch(() => undefined) as { apiKey?: unknown } | undefined;
    if (validKey(voiceKey?.apiKey)) this.voiceApiKey = voiceKey.apiKey;
    for (const name of LEGACY_KEY_FILES) await unlink(join(this.directory, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    // Written back without the dropped fields, so they are gone from disk too; a file this build cannot read is left as it is.
    if (parsed && JSON.stringify(saved) !== JSON.stringify(this.settings)) await this.save(this.settings);
  }

  current(): MasterSettings { return structuredClone(this.settings); }
  voiceKey(): string | undefined { return this.voiceApiKey; }
  voiceKeyHint(): string | undefined { return this.voiceApiKey ? `…${this.voiceApiKey.slice(-4)}` : undefined; }

  /** `voiceKey: null` removes the key; any other field goes through `mergeSettings`. */
  update(body: Record<string, unknown>): Promise<MasterSettings> {
    return this.change(async () => {
      const { voiceKey, ...rest } = body;
      if (voiceKey !== undefined && voiceKey !== null && !validKey(voiceKey)) throw invalid('ElevenLabs API 키 형식이 올바르지 않습니다.');
      const settings = Object.keys(rest).length ? mergeSettings(this.settings, rest) : this.settings;
      if (voiceKey !== undefined) {
        await writePrivateJson(this.voiceKeyPath, JSON.stringify(voiceKey === null ? {} : { apiKey: voiceKey }));
        this.voiceApiKey = voiceKey === null ? undefined : voiceKey as string;
      }
      if (settings !== this.settings) await this.save(settings);
    });
  }

  /** Binds the master to a session (or unbinds it), on disk before anything else relies on it. */
  bind(binding: MasterBinding | undefined): Promise<MasterSettings> {
    return this.change(async () => {
      const { session: _previous, ...rest } = this.settings;
      await this.save(binding ? { ...rest, session: binding } : rest);
    });
  }

  private async save(settings: MasterSettings): Promise<void> {
    await writePrivateJson(this.settingsPath, JSON.stringify(settings));
    this.settings = settings;
  }

  private change(work: () => Promise<void>): Promise<MasterSettings> {
    const next = this.changes.then(async () => { await work(); return this.current(); });
    this.changes = next.catch(() => {});
    return next;
  }
}
