import type { MasterTtsModel } from '../../shared/master.js';

/**
 * What Tower relies on for each ElevenLabs model it reads aloud with: whether it follows audio tags (any other model
 * reads a tag out as words) and its estimated price per character.
 */
export interface TtsModel { tags: boolean; dollarsPerChar: number }

const MODELS: Record<MasterTtsModel, TtsModel> = {
  eleven_v3_conversational: { tags: true, dollarsPerChar: 0.05 / 1000 },
  eleven_v3: { tags: true, dollarsPerChar: 0.1 / 1000 },
  eleven_flash_v2_5: { tags: false, dollarsPerChar: 0.05 / 1000 },
};
/** A model this build does not offer, as old usage records may name: no tags, the lower price. */
const OTHER: TtsModel = { tags: false, dollarsPerChar: 0.05 / 1000 };

export const ttsModel = (model: string): TtsModel => Object.hasOwn(MODELS, model) ? MODELS[model as MasterTtsModel] : OTHER;
export const ttsDollarsPerChar = (model: string): number => ttsModel(model).dollarsPerChar;
