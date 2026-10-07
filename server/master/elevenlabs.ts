import { TowerError } from '../../shared/errors.js';
import { ttsModel } from './tts-models.js';
/**
 * The only code that knows ElevenLabs: single-use tokens for the page's own speech-to-text connection, reading aloud
 * as a stream (Text to Speech or Text to Dialogue), the account's voices, and removing what reading aloud leaves in the
 * account's history. The key is used here, on this computer, and nowhere else.
 */

export interface ElevenLabsOptions {
  key: () => string | undefined;
  fetcher?: typeof fetch;
  /** Tests point these at fakes; the defaults are ElevenLabs' own. */
  apiBase?: string;
  sttBase?: string;
  /** How long to wait before removing a history item, each try (it cannot be removed until it is final). */
  historyDelaysMs?: number[];
}

export interface VoiceInfo { id: string; name: string; category?: string }

const API = 'https://api.elevenlabs.io';
const STT = 'wss://api.elevenlabs.io';

export class ElevenLabs {
  private readonly fetcher: typeof fetch;
  readonly apiBase: string;
  readonly sttBase: string;

  constructor(private readonly options: ElevenLabsOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.apiBase = options.apiBase ?? process.env.TOWER_ELEVENLABS_API ?? API;
    this.sttBase = options.sttBase ?? process.env.TOWER_ELEVENLABS_STT ?? STT;
  }

  private headers(): Record<string, string> {
    const key = this.options.key();
    if (!key) throw new TowerError('conflict', 'ElevenLabs API 키가 없습니다.');
    return { 'xi-api-key': key };
  }

  /** A token the page uses once, within 15 minutes, to write down one thing the owner says. */
  async sttToken(signal?: AbortSignal): Promise<string> {
    const response = await this.fetcher(`${this.apiBase}/v1/single-use-token/realtime_scribe`, { method: 'POST', headers: this.headers(), signal: signal ?? AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => undefined) as { token?: unknown; detail?: unknown } | undefined;
    if (!response.ok || typeof body?.token !== 'string') throw new TowerError(response.status >= 400 && response.status < 500 ? 'conflict' : 'upstream', `받아쓰기 토큰을 받지 못했습니다 (HTTP ${response.status}).`);
    return body.token;
  }

  /** Where the page connects with that token, as ElevenLabs' realtime speech-to-text expects. */
  sttUrl(token: string): string {
    const query = new URLSearchParams({ model_id: 'scribe_v2_realtime', language_code: 'kor', audio_format: 'pcm_16000', token });
    return `${this.sttBase}/v1/speech-to-text/realtime?${query}`;
  }

  /** Voices the account can use, premade and its own. */
  async voices(): Promise<VoiceInfo[]> {
    const found: VoiceInfo[] = [];
    let page: string | undefined;
    for (let round = 0; round < 3; round++) {
      const query = new URLSearchParams({ page_size: '100', ...(page ? { next_page_token: page } : {}) });
      const response = await this.fetcher(`${this.apiBase}/v2/voices?${query}`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      const body = await response.json().catch(() => undefined) as { voices?: Array<{ voice_id?: unknown; name?: unknown; category?: unknown }>; has_more?: unknown; next_page_token?: unknown } | undefined;
      if (!response.ok || !Array.isArray(body?.voices)) throw new TowerError('upstream', `목소리 목록을 받지 못했습니다 (HTTP ${response.status}).`);
      for (const voice of body.voices) {
        if (typeof voice.voice_id === 'string' && /^[A-Za-z0-9]{10,64}$/.test(voice.voice_id) && typeof voice.name === 'string') {
          found.push({ id: voice.voice_id, name: voice.name.slice(0, 80), ...(typeof voice.category === 'string' ? { category: voice.category } : {}) });
        }
      }
      if (body.has_more !== true || typeof body.next_page_token !== 'string') break;
      page = body.next_page_token;
    }
    return found;
  }

  /**
   * Reads text aloud: mp3 chunks as ElevenLabs makes them, the same 128 kbps mp3 from either request. What it keeps in
   * the account's history is removed once it can be (a request not to log it is ignored on ordinary plans).
   */
  async *speak(text: string, voiceId: string, model: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const query = 'output_format=mp3_44100_128&enable_logging=false';
    // Eleven v4 is offered through Text to Dialogue: one line in the one voice. A dialogue request is reliable up to
    // 2,000 characters; each part Tower sends stays within that (tests/master/tts-models.test.ts).
    const [url, body] = ttsModel(model).request === 'dialogue'
      ? [`${this.apiBase}/v1/text-to-dialogue/stream?${query}`, { inputs: [{ text, voice_id: voiceId }], model_id: model, language_code: 'ko' }]
      : [`${this.apiBase}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?${query}`, { text, model_id: model, language_code: 'ko' }];
    const response = await this.fetcher(url, { method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' }, signal, body: JSON.stringify(body) });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`읽어 주기에 실패했습니다 (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) yield Buffer.from(chunk);
    } finally {
      this.forget(response.headers.get('history-item-id'));
    }
  }

  private forget(id: string | null, attempt = 0): void {
    const delays = this.options.historyDelaysMs ?? [5_000, 20_000, 60_000];
    if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || attempt >= delays.length) return;
    const timer = setTimeout(() => {
      let headers: Record<string, string>;
      try { headers = this.headers(); } catch { return; }
      void this.fetcher(`${this.apiBase}/v1/history/${encodeURIComponent(id)}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) })
        // Not final yet (404) or unreachable: tried again later; any other answer is final.
        .then(response => { if (response.status === 404 || response.status >= 500) this.forget(id, attempt + 1); })
        .catch(() => this.forget(id, attempt + 1));
    }, delays[attempt]);
    timer.unref();
  }
}
