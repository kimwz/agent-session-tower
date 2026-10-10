import { workerSettingsFixture, closeWorkerSettingsFixture } from '../../remote/external-storage-fixture.js';
import type { WorkerSqlSettings } from '../../../../server/backup/payload.js';
import { empty } from '../../../../server/triggers/state.js';
import { collectTriggers } from '../../../helpers/legacy-trigger-backup.js';
/**
 * The payload one Tower release backs up from a fixture state folder, as compact JSON (key order kept), so a test can
 * show this build backs up the same state exactly as that release did:
 *
 *   node --import tsx tests/server/backup/fixtures/payload-of.ts <release tree> <state.json> <out.json>
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeState } from './state.ts';

export async function payloadOf(tree: string, files: Record<string, string>, sqlSettings?: WorkerSqlSettings): Promise<string> {
  const load = async (path: string) => import(pathToFileURL(resolve(tree, path)).href);
  const { BackupService } = await load('server/backup/service.ts');
  const { decryptBackup } = await load('server/backup/crypto.ts');
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-payload-of-'));
  try {
    await writeState(stateDir, files);
    const current = resolve(tree) === resolve(import.meta.dirname, '../../../..');
    const owner = current ? await workerSettingsFixture(stateDir) : undefined;
    if (owner) {
      if (!sqlSettings) throw new Error('Current payload fixture requires explicit SQL settings.');
      const permissions = sqlSettings['permissions.json'] as Record<string, unknown>;
      await owner.seed('permissions.json', { version: 1, rules: permissions.rules, requests: [], codex: [], ...(permissions.autoReview ? { autoReview: permissions.autoReview } : {}) });
      for (const name of ['slack-automation.json', 'github-automation.json'] as const) await owner.seed(name, { ...(sqlSettings[name] as object), workflows: [] });
      if (files['trigger-engine.json']) await owner.seedTriggers({ ...empty(), ...JSON.parse(Buffer.from(files['trigger-engine.json'], 'base64').toString('utf8')) });
    }
    const skills = { bundle: { format: 'agent-session-tower.skills', version: 1, exportedAt: '', from: 'fixture', skills: [] }, guidance: 'Be brief.', settings: { enabled: true, provider: 'claude' } };
    const store = (value: unknown) => ({ backupValue: () => structuredClone(value), restore: async () => undefined });
    const backup = new BackupService({ stateDir, ...(owner ? { settings: owner.collect } : {}), triggers: owner ? owner.triggersBackup : () => collectTriggers(stateDir), version: 'fixture', skills: async () => structuredClone(skills), restartWorker: async () => true,
      stores: { groups: store({ groups: [] }), exclusions: store({ folders: [] }), decisions: store({}) }, host: 'fixture' });
    await backup.start();
    const { payload } = await decryptBackup((await backup.export('fixture backup passphrase')).text, 'fixture backup passphrase');
    backup.close?.(); await backup.flush?.();
    return JSON.stringify(payload);
  } finally { await closeWorkerSettingsFixture(stateDir); await rm(stateDir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tree, state, out] = process.argv.slice(2);
  await writeFile(out, `${await payloadOf(tree, JSON.parse(await readFile(state, 'utf8')))}\n`);
}
