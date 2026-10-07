import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { StorageErrorCode } from './contract.js';

/**
 * Where the storage lives in the state directory, and the checks every path passes before SQLite sees it: the real
 * state directory is the owner's and nobody else can write in it; each storage folder is a 0700 directory of the
 * owner's (never a symlink); the database and its sidecars are the owner's regular 0600 files, never symlinks or hard
 * links. A path that fails is refused as it is: it is not repaired, replaced or removed.
 *
 * The recovery and snapshot folders sit beside the database, so replacing the database leaves them.
 */
export interface StorageLayout {
  stateDir: string;
  /** `<state-dir>/state.sqlite`. */
  database: string;
  wal: string;
  shm: string;
  /** A rollback journal: never made by a WAL database, so one that exists is refused rather than replayed. */
  journal: string;
  snapshotsDir: string;
  recoveryDir: string;
}

export const STORAGE_DATABASE_NAME = 'state.sqlite';
/** The database and its sidecars, by the names a recovery barrier records them under. */
export const STORAGE_FILE_NAMES = [STORAGE_DATABASE_NAME, `${STORAGE_DATABASE_NAME}-wal`, `${STORAGE_DATABASE_NAME}-shm`] as const;
export type StorageFileName = typeof STORAGE_FILE_NAMES[number];

export class StoragePathError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, readonly retryable = false) { super(message); this.name = 'StoragePathError'; }
}

/** dev/ino name the file; size and mtime tell a rewrite. */
export interface FileGeneration { dev: number; ino: number; size: number; mtimeMs: number }
export const generationOf = (info: Stats): FileGeneration => ({ dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
export const sameFile = (a: FileGeneration, b: FileGeneration) => a.dev === b.dev && a.ino === b.ino;
export const sameGeneration = (a: FileGeneration, b: FileGeneration) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * The operations that create, move and sync storage files and folders. Every storage path goes through them so the
 * order of new links and syncs is one checked contract: tests replace members (node:test mock.method) to record that
 * order or to fail one step; nothing else does.
 */
export const storageFs = {
  mkdir: async (path: string): Promise<void> => { await mkdir(path, { mode: 0o700 }); },
  rename: (from: string, to: string): Promise<void> => rename(from, to),
  /** A new file (never an existing one or a symlink) with `data`, synced before it is closed. */
  createFile: async (path: string, data: string | Uint8Array): Promise<void> => {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await closing(file, async () => { if (data.length) await file.writeFile(data); await file.sync(); });
  },
  /** A new copy of `from` (a clone where the file system can), made 0600 and synced. */
  copyFile: async (from: string, to: string): Promise<void> => {
    await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const file = await open(to, constants.O_RDONLY | constants.O_NOFOLLOW);
    await closing(file, async () => { await file.chmod(0o600); await file.sync(); });
  },
  syncDirectory: async (path: string): Promise<void> => {
    const directory = await open(path, constants.O_RDONLY);
    await closing(directory, () => directory.sync());
  },
};

/** Runs `work`, then always closes `handle`; a failed close is the error only when `work` itself succeeded. */
async function closing(handle: { close(): Promise<void> }, work: () => Promise<void>): Promise<void> {
  try { await work(); } catch (error) {
    await handle.close().catch(() => undefined); // best-effort: the work's own error is the one to report
    throw error;
  }
  await handle.close();
}

/** POSIX owner and mode checks are what protect the files. Windows ACLs are not verified yet, so storage refuses there. */
export function storagePlatformSupported(): boolean {
  return process.platform !== 'win32' && typeof process.getuid === 'function';
}
const uid = () => process.getuid!();

export function pathError(error: unknown, path: string): StoragePathError {
  if (error instanceof StoragePathError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  const message = `${path}: ${error instanceof Error ? error.message : String(error)}`;
  switch (code) {
    case 'ENOSPC': case 'EDQUOT': return new StoragePathError('no-space', message, true);
    case 'EROFS': return new StoragePathError('read-only', message);
    case 'EACCES': case 'EPERM': return new StoragePathError('wrong-permissions', message);
    case 'ELOOP': return new StoragePathError('symlink', message);
    default: return new StoragePathError('io-error', message, true);
  }
}

/** The state directory's real path. Symlinks above it are the owner's setup; the directory itself must be the owner's alone. */
export async function storageLayout(stateDir: string): Promise<StorageLayout> {
  if (!storagePlatformSupported()) throw new StoragePathError('unsupported-platform', `Storage file permissions are not verified on ${process.platform}.`);
  let real: string;
  try { real = await realpath(stateDir); } catch (error) { throw new StoragePathError('state-dir-invalid', `The state directory ${stateDir} is not usable: ${(error as Error).message}`); }
  const info = await lstat(real);
  if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o022)) throw new StoragePathError('state-dir-invalid', `The state directory ${real} must be the owner's and writable by the owner only.`);
  const database = join(real, STORAGE_DATABASE_NAME);
  return {
    stateDir: real, database, wal: `${database}-wal`, shm: `${database}-shm`, journal: `${database}-journal`,
    snapshotsDir: join(real, 'storage-snapshots'), recoveryDir: join(real, 'storage-recovery'),
  };
}

/**
 * An owner-only directory. With `create`, a missing one is made (its parent must exist) and its parent synced, so the
 * new name survives a crash before anything is put in it. An existing one is never changed.
 */
export async function privateDirectory(path: string, create: boolean): Promise<boolean> {
  let info: Stats;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw pathError(error, path);
    if (!create) return false;
    try {
      await storageFs.mkdir(path);
      await storageFs.syncDirectory(dirname(path));
    } catch (made) { throw pathError(made, path); }
    info = await lstat(path);
  }
  if (info.isSymbolicLink()) throw new StoragePathError('symlink', `${path} is a symlink.`);
  if (!info.isDirectory()) throw new StoragePathError('not-regular', `${path} is not a directory.`);
  if (info.uid !== uid()) throw new StoragePathError('wrong-owner', `${path} belongs to another user.`);
  if (info.mode & 0o077) throw new StoragePathError('wrong-permissions', `${path} must be 0700, not ${(info.mode & 0o777).toString(8)}.`);
  return true;
}

/** An owner-only 0600 regular file, or undefined when absent. Nothing is followed or changed. */
export async function privateFile(path: string): Promise<FileGeneration | undefined> {
  let info: Stats;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw pathError(error, path);
  }
  if (info.isSymbolicLink()) throw new StoragePathError('symlink', `${path} is a symlink.`);
  if (!info.isFile()) throw new StoragePathError('not-regular', `${path} is not a regular file.`);
  if (info.uid !== uid()) throw new StoragePathError('wrong-owner', `${path} belongs to another user.`);
  if ((info.mode & 0o777) !== 0o600) throw new StoragePathError('wrong-permissions', `${path} must be 0600, not ${(info.mode & 0o777).toString(8)}.`);
  if (info.nlink !== 1) throw new StoragePathError('hard-linked', `${path} has other hard links.`);
  return generationOf(info);
}

/** Creates a new empty owner-only file; an existing file or symlink at `path` makes it fail. Synced with its folder. */
export async function createPrivateFile(path: string): Promise<FileGeneration> {
  try {
    await storageFs.createFile(path, '');
    await storageFs.syncDirectory(dirname(path));
  } catch (error) { throw pathError(error, path); }
  return (await privateFile(path))!;
}

/**
 * Replaces an owner-only document whole: a new synced 0600 temporary file renamed over `path`, then the folder synced.
 * Any failure is thrown as a StoragePathError; a failed folder sync means the new name may not survive a crash.
 */
export async function writePrivateDocument(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await storageFs.createFile(temporary, text);
    await storageFs.rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined); // best-effort: only this call's own temporary file; the write error is reported
    throw pathError(error, path);
  }
  try { await storageFs.syncDirectory(dirname(path)); } catch (error) { throw pathError(error, dirname(path)); }
}

export interface StorageFiles { database?: FileGeneration; wal?: FileGeneration; shm?: FileGeneration }
/** The database files as they are: each one checked, absent ones undefined. */
export async function storageFiles(layout: StorageLayout): Promise<StorageFiles> {
  try {
    await lstat(layout.journal);
    throw new StoragePathError('unexpected-journal', `${layout.journal} exists; a WAL database never makes one, so it is left for the owner to inspect.`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw pathError(error, layout.journal); }
  return { database: await privateFile(layout.database), wal: await privateFile(layout.wal), shm: await privateFile(layout.shm) };
}

/** Whether two looks at the database files saw the same files, unchanged. */
export function sameStorageFiles(a: StorageFiles, b: StorageFiles): boolean {
  const same = (x?: FileGeneration, y?: FileGeneration) => x === undefined ? y === undefined : y !== undefined && sameGeneration(x, y);
  return same(a.database, b.database) && same(a.wal, b.wal) && same(a.shm, b.shm);
}
