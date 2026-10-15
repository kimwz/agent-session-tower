import { chmod } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { externalStorageFixture } from '../remote/external-storage-fixture.js';

/** API consumers share the current build's seven-domain storage, every domain authority (triggers included) present. */
export async function apiTriggerStorageFixture(t: TestContext, stateDir: string) {
  await chmod(stateDir, 0o700);
  return externalStorageFixture(t, stateDir, true, 'normal', false);
}
