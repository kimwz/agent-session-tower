import { externalSchema } from '../remote/storage-rows.js';
import { autoPromptCodec } from './storage-codec.js';
export const autoPromptSchema = externalSchema(autoPromptCodec);
