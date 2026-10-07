import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageErrorCode } from './contract.js';

/**
 * Where the storage lives in the state directory, and the checks every path passes before SQLite sees it: the real
 * state directory is the owner's and nobody else can write in it; each storage folder is a 0700 directory of the
 * owner's (never a symlink); the database and its sidecars are the owner's regular 0600 files, never symlinks or hard
 * links. A path that fails is refused as it is: it is not repaired, replaced or removed.
 *
 * The recovery and snapshot folders sit beside storage/, not in it, so replacing the database folder leaves them.
 */
export interface StorageLayout {
  stateDir: string;
  storageDir: string;
  database: string;
  wal: string;
  shm: string;
  /** A rollback journal: never made by a WAL database, so one that exists is refused rather than replayed. */
  journal: string;
  snapshotsDir: string;
  recoveryDir: string;
}

export class StoragePathError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, readonly retryable = false) { super(message); this.name = 'StoragePathError'; }
}

/** dev/ino name the file; size and mtime tell a rewrite. */
export interface FileGeneration { dev: number; ino: number; size: number; mtimeMs: number }
export const generationOf = (info: Stats): FileGeneration => ({ dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
export const sameFile = (a: FileGeneration, b: FileGeneration) => a.dev === b.dev && a.ino === b.ino;
export const sameGeneration = (a: FileGeneration, b: FileGeneration) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;

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
  const storageDir = join(real, 'storage');
  const database = join(storageDir, 'tower.db');
  return {
    stateDir: real, storageDir, database, wal: `${database}-wal`, shm: `${database}-shm`, journal: `${database}-journal`,
    snapshotsDir: join(real, 'storage-snapshots'), recoveryDir: join(real, 'storage-recovery'),
  };
}

/** An owner-only directory. With `create`, a missing one is made (its parent must exist); an existing one is never changed. */
export async function privateDirectory(path: string, create: boolean): Promise<boolean> {
  let info: Stats;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw pathError(error, path);
    if (!create) return false;
    try { await mkdir(path, { mode: 0o700 }); } catch (made) { throw pathError(made, path); }
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
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.sync(); } finally { await file.close(); }
  } catch (error) { throw pathError(error, path); }
  await syncDirectory(join(path, '..'));
  return (await privateFile(path))!;
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** The database files as they are: each one checked, absent ones undefined. */
export async function storageFiles(layout: StorageLayout): Promise<{ database?: FileGeneration; wal?: FileGeneration; shm?: FileGeneration }> {
  try {
    await lstat(layout.journal);
    throw new StoragePathError('unexpected-journal', `${layout.journal} exists; a WAL database never makes one, so it is left for the owner to inspect.`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw pathError(error, layout.journal); }
  return { database: await privateFile(layout.database), wal: await privateFile(layout.wal), shm: await privateFile(layout.shm) };
}
