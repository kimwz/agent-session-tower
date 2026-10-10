import { cp, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { TriggerBackup } from '../triggers/backup.js';
import type { BackupPart, RestoreReport } from '../../shared/backup.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { listPendingSecretImports, stageVaultImport } from '../secrets/imports.js';
import { applyWorkerFiles, type WorkerSettingsOwner, type WorkerRestore } from './payload.js';

/** Where restores keep their state: the worker's part waiting for it, the last report, and copies of replaced files. */
export const restoreDir = (stateDir: string) => join(stateDir, 'restore');
const pendingPath = (stateDir: string) => join(restoreDir(stateDir), 'pending-worker.json');
/** A worker's part a worker has taken: renamed first, so a restore applied meanwhile is a separate file it never touches. */
const takenPath = (stateDir: string) => join(restoreDir(stateDir), 'applying-worker.json');
/**
 * A restore's report is written by the web only (`report-<id>.json`, and `latest.json` naming the newest restore); how
 * the worker's part went is written by the worker only (`outcome-<id>.json`). Neither ever rewrites the other's file.
 */
const latestPath = (stateDir: string) => join(restoreDir(stateDir), 'latest.json');
const reportPath = (stateDir: string, id: string) => join(restoreDir(stateDir), `report-${id}.json`);
const outcomePath = (stateDir: string, id: string) => join(restoreDir(stateDir), `outcome-${id}.json`);
const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
const REPORTS_KEPT = 5;
const BEFORE_KEPT = 3;

async function readOptional(path: string): Promise<unknown> {
  try { return await readPrivateJson(path, 60_000_000); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
interface Outcome { parts: BackupPart[]; errors: string[]; skills?: RestoreReport['skills']; at: string }

/** The newest restore as it stands: the web's report, with the worker's outcome once it has one. */
export async function readReport(stateDir: string): Promise<RestoreReport | undefined> {
  const latest = await readOptional(latestPath(stateDir)).catch(() => undefined) as { id?: unknown } | undefined;
  if (!validId(latest?.id)) return undefined;
  const report = await readOptional(reportPath(stateDir, latest.id)).catch(() => undefined) as RestoreReport | undefined;
  if (!report || typeof report !== 'object' || typeof report.status !== 'string') return undefined;
  const pendingIds = new Set(await listPendingSecretImports(stateDir));
  const outcome = await readOptional(outcomePath(stateDir, latest.id)).catch(() => undefined) as Outcome | undefined;
  if (report.status === 'cancelled') return report;
  const pending = report.pendingSecretImports?.filter(id => pendingIds.has(id));
  if (!outcome) return report.status === 'waiting-secrets' ? { ...report, status: pending?.length ? 'waiting-secrets' : 'applied', pendingSecretImports: pending, ...(pending?.length ? {} : { appliedAt: new Date().toISOString() }) } : report;
  return { ...report, status: pending?.length ? 'waiting-secrets' : 'applied', pendingSecretImports: pending, appliedAt: pending?.length ? undefined : outcome.at, worker: outcome.parts, errors: [...report.errors, ...outcome.errors], ...(outcome.skills ? { skills: outcome.skills } : {}) };
}

/** The web's report of a restore; it becomes the newest one. Reports of older restores beyond a few are removed. */
export async function writeReport(stateDir: string, report: RestoreReport): Promise<void> {
  const root = restoreDir(stateDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writePrivateJson(reportPath(stateDir, report.id), JSON.stringify(report));
  await writePrivateJson(latestPath(stateDir), JSON.stringify({ id: report.id }));
  const reports = (await readdir(root)).filter(name => /^report-[0-9a-f-]{36}\.json$/.test(name));
  if (reports.length <= REPORTS_KEPT) return;
  const dated = await Promise.all(reports.map(async name => ({ name, at: (await stat(join(root, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
  for (const { name } of dated.sort((a, b) => a.at - b.at).slice(0, dated.length - REPORTS_KEPT)) {
    const id = name.slice('report-'.length, -'.json'.length);
    if (id === report.id) continue;
    await rm(join(root, name), { force: true });
    await rm(outcomePath(stateDir, id), { force: true });
  }
}

export async function writePendingWorker(stateDir: string, restore: WorkerRestore): Promise<void> {
  await mkdir(restoreDir(stateDir), { recursive: true, mode: 0o700 });
  await writePrivateJson(pendingPath(stateDir), JSON.stringify(restore));
}
export async function readPendingWorker(stateDir: string): Promise<WorkerRestore | undefined> {
  return await readOptional(pendingPath(stateDir)) as WorkerRestore | undefined;
}
/** True when there was a waiting part to remove. */
export async function removePendingWorker(stateDir: string): Promise<boolean> {
  try { await unlink(pendingPath(stateDir)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/**
 * Copies every file a restore may replace into `restore/before-<stamp>/`, so the owner can put them back by hand.
 * Only the newest few copies are kept.
 */
export async function keepBefore(stateDir: string, files: string[], now = new Date(), triggers?: TriggerBackup): Promise<string> {
  const root = restoreDir(stateDir);
  const target = join(root, `before-${now.toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of files) {
    await cp(join(stateDir, name), join(target, name), { recursive: true, errorOnExist: false, force: true, verbatimSymlinks: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  if (triggers !== undefined) await writePrivateJson(join(target, 'trigger-backup.json'), JSON.stringify(triggers));
  const earlier = (await readdir(root)).filter(name => name.startsWith('before-')).sort();
  for (const name of earlier.slice(0, Math.max(0, earlier.length - BEFORE_KEPT))) await rm(join(root, name), { recursive: true, force: true });
  return target;
}

/**
 * The worker's part of a restore, taken when a worker starts: its files are written before any service reads them.
 * The trigger and skill parts are handed back for their services, and `finish` records the outcome and removes what
 * was taken. A worker that stops before `finish` leaves it for the next one, unless a newer restore arrived meanwhile;
 * every step can be done again.
 */
export async function takeWorkerRestore(stateDir: string, owner?: WorkerSettingsOwner): Promise<{ restore: WorkerRestore; applied(result: { parts: BackupPart[]; errors: string[] }): Promise<void>; finish(result: { parts: BackupPart[]; errors: string[]; skills?: RestoreReport['skills'] }): Promise<void> } | undefined> {
  const taken = takenPath(stateDir);
  try { await rename(pendingPath(stateDir), taken); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let restore: WorkerRestore | undefined;
  try { restore = await readOptional(taken) as WorkerRestore | undefined; }
  catch (error) {
    // Unreadable: set aside, so the worker never fails to start on it.
    console.error(`A waiting restore could not be read: ${error instanceof Error ? error.message : String(error)}`);
    await unlink(taken).catch(() => {});
    await finishReport(stateDir, undefined, { parts: [], errors: ['대기 중이던 복원 파일을 읽지 못했습니다.'] });
    return undefined;
  }
  if (!restore || typeof restore !== 'object' || !restore.files || typeof restore.files !== 'object') { if (restore !== undefined) await unlink(taken).catch(() => {}); return undefined; }
  const id = restore.id;
  if (restore.encryptedVault) { await stageVaultImport(stateDir, restore.encryptedVault, id); restore.encryptedVault = undefined; }
  const ours = async () => (await readOptional(taken).catch(() => undefined) as WorkerRestore | undefined)?.id === id;
  const earlier = restore.done ?? { parts: [], errors: [] };
  // Files and triggers are applied once: after a worker recorded them, a later one only does the skills left.
  const written = restore.done ? { parts: [], errors: [] } : await applyWorkerFiles(stateDir, restore.files, owner);
  let done = { parts: [...earlier.parts, ...written.parts], errors: [...earlier.errors, ...written.errors] };
  const taking: WorkerRestore = restore.done ? { ...restore, files: {}, triggers: undefined } : restore;
  return {
    restore: taking,
    applied: async result => {
      done = { parts: [...new Set([...done.parts, ...result.parts])], errors: [...done.errors, ...result.errors] };
      if (!await ours()) return;
      const { triggers: _triggers, ...rest } = restore;
      await writePrivateJson(taken, JSON.stringify({ ...rest, files: {}, done }));
    },
    finish: async result => {
      await finishReport(stateDir, id, { parts: [...new Set([...done.parts, ...result.parts])], errors: [...done.errors, ...result.errors], ...(result.skills ? { skills: result.skills } : {}) });
      // A newer restore a later worker took in the meantime is its own.
      if (await ours()) await unlink(taken).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    },
  };
}

/** Records how the worker's part of one restore went, in that restore's own outcome file. */
async function finishReport(stateDir: string, id: string | undefined, result: { parts: BackupPart[]; errors: string[]; skills?: RestoreReport['skills'] }): Promise<void> {
  if (!validId(id)) { if (result.errors.length) console.error(`Restore: ${result.errors.join(' ')}`); return; }
  await mkdir(restoreDir(stateDir), { recursive: true, mode: 0o700 });
  const outcome: Outcome = { parts: result.parts, errors: result.errors, ...(result.skills ? { skills: result.skills } : {}), at: new Date().toISOString() };
  await writePrivateJson(outcomePath(stateDir, id), JSON.stringify(outcome));
}
