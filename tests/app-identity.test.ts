import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { APP_NAME, APP_VERSION, HEALTH_APPLICATION_ID, REQUEST_TOKEN_HEADER, STATE_DIR_NAME } from '../shared/app-identity.ts';

test('the published package and the running app report the same name and version', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, manifest.version);
  assert.equal(APP_NAME, manifest.name);
});

test('identifiers that outlive a release keep their original values', () => {
  assert.equal(STATE_DIR_NAME, '.agent-monitor');
  assert.equal(HEALTH_APPLICATION_ID, 'agent-monitor');
  assert.equal(REQUEST_TOKEN_HEADER, 'X-Agent-Monitor-Token');
});
