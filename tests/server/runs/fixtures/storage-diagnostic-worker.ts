import { SessionService } from '../../../../server/sessions/service.js';
import { TemporaryCollector } from '../../../../server/temporary/directories.js';
import { channel } from 'node:diagnostics_channel';
import { writeFileSync, readFileSync } from 'node:fs';
import { runRunnerWorker } from '../../../../server/runs/worker.js';
import { StorageClient, StorageCommandError } from '../../../../server/storage/index.js';
import { PermissionService } from '../../../../server/permissions/service.js';
import { AutoPromptManager } from '../../../../server/auto-prompt/manager.js';
import { WorktreeJanitor } from '../../../../server/worktrees/janitor.js';
import { RunManager } from '../../../../server/runs/manager.js';
import type { Session } from '../../../../shared/types.js';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Count calls while retaining the actual scanner, collector and native adapter.
if (process.env.TOWER_FIXTURE_COLD_COUNTS === '1') {
  const state = process.argv.at(-1)!;
  const counts = { scanner: 0, temporary: 0, native: 0 };
  const save = () => writeFileSync(join(state, 'fixture-cold-counts.json'), JSON.stringify(counts), { mode: 0o600 });
  save();
  const registry = SessionService.prototype.setColdRegistry;
  SessionService.prototype.setColdRegistry = function (paths, ids, reconcile) {
    const knownPaths = [...paths], knownIds = [...ids];
    writeFileSync(join(state, 'fixture-cold-registry.json'), JSON.stringify({ paths: knownPaths, ids: knownIds }), { mode: 0o600 });
    return registry.call(this, knownPaths, knownIds, reconcile);
  };
  const start = SessionService.prototype.start;
  SessionService.prototype.start = async function () { writeFileSync(join(state, 'fixture-firstscan-registry.json'), readFileSync(join(state, 'fixture-cold-registry.json')), { mode: 0o600 }); counts.scanner++; save(); return start.call(this); };
  const collect = TemporaryCollector.prototype.start;
  TemporaryCollector.prototype.start = function () { counts.temporary++; save(); return collect.call(this); };
  channel('tower.retention.codex-metadata-open').subscribe(() => { counts.native++; save(); });
}

// Existing disposable worker fixture only: real SDK commands fail at a later startup gate,
// after permissions and auto prompts have started. No storage result is mocked as successful.
const startupFault = process.env.TOWER_FIXTURE_STORAGE_STARTUP;
if (startupFault === '1' || startupFault === 'late' || startupFault === 'command') {
  const state = process.argv.at(-1)!;
  const counts = { permissions: 0, autoPrompts: 0 };
  const saveCounts = () => writeFile(join(state, 'fixture-startup-counts.json'), JSON.stringify(counts), { mode: 0o600 });
  let armed = false;
  if (startupFault === 'command') {
    // The same synthetic-session adapter used by run fixtures; no native home or provider is read.
    const getSession = RunManager.prototype.getSession;
    const at = new Date().toISOString();
    const session: Session = { id: 'codex:fixture-command', nativeId: 'fixture-command', provider: 'codex', title: 'Owned command', cwd: state, project: 'fixture', status: 'completed', statusReason: 'Fixture', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 0, isSubagent: false, resumable: false };
    RunManager.prototype.getSession = function (id) { return id === session.id ? session : getSession.call(this, id); };
  }
  let permissionService: PermissionService | undefined;
  const permissionStart = PermissionService.prototype.start;
  PermissionService.prototype.start = async function () {
    counts.permissions++; await saveCounts(); await permissionStart.call(this); armed = startupFault === '1';
    permissionService = this;
  };
  const reconcile = PermissionService.prototype.reconcileNotifications;
  let reconciliations = 0;
  PermissionService.prototype.reconcileNotifications = async function () {
    const current = ++reconciliations;
    await reconcile.call(this);
    if (startupFault === 'late' && current === 2) armed = true;

  };
  const janitorStart = WorktreeJanitor.prototype.start;
  WorktreeJanitor.prototype.start = async function () {
    await janitorStart.call(this);
    if (startupFault === 'command') {
      const started = join(state, 'fixture-command-started'); const finish = join(state, 'fixture-command-finish');
      const asked = await permissionService!.requestRun({ command: `echo started > '${started}'; while [ ! -f '${finish}' ]; do sleep 0.05; done; echo completed`, reason: 'fixture-owned command across startup hold', timeoutSeconds: 30 }, { kind: 'agent', sessionId: 'codex:fixture-command' });
      await permissionService!.decide(asked.request.id, true);
      const deadline = Date.now() + 10000;
      for (;;) {
        try { await readFile(started); break; } catch { if (Date.now() > deadline) throw new Error('Owned permission command did not start.'); }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await writeFile(join(state, 'fixture-command-id'), asked.request.id, { mode: 0o600 });
      armed = true;
    }
  };
  const autoPromptStart = AutoPromptManager.prototype.start;
  AutoPromptManager.prototype.start = async function () {
    counts.autoPrompts++; await saveCounts(); await autoPromptStart.call(this);
  };
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
// Pause a real retry prepare await; the parent fixture can submit a newer durable hold over RPC.
if (process.env.TOWER_FIXTURE_STORAGE_RETRY === 'new-hold') {
  const state = process.argv.at(-1)!;
  const prepare = StorageClient.prototype.prepare;
  let blocked = false;
  StorageClient.prototype.prepare = async function (options) {
    if (!blocked) {
      try {
        await readFile(join(state, 'fixture-retry-arm'));
        blocked = true;
        await writeFile(join(state, 'fixture-retry-waiting'), 'waiting', { mode: 0o600 });
        const deadline = Date.now() + 15000;
        for (;;) {
          try { await readFile(join(state, 'fixture-retry-release')); break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() > deadline) throw error; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return prepare.call(this, options);
  };
}
await runRunnerWorker(process.argv.at(-1)!);
