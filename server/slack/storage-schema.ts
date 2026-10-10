import { externalSchema } from '../remote/storage-rows.js';
import { workflowCodec } from './storage-codec.js';
export const workflowsSchema = externalSchema(workflowCodec);
