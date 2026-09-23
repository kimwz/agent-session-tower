/** Release version. tests/app-identity.test.ts keeps it equal to package.json. */
export const APP_VERSION = '1.11.0';
export const APP_TITLE = 'Agent Session Tower';
export const APP_NAME = 'agent-session-tower';

/**
 * The project's first name. It stays in every identifier that outlives a release: the state
 * directory, browser storage keys, the health probe, and the request-token header. Renaming any
 * of them would orphan a user's saved state or break a running older instance's detection.
 */
export const LEGACY_APP_NAME = 'agent-monitor';
export const STATE_DIR_NAME = `.${LEGACY_APP_NAME}`;
export const HEALTH_APPLICATION_ID = LEGACY_APP_NAME;
export const REQUEST_TOKEN_HEADER = 'X-Agent-Monitor-Token';
