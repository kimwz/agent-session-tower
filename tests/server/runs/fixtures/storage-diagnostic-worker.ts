import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runRunnerWorker } from '../../../../server/runs/worker.js';
import { StorageClient, StorageCommandError } from '../../../../server/storage/index.js';
import { PermissionService } from '../../../../server/permissions/service.js';
import { WorktreeJanitor } from '../../../../server/worktrees/janitor.js';
import { RunManager } from '../../../../server/runs/manager.js';
import type { Session } from '../../../../shared/types.js';
import { CheckDriver } from './worker-checks.ts';

const state = process.argv.at(-1)!;

// An owned permission command started during startup, then a real SDK failure at the next startup gate: the worker
// parks in its diagnostic host while the command still runs. Nothing is mocked as successful.
if (process.env.TOWER_FIXTURE_STORAGE_STARTUP === 'command') {
  // The same synthetic-session adapter used by run fixtures; no native home or provider is read.
  const getSession = RunManager.prototype.getSession;
  const at = new Date().toISOString();
  const session: Session = { id: 'codex:fixture-command', nativeId: 'fixture-command', provider: 'codex', title: 'Owned command', cwd: state, project: 'fixture', status: 'completed', statusReason: 'Fixture', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 0, isSubagent: false, resumable: false };
  RunManager.prototype.getSession = function (id) { return id === session.id ? session : getSession.call(this, id); };
  let permissionService: PermissionService | undefined;
  const permissionStart = PermissionService.prototype.start;
  PermissionService.prototype.start = async function () { await permissionStart.call(this); permissionService = this; };
  let armed = false;
  const janitorStart = WorktreeJanitor.prototype.start;
  WorktreeJanitor.prototype.start = async function () {
    await janitorStart.call(this);
    const started = join(state, 'fixture-command-started'); const finish = join(state, 'fixture-command-finish');
    const asked = await permissionService!.requestRun({ command: `echo started > '${started}'; while [ ! -f '${finish}' ] && [ -d '${state}' ]; do sleep 0.05; done; echo completed`, reason: 'fixture-owned command across startup hold', timeoutSeconds: 60 }, { kind: 'agent', sessionId: 'codex:fixture-command' });
    await permissionService!.decide(asked.request.id, true);
    for (;;) {
      try { await readFile(started); break; } catch { /* The command has not written its start yet. */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await writeFile(join(state, 'fixture-command-id'), asked.request.id, { mode: 0o600 });
    armed = true;
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

// Each completed handoff check appends one byte, so a test counts real checks instead of waiting for them.
const scheduleChecks = process.env.TOWER_FIXTURE_CHECKS === '1'
  ? new CheckDriver(20, () => appendFileSync(join(state, 'fixture-checks'), '.')).schedule : undefined;
await runRunnerWorker(state, scheduleChecks ? { scheduleChecks } : {});
