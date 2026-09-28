import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_MASTER_SETTINGS, DEFAULT_MASTER_VOICE, MASTER_EFFORTS, MASTER_VOICES, type MasterEffort, type MasterGuards, type MasterSettings, type MasterVoiceSettings } from '../../shared/master.js';
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

function readVoice(value: unknown, fallback: MasterVoiceSettings): MasterVoiceSettings {
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('음성 설정이 올바르지 않습니다.');
  const next = { ...fallback };
  for (const [key, item] of Object.entries(value)) {
    if (key === 'voice') {
      if (!(MASTER_VOICES as readonly unknown[]).includes(item)) throw invalid('목소리가 올바르지 않습니다.');
      next.voice = item as string;
    } else if (key === 'silenceSeconds') {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 600) throw invalid('침묵 시간이 올바르지 않습니다.');
      next.silenceSeconds = item;
    } else if (key === 'dailyMinutes') {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 1440) throw invalid('하루 한도가 올바르지 않습니다.');
      next.dailyMinutes = item;
    } else if (key === 'autoWake') {
      if (typeof item !== 'boolean') throw invalid('음성 설정이 올바르지 않습니다.');
      next.autoWake = item;
    } else throw invalid('음성 설정이 올바르지 않습니다.');
  }
  return next;
}

/** Parses a settings change against the current settings; unknown fields are refused. */
export function mergeSettings(current: MasterSettings, value: unknown): MasterSettings {
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
    else if (key === 'voice') next.voice = readVoice(item, next.voice);
    else throw invalid('마스터 설정이 올바르지 않습니다.');
  }
  return next;
}

/**
 * The owner's master settings and OpenAI key, each in its own owner-only file. The key is never returned; only its
 * last four characters are shown.
 */
export class MasterSettingsStore {
  private settings: MasterSettings = structuredClone(DEFAULT_MASTER_SETTINGS);
  private apiKey?: string;
  private changes: Promise<unknown> = Promise.resolve();
  private readonly settingsPath: string;
  private readonly keyPath: string;

  constructor(private readonly directory: string) {
    this.settingsPath = join(directory, 'settings.json');
    this.keyPath = join(directory, 'openai-key.json');
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const saved = await readPrivateJson(this.settingsPath).catch(() => undefined);
    try { if (saved) this.settings = mergeSettings(DEFAULT_MASTER_SETTINGS, saved); }
    catch { this.settings = structuredClone(DEFAULT_MASTER_SETTINGS); }
    const key = await readPrivateJson(this.keyPath).catch(() => undefined) as { apiKey?: unknown } | undefined;
    if (validKey(key?.apiKey)) this.apiKey = key.apiKey;
  }

  current(): MasterSettings { return structuredClone(this.settings); }
  key(): string | undefined { return this.apiKey; }
  keyHint(): string | undefined { return this.apiKey ? `…${this.apiKey.slice(-4)}` : undefined; }

  /** `apiKey: null` removes the key; any other field goes through `mergeSettings`. */
  update(body: Record<string, unknown>): Promise<MasterSettings> {
    const next = this.changes.then(async () => {
      const { apiKey, ...rest } = body;
      if (apiKey !== undefined && apiKey !== null && !validKey(apiKey)) throw invalid('OpenAI API 키 형식이 올바르지 않습니다.');
      const settings = Object.keys(rest).length ? mergeSettings(this.settings, rest) : this.settings;
      if (apiKey !== undefined) {
        await writePrivateJson(this.keyPath, JSON.stringify(apiKey === null ? {} : { apiKey }));
        this.apiKey = apiKey === null ? undefined : apiKey as string;
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
