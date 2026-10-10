import { externalSchema } from './storage-rows.js';
import { remoteCodec } from './storage-codec.js';
export const remoteSchema = externalSchema(remoteCodec);
