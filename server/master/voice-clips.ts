import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TowerError, type ErrorKind } from '../../shared/errors.js';
import type { StreamSink } from '../streams/sink.js';
import type { ElevenLabs, VoiceInfo } from './elevenlabs.js';
import type { MasterSettingsStore } from './settings.js';
import type { VoiceAudio } from './voice-audio.js';
import { VOICE_SAMPLE, voiced } from './voice-text.js';
import { ttsDollarsPerChar } from './tts-models.js';
import type { VoiceUsage } from './voice-usage.js';

const CLIP_BYTES = 5 * 1024 * 1024;
/** Voice samples kept for the settings: about one per voice an account lists. */
const PREVIEWS = 60;
const fail = (message: string, kind: ErrorKind) => new TowerError(kind, message);

/**
 * Fixed sentences recorded once and kept on disk: the voice samples the settings play. The only owner of the
 * recordings folder and of recordings being made; the audio itself is made by `VoiceAudio`.
 */
export class VoiceClips {
  /** Recordings being made, by digest. */
  private readonly recording = new Map<string, Promise<string>>();

  constructor(private readonly dir: string, private readonly audio: VoiceAudio, private readonly usage: VoiceUsage,
    private readonly settings: Pick<MasterSettingsStore, 'voiceKey' | 'current'>, private readonly elevenLabs: Pick<ElevenLabs, 'voices'>) {}

  /** A sample kept on disk, by its digest: a finite file with its length, or a bodiless 404 when it is not there. */
  async serve(key: string, sink: StreamSink): Promise<void> {
    const data = await readFile(join(this.dir, `${key}.mp3`)).catch(() => undefined);
    if (!data) { sink.refuse('not-found'); return; }
    sink.open({ length: data.length });
    sink.body.end(data);
  }

  /**
   * Audio of a fixed sentence in a voice and model, kept in `dir` under its digest and made only when it is not there;
   * the same recording asked for twice at once is made once. Made with exactly the voice and model it is kept under.
   */
  private record(dir: string, sent: string, voiceId: string, model: string, keep: number): Promise<string> {
    const key = createHash('sha256').update(JSON.stringify([voiceId, model, sent])).digest('hex');
    const known = this.recording.get(key);
    if (known) return known;
    const work = (async () => {
      const path = join(dir, `${key}.mp3`);
      if (await stat(path).then(() => true, () => false)) return key;
      if (this.usage.limited(Date.now(), sent.length * ttsDollarsPerChar(model))) throw new Error('limited');
      const live = this.audio.synthesize(sent, { voiceId, model });
      await this.audio.finished(live);
      // Not done in time: nothing more is asked for, and what came is not kept.
      const made = this.audio.snapshot(live);
      if (made.failed || !made.done) { this.audio.abandon(live); this.audio.drop(live); throw new Error('clip failed'); }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path, this.audio.bytes(live), { mode: 0o600 });
      this.audio.drop(live);
      await this.prune(dir, key, keep);
      return key;
    })();
    this.recording.set(key, work);
    void work.catch(() => {}).finally(() => this.recording.delete(key));
    return work;
  }

  /** At most `keep` recordings and `CLIP_BYTES` in all, the newest kept (and the one just made, always). */
  private async prune(dir: string, keep: string, most: number): Promise<void> {
    const names = (await readdir(dir).catch(() => [] as string[])).filter(name => /^[a-f0-9]{64}\.mp3$/.test(name));
    const files = await Promise.all(names.map(async name => ({ name, info: await stat(join(dir, name)).catch(() => undefined) })));
    const known = files.filter((file): file is { name: string; info: NonNullable<typeof file.info> } => Boolean(file.info))
      .sort((a, b) => (b.name === `${keep}.mp3` ? 1 : 0) - (a.name === `${keep}.mp3` ? 1 : 0) || b.info.mtimeMs - a.info.mtimeMs);
    let bytes = 0;
    for (const [index, file] of known.entries()) {
      bytes += file.info.size;
      if (index > 0 && (index >= most || bytes > CLIP_BYTES)) await unlink(join(dir, file.name)).catch(() => {});
    }
  }

  /**
   * A short sample in a voice, for the owner choosing one in the settings: read with the model set now and its tone
   * (none on Eleven v4 Turbo), made once per voice and model, and paid for like anything else read aloud. Needs only the key.
   */
  async preview(input: { voiceId: unknown }): Promise<{ audio: string }> {
    if (!this.settings.voiceKey()) throw fail('ElevenLabs API 키가 없습니다. 마스터 설정에서 넣어 주세요.', 'conflict');
    if (typeof input.voiceId !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(input.voiceId)) throw fail('목소리가 올바르지 않습니다.', 'invalid');
    const { model } = this.settings.current().voice;
    try {
      const key = await this.record(this.dir, voiced(VOICE_SAMPLE, model, 'answer'), input.voiceId, model, PREVIEWS);
      return { audio: `/api/master/voice/audio/preview-${key}` };
    } catch (error) {
      if ((error as Error).message === 'limited') throw fail('오늘 음성 한도에 닿았습니다.', 'conflict');
      throw fail('미리 듣기를 만들지 못했습니다. 이 계정에서 쓸 수 있는 목소리인지 확인해 주세요.', 'upstream');
    }
  }

  /** Voices the account can use; needs only the key, so a voice can be chosen before the master session starts. */
  async voices(): Promise<VoiceInfo[]> {
    if (!this.settings.voiceKey()) throw fail('ElevenLabs API 키가 없습니다. 마스터 설정에서 넣어 주세요.', 'conflict');
    return this.elevenLabs.voices();
  }
}
