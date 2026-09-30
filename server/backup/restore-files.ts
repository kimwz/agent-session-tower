import { cp, mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupPart, RestoreReport } from '../../shared/backup.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { applyWorkerFiles, type WorkerRestore } from './payload.js';

/** Where restores keep their state: the worker's part waiting for it, the last report, and copies of replaced files. */
export const restoreDir = (stateDir: string) => join(stateDir, 'restore');
const pendingPath = (stateDir: string) => join(restoreDir(stateDir), 'pending-worker.json');
/** A worker's part a worker has taken: renamed first, so a restore applied meanwhile is a separate file it never touches. */
const takenPath = (stateDir: string) => join(restoreDir(stateDir), 'applying-worker.json');
const reportPath = (stateDir: string) => join(restoreDir(stateDir), 'last.json');
const BEFORE_KEPT = 3;

async function readOptional(path: string): Promise<unknown> {
  try { return await readPrivateJson(path, 60_000_000); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function readReport(stateDir: string): Promise<RestoreReport | undefined> {
  const value = await readOptional(reportPath(stateDir)).catch(() => undefined) as RestoreReport | undefined;
  return value && typeof value === 'object' && typeof value.status === 'string' ? value : undefined;
}
export async function writeReport(stateDir: string, report: RestoreReport): Promise<void> {
  await mkdir(restoreDir(stateDir), { recursive: true, mode: 0o700 });
  await writePrivateJson(reportPath(stateDir), JSON.stringify(report));
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
export async function keepBefore(stateDir: string, files: string[], now = new Date()): Promise<string> {
  const root = restoreDir(stateDir);
  const target = join(root, `before-${now.toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of files) {
    await cp(join(stateDir, name), join(target, name), { recursive: true, errorOnExist: false, force: true, verbatimSymlinks: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
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
export async function takeWorkerRestore(stateDir: string): Promise<{ restore: WorkerRestore; finish(result: { parts: BackupPart[]; errors: string[]; skills?: RestoreReport['skills'] }): Promise<void> } | undefined> {
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
  const written = await applyWorkerFiles(stateDir, restore.files);
  return {
    restore,
    finish: async result => {
      await finishReport(stateDir, id, { parts: [...new Set([...written.parts, ...result.parts])], errors: [...written.errors, ...result.errors], ...(result.skills ? { skills: result.skills } : {}) });
      await unlink(taken).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    },
  };
}

/** Records how the worker's part went, on the report of that restore only: a newer restore keeps its own. */
async function finishReport(stateDir: string, id: string | undefined, result: { parts: BackupPart[]; errors: string[]; skills?: RestoreReport['skills'] }): Promise<void> {
  const report = await readReport(stateDir);
  if (report && id !== undefined && report.id !== id) return;
  const now = new Date().toISOString();
  await writeReport(stateDir, { ...(report ?? { id: id ?? '', requestedAt: now, from: '', createdAt: '', applied: [], worker: [] }), status: 'applied', appliedAt: now,
    worker: result.parts, errors: [...(report?.errors ?? []), ...result.errors], ...(result.skills ? { skills: result.skills } : {}) });
}
