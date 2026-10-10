import { externalDomain } from './storage-row-commands.js';
import { remoteCodec } from './storage-codec.js';
import { remoteSchema } from './storage-schema.js';
export const remoteDomain = externalDomain(remoteSchema,remoteCodec);
