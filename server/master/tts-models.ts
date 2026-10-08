import type { MasterTtsModel } from '../../shared/master.js';

/**
 * What Tower relies on for each ElevenLabs model it reads aloud with: whether it follows audio tags (any other model
 * reads a tag out as words), whether Tower puts a tone tag in front (`VOICE_TONES`), its estimated price per character,
 * and the request that makes its sound: `speech` (Text to Speech, one voice) or `dialogue` (Text to Dialogue, the
 * request ElevenLabs offers Eleven v4 through).
 */
export interface TtsModel { tags: boolean; tone: boolean; dollarsPerChar: number; request: 'speech' | 'dialogue' }

const MODELS: Record<MasterTtsModel, TtsModel> = {
  // Priced as v3 conversational: ElevenLabs bills both at half a credit per character. It follows tags, but acts a
  // tone tag out too strongly (the owner's judgment), so Tower adds none; brackets in the text are still made words.
  eleven_v4_turbo: { tags: true, tone: false, dollarsPerChar: 0.05 / 1000, request: 'dialogue' },
  eleven_v3_conversational: { tags: true, tone: true, dollarsPerChar: 0.05 / 1000, request: 'speech' },
  eleven_v3: { tags: true, tone: true, dollarsPerChar: 0.1 / 1000, request: 'speech' },
  eleven_flash_v2_5: { tags: false, tone: false, dollarsPerChar: 0.05 / 1000, request: 'speech' },
};
/** A model this build does not offer, as old usage records may name: no tags, the lower price. */
const OTHER: TtsModel = { tags: false, tone: false, dollarsPerChar: 0.05 / 1000, request: 'speech' };

export const ttsModel = (model: string): TtsModel => Object.hasOwn(MODELS, model) ? MODELS[model as MasterTtsModel] : OTHER;
export const ttsDollarsPerChar = (model: string): number => ttsModel(model).dollarsPerChar;
