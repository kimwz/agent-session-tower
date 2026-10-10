import { remoteDomain } from '../../remote/storage-commands.js';
import { autoPromptDomain } from '../../auto-prompt/storage-commands.js';
import { workflowsDomain } from '../../slack/storage-commands.js';
import { permissionsDomain } from '../../permissions/storage-commands.js';
import { triggersDomain } from '../../triggers/storage-commands.js';
import { runsDomain } from '../../runs/storage-commands.js';
import { retentionDomain } from '../../sessions/retention/storage-commands.js';
import { runStorageThread } from './runtime.js';

/**
 * The production thread entry, bundled into one script by thread-bundle.mjs. Domain schema owners add their
 * StorageDomain here together with their schema in STORAGE_DOMAIN_SCHEMAS (schema.ts); the handshake refuses a
 * thread whose domains differ from the worker's manifest.
 */
runStorageThread([retentionDomain, runsDomain, triggersDomain, permissionsDomain, remoteDomain, autoPromptDomain, workflowsDomain]);
