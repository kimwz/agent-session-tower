import { externalDomain } from '../remote/storage-row-commands.js';
import { autoPromptSchema } from './storage-schema.js';
import { autoPromptCodec } from './storage-codec.js';
export const autoPromptDomain = externalDomain(autoPromptSchema,autoPromptCodec);
