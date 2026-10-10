import { chmod } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { externalStorageFixture } from '../remote/external-storage-fixture.js';
import { recordPreparationEvidence } from '../../../server/link/storage-update.js';
import { TriggersRepository } from '../../../server/triggers/storage-repository.js';
import { bootstrapTriggers } from '../../../server/triggers/storage-transfer.js';

/** API consumers share the existing seven-schema SDK and real trigger authority receipt. */
export async function apiTriggerStorageFixture(t: TestContext, stateDir: string) {
  await chmod(stateDir, 0o700);
  const fixture = await externalStorageFixture(t, stateDir, true, 'normal', false);
  try {
    const { storage, captured } = fixture;
    const preflight = await captured.storage.preflightStorage({ stateDir, bundle: captured.bundle() });
    await recordPreparationEvidence(stateDir, {
      context: storage.context!, preflight,
      prepared: await storage.prepare({ allowMigration: false }), gate: await storage.gate('core'),
    });
    await bootstrapTriggers(new TriggersRepository(storage), stateDir, {
      now: Date.now,
      update: async () => ({ stateDir, managed: false, build: {
        version: captured.version, manifest: captured.manifest,
        preflight: await captured.storage.preflightStorage({ stateDir, bundle: captured.bundle() }),
      } }),
    });
    return fixture;
  } catch (error) {
    await fixture.storage.close();
    throw error;
  }
}
