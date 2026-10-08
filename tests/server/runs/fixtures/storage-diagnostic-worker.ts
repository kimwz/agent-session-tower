import { runRunnerWorker } from '../../../../server/runs/worker.js';
import { StorageClient, StorageCommandError } from '../../../../server/storage/index.js';
import { PermissionService } from '../../../../server/permissions/service.js';
import { AutoPromptManager } from '../../../../server/auto-prompt/manager.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Existing disposable worker fixture only: real SDK commands fail at a later startup gate,
// after permissions and auto prompts have started. No storage result is mocked as successful.
const startupFault = process.env.TOWER_FIXTURE_STORAGE_STARTUP;
if (startupFault === '1' || startupFault === 'late') {
  const state = process.argv.at(-1)!;
  const counts = { permissions: 0, autoPrompts: 0 };
  const saveCounts = () => writeFile(join(state, 'fixture-startup-counts.json'), JSON.stringify(counts), { mode: 0o600 });
  let armed = false;
  const permissionStart = PermissionService.prototype.start;
  PermissionService.prototype.start = async function () {
    counts.permissions++; await saveCounts(); await permissionStart.call(this); armed = startupFault === '1';
  };
  const reconcile = PermissionService.prototype.reconcileNotifications;
  let reconciliations = 0;
  PermissionService.prototype.reconcileNotifications = async function () {
    const current = ++reconciliations;
    await reconcile.call(this);
    if (startupFault === 'late' && current === 2) armed = true;
  };
  const autoPromptStart = AutoPromptManager.prototype.start;
  AutoPromptManager.prototype.start = async function () { counts.autoPrompts++; await saveCounts(); await autoPromptStart.call(this); };
  const gate = StorageClient.prototype.gate;
  StorageClient.prototype.gate = async function (scope) {
    // Background permission writes also call gate(core); fault only the awaited startup continuation.
    if (armed && new Error().stack?.includes('startupGate')) {
      armed = false;
      await this.close();
      try { await this.prepare({ allowMigration: false }); }
      catch (error) {
        if (!(error instanceof StorageCommandError)) throw error;
        await writeFile(join(state, 'fixture-startup-failure.json'), JSON.stringify({ code: error.code, phase: error.phase, disposition: error.disposition }), { mode: 0o600 });
        throw error;
      }
      throw new Error('The actual SDK unexpectedly prepared closed storage.');
    }
    return gate.call(this, scope);
  };
}
await runRunnerWorker(process.argv.at(-1)!);
