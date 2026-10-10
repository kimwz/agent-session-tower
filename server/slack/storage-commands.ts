import { externalDomain } from '../remote/storage-row-commands.js';
import { workflowsSchema } from './storage-schema.js';
import { workflowCodec } from './storage-codec.js';
export const workflowsDomain = externalDomain(workflowsSchema,workflowCodec);
