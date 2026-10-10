import { DatabaseSync } from 'node:sqlite';
import { RetentionStore } from '../../../../server/sessions/retention/store.js';
import { SessionService } from '../../../../server/sessions/service.js';
import { TemporaryCollector } from '../../../../server/temporary/directories.js';
import { channel } from 'node:diagnostics_channel';
import { writeFileSync, readFileSync } from 'node:fs';
import { runRunnerWorker } from '../../../../server/runs/worker.js';
import { StorageClient, StorageCommandError } from '../../../../server/storage/index.js';
import { TriggerService } from '../../../../server/triggers/service.js';
import { PermissionService } from '../../../../server/permissions/service.js';
import { AutoPromptManager } from '../../../../server/auto-prompt/manager.js';
import { WorktreeJanitor } from '../../../../server/worktrees/janitor.js';
import { RunManager } from '../../../../server/runs/manager.js';
import type { Session } from '../../../../shared/types.js';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Damage the fixture-owned SQL journal only at the real cold reader, after all-domain bootstrap.
// Earlier source/preparation failures would exercise a different gate; no successful result is mocked.
const coldSqlDamage = process.env.TOWER_FIXTURE_COLD_SQL_DAMAGE;
if (coldSqlDamage) {
  const allowed = ['malformed', 'missing-source', 'missing-wrapper', 'missing-state'];
  if (!allowed.includes(coldSqlDamage)) throw new Error('Unknown cold SQL fixture fault.');
  const start = RetentionStore.prototype.start;
  let injected = false;
  RetentionStore.prototype.start = async function (...args) {
    if (!injected) {
      const state = process.argv.at(-1)!;
      const db = new DatabaseSync(join(state, 'state.sqlite'));
      try {
        if (!db.prepare("SELECT * FROM domain_imports WHERE domain = 'retention' AND authority = 'database'").get())
          throw new Error('Cold SQL fault requires the real retention authority.');
        if (coldSqlDamage === 'missing-state') db.prepare('DELETE FROM retention_state').run();
        else if (coldSqlDamage === 'malformed') db.prepare("UPDATE retention_metadata SET json = ? WHERE kind = 'journal'").run('{unknown journal');
        else db.prepare("DELETE FROM retention_metadata WHERE kind = 'journal'").run();
        injected = true;
      } finally { db.close(); }
    }
    return start.apply(this, args);
  };
}

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

// Pause only the successful product bootstrap response, after its real SDK import/commit completed.
if (process.env.TOWER_FIXTURE_RUNS_BOOTSTRAP === 'new-hold') {
  const state = process.argv.at(-1)!;
  const bootstrap = RunManager.prototype.bootstrapStorage;
  let successes = 0;
  RunManager.prototype.bootstrapStorage = async function (update) {
    await bootstrap.call(this, update);
    successes++;
    await writeFile(join(state, 'fixture-bootstrap-successes.json'), JSON.stringify(successes), { mode: 0o600 });
    if (successes === 1) {
      await writeFile(join(state, 'fixture-bootstrap-waiting'), 'actual bootstrap committed', { mode: 0o600 });
      const deadline = Date.now() + 15000;
      for (;;) {
        try { await readFile(join(state, 'fixture-bootstrap-release')); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() > deadline) throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  };
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
// The disposable diagnostic adapter keeps actual services and SDK runtime. Only the provider model
// is replaced by this test's compile profile, and the second real start waits on an owned file barrier.
if (process.env.TOWER_FIXTURE_TRIGGER_RETRY === '1') {
  const state = process.argv.at(-1)!;
  const listAutoPrompts = AutoPromptManager.prototype.list;
  AutoPromptManager.prototype.list = function () {
    const jobs = listAutoPrompts.call(this);
    writeFileSync(join(state, 'fixture-trigger-ap-diagnostic.json'), JSON.stringify({ jobs }), { mode: 0o600 });
    return jobs;
  };
  const countsPath = join(state, 'fixture-trigger-counts.json');
  const bump = (key: 'start' | 'review' | 'apply') => {
    const counts = JSON.parse(readFileSync(countsPath, 'utf8')); counts[key]++;
    writeFileSync(countsPath, JSON.stringify(counts), { mode: 0o600 });
  };
  writeFileSync(countsPath, JSON.stringify({ start: 0, review: 0, model: 0, apply: 0, settled: false }), { mode: 0o600 });
  const at = '2026-10-01T00:00:00.000Z';
  const session: Session = { id: 'codex:fixture-trigger-review', nativeId: 'fixture-trigger-review', provider: 'codex', title: 'Trigger review',
    cwd: join(state, 'project'), project: 'fixture', status: 'completed', statusReason: 'Fixture', createdAt: at, updatedAt: at,
    lastMessage: '', messageCount: 1, isSubagent: false, resumable: false };
  const getSession = RunManager.prototype.getSession;
  RunManager.prototype.getSession = function (id) { return id === session.id ? session : getSession.call(this, id); };
  const origin = RunManager.prototype.sessionOrigin;
  RunManager.prototype.sessionOrigin = function (id) { return id === session.id
    ? { kind: 'trigger', triggerId: '10000000-0000-4000-8000-000000000001', untrustedInput: false } : origin.call(this, id); };
  const native = RunManager.prototype.nativeSessionId;
  RunManager.prototype.nativeSessionId = function (id) { return id === session.id ? session.nativeId : native.call(this, id); };
  const detail = SessionService.prototype.detail;
  SessionService.prototype.detail = async function (id, before, limit, options) { return id === session.nativeId
    ? { session, messages: [{ id: 'fixture-word', role: 'user', text: 'Use the restored trigger instructions.', timestamp: at }], hasMore: false }
    : detail.call(this, id, before, limit, options); };
  PermissionService.prototype.reviewModel = async () => ({ provider: 'codex', model: 'fixture-model' });
  const permissionDiagnosticPath = join(state, 'fixture-trigger-permission-diagnostic.json');
  const permissionEvents: unknown[] = [];
  const recordPermission = (service: PermissionService, boundary: string, result?: unknown) => {
    // Fixture-only field observation; never load/head/gate or change product state.
    if (permissionEvents.length >= 64) return;
    try {
      const current = service as unknown as { closed: boolean; storagePaused: boolean; options: { repository?: {
        loadedEpoch?: number; loaded?: { revision: number | null; authority?: unknown };
        storage: { status(): { ownerEpoch?: number; state: string } }; effectsAvailable(): boolean;
      } } };
      const repository = current.options.repository, status = repository?.storage.status();
      const overview = service.overview();
      permissionEvents.push({ boundary, result, closed: current.closed, storagePaused: current.storagePaused,
        loadedEpoch: repository?.loadedEpoch ?? null, statusOwnerEpoch: status?.ownerEpoch ?? null,
        loadedRevision: repository?.loaded?.revision ?? null, loadedHead: repository?.loaded ?? null,
        storageState: status?.state ?? null, repositoryEffectsAvailable: repository?.effectsAvailable() ?? null,
        autoReview: overview.autoReview, requests: overview.requests });
      writeFileSync(permissionDiagnosticPath, JSON.stringify(permissionEvents), { mode: 0o600 });
    } catch { /* Observation cannot change the original return/throw contract. */ }
  };
  const observeFailure = (error: unknown) => error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack } : { thrown: String(error) };
  for (const method of ['pauseForStorage', 'resume'] as const) {
    const original = PermissionService.prototype[method];
    PermissionService.prototype[method] = function () {
      recordPermission(this, `${method}.before`);
      try { const result = original.call(this); recordPermission(this, `${method}.after`); return result; }
      catch (error) { recordPermission(this, `${method}.failed`, observeFailure(error)); throw error; }
    };
  }
  const bind = PermissionService.prototype.bindAfterStorageRetry;
  PermissionService.prototype.bindAfterStorageRetry = function () {
    recordPermission(this, 'bindAfterStorageRetry.before');
    try {
      const result = bind.call(this);
      void result.then(() => recordPermission(this, 'bindAfterStorageRetry.after'),
        error => recordPermission(this, 'bindAfterStorageRetry.failed', observeFailure(error)));
      return result;
    } catch (error) { recordPermission(this, 'bindAfterStorageRetry.failed', observeFailure(error)); throw error; }
  };
  const nextReview = PermissionService.prototype.nextReview;
  PermissionService.prototype.nextReview = function () {
    const next = nextReview.call(this);
    recordPermission(this, 'nextReview', { selected: next?.id ?? null });
    return next;
  };
  const bootstrapEffects = PermissionService.prototype.bootstrapEffects;
  PermissionService.prototype.bootstrapEffects = async function (closed) {
    recordPermission(this, 'bootstrapEffects.before', { closed: [...closed] });
    await bootstrapEffects.call(this, closed);
    recordPermission(this, 'bootstrapEffects.after');
  };
  const permissionsStart = PermissionService.prototype.start;
  PermissionService.prototype.start = async function () {
    await permissionsStart.call(this);
    await this.saveAutoReview({ enabled: true, resume: false });
    const requested = await this.request({ kind: 'command', value: 'printf fixture', scope: 'project', providers: ['codex'], reason: 'queued before trigger restoration' }, { kind: 'agent', sessionId: session.id });
    recordPermission(this, 'start.requested', requested);
  };
  const review = PermissionService.prototype.startReview;
  PermissionService.prototype.startReview = function (id) {
    bump('review'); recordPermission(this, 'startReview.before', { id });
    try {
      const result = review.call(this, id);
      void result.then(value => recordPermission(this, 'startReview.after', { id, value }),
        error => recordPermission(this, 'startReview.failed', { id, ...observeFailure(error) }));
      return result;
    } catch (error) { recordPermission(this, 'startReview.failed', { id, ...observeFailure(error) }); throw error; }
  };
  const apply = PermissionService.prototype.applyReview;
  PermissionService.prototype.applyReview = function (id, result) { bump('apply'); return apply.call(this, id, result); };
  const start = TriggerService.prototype.start;
  let attempts = 0;
  TriggerService.prototype.start = async function (options) {
    bump('start');
    if (++attempts === 1) throw new Error('fixture trigger start failure');
    await writeFile(join(state, 'fixture-trigger-waiting'), 'second start before actual restore', { mode: 0o600 });
    const deadline = Date.now() + 15000;
    for (;;) {
      try { await readFile(join(state, 'fixture-trigger-release')); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() > deadline) throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const result = await start.call(this, options);
    const counts = JSON.parse(readFileSync(countsPath, 'utf8')); counts.settled = true;
    writeFileSync(countsPath, JSON.stringify(counts), { mode: 0o600 });
    return result;
  };
}
await runRunnerWorker(process.argv.at(-1)!);
