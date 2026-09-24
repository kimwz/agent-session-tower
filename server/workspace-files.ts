import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Snapshot } from '../shared/types.js';

export const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 2000;
const writes = new Map<string, Promise<void>>();

function failure(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode });
}
function fsFailure(error: unknown): never {
  if (error && typeof error === 'object' && 'statusCode' in error) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') throw failure('File or directory no longer exists.', 404);
  if (code === 'EEXIST') throw failure('A file or directory already exists at this path.', 409);
  if (code === 'EACCES' || code === 'EPERM') throw failure('Cannot access this file or directory.', 403);
  if (code === 'EISDIR' || code === 'ENOTDIR') throw failure('Expected a regular file or directory at this path.');
  if (code === 'ELOOP') throw failure('Symbolic links are not supported.', 403);
  throw failure('Could not access the workspace file.', 500);
}

/** Returns the canonical directory so filesystem and terminal callers share one boundary. */
export async function assertWorkspace(cwd: unknown, snapshot: Snapshot): Promise<string> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096 || cwd.includes('\0')) {
    throw failure('An absolute workspace directory is required.');
  }
  if (!snapshot.sessions.some(session => session.cwd === cwd) && !snapshot.groups?.some(group => group.cwd === cwd)) {
    throw failure('Only workspace directories listed in Tower can be opened.', 403);
  }
  try {
    const root = await realpath(cwd);
    if (!(await stat(root)).isDirectory()) throw failure('Workspace is not a directory.', 400);
    return root;
  } catch (error) { return fsFailure(error); }
}

function subpath(value: unknown, allowRoot = false): string {
  if (allowRoot && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || isAbsolute(value)
    || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw failure('A relative workspace path without traversal is required.');
  }
  return value;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Disallow symlinks at every component, including parent directories on writes. */
async function checkedPath(root: string, path: string, missingLeaf = false): Promise<string> {
  let current = root;
  const parts = path ? path.split('/') : [];
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw failure('Symbolic links are not supported in the workspace editor.', 403);
      if (index < parts.length - 1 && !info.isDirectory()) throw failure('Parent path is not a directory.');
    } catch (error) {
      if (missingLeaf && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  const parent = path ? dirname(current) : current;
  if (!inside(root, await realpath(parent))) throw failure('Path leaves the workspace directory.', 403);
  if (!missingLeaf && !inside(root, await realpath(current))) throw failure('Path leaves the workspace directory.', 403);
  return current;
}

async function checkHandle(handle: FileHandle, root: string, path: string): Promise<void> {
  const target = await checkedPath(root, path);
  const [opened, current] = await Promise.all([handle.stat(), lstat(target)]);
  if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw failure('File changed while opening it. Reload and try again.', 409);
  }
}
function revision(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function decode(content: Buffer): string {
  if (content.length > MAX_WORKSPACE_FILE_BYTES) throw failure('Text files must be 2 MiB or smaller.', 413);
  if (content.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) throw failure('Binary files cannot be opened in the text editor.', 415);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); }
  catch { throw failure('Only UTF-8 text files can be opened in the editor.', 415); }
}
async function readText(handle: FileHandle): Promise<Buffer> {
  const info = await handle.stat();
  if (!info.isFile()) throw failure('Only regular text files can be opened.');
  if (info.size > MAX_WORKSPACE_FILE_BYTES) throw failure('Text files must be 2 MiB or smaller.', 413);
  // Bound allocation and reads even if another process grows the file after stat.
  const buffer = Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  const bytes = buffer.subarray(0, length);
  decode(bytes);
  return bytes;
}

/** `include` leaves entries out before they are counted, so entries nobody may see never fill the listing. */
export async function listWorkspaceTree(cwd: unknown, path: unknown, snapshot: Snapshot, include?: (path: string) => boolean | Promise<boolean>) {
  try {
    const root = await assertWorkspace(cwd, snapshot);
    const local = subpath(path, true);
    const target = await checkedPath(root, local);
    if (!(await stat(target)).isDirectory()) throw failure('Path is not a directory.');
    const entries: Array<{ name: string; path: string; type: 'file' | 'directory' }> = [];
    const directory = await opendir(target);
    let count = 0;
    let scanned = 0;
    for await (const entry of directory) {
      const entryPath = local ? `${local}/${entry.name}` : entry.name;
      if (++scanned > MAX_TREE_ENTRIES * 10 || (include && !await include(entryPath))) {
        if (scanned > MAX_TREE_ENTRIES * 10) throw failure('Directory contains too many entries to display (maximum 2000).', 413);
        continue;
      }
      if (++count > MAX_TREE_ENTRIES) throw failure('Directory contains too many entries to display (maximum 2000).', 413);
      if (entry.isFile() || entry.isDirectory()) {
        entries.push({ name: entry.name, path: entryPath, type: entry.isDirectory() ? 'directory' : 'file' });
      }
    }
    await checkedPath(root, local);
    entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
    return { entries };
  } catch (error) { return fsFailure(error); }
}

export async function readWorkspaceFile(cwd: unknown, path: unknown, snapshot: Snapshot) {
  let handle: FileHandle | undefined;
  try {
    const root = await assertWorkspace(cwd, snapshot);
    const local = subpath(path);
    const target = await checkedPath(root, local);
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    await checkHandle(handle, root, local);
    const bytes = await readText(handle);
    await checkHandle(handle, root, local);
    return { path: local, content: decode(bytes), revision: revision(bytes) };
  } catch (error) { return fsFailure(error); }
  finally { await handle?.close(); }
}

async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = writes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  writes.set(key, current);
  await previous;
  try { return await action(); }
  finally { release(); if (writes.get(key) === current) writes.delete(key); }
}

export async function saveWorkspaceFile(body: Record<string, unknown>, snapshot: Snapshot) {
  try {
    if (Object.keys(body).some(key => !['cwd', 'path', 'content', 'revision'].includes(key))) throw failure('Unexpected file request fields.');
    const root = await assertWorkspace(body.cwd, snapshot);
    const local = subpath(body.path);
    if (typeof body.content !== 'string') throw failure('Text content is required.');
    if (body.revision !== null && (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision))) throw failure('A file revision is required.');
    const bytes = Buffer.from(body.content, 'utf8');
    if (decode(bytes) !== body.content) throw failure('Content must be valid UTF-8 text.', 415);
    return await serialized(resolve(root, local), async () => {
      let handle: FileHandle | undefined;
      let temporaryHandle: FileHandle | undefined;
      let temporary: string | undefined;
      try {
        const creating = body.revision === null;
        const target = await checkedPath(root, local, creating);
        let mode = 0o666 & ~process.umask();
        // A save sent again after its answer was lost finds its own content already there: that is success.
        const unchanged = { path: local, content: body.content as string, revision: revision(bytes) };
        if (creating) {
          const present = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
          if (present) {
            // Only the very content this save would write counts as done; a folder, another file, or one that
            // cannot be read as text means the name is taken.
            const same = await checkHandle(present, root, local).then(() => readText(present)).then(existing => existing.equals(bytes), () => false).finally(() => present.close());
            if (same) return unchanged;
            throw failure('A file or directory already exists at this path.', 409);
          }
        } else {
          handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          await checkHandle(handle, root, local);
          const existing = await readText(handle);
          if (revision(existing) !== body.revision) {
            if (existing.equals(bytes)) return unchanged;
            throw failure('File changed on disk. Reload before saving to avoid overwriting changes.', 409);
          }
          mode = (await handle.stat()).mode & 0o7777;
        }
        const temporaryLocal = [local.split('/').slice(0, -1).join('/'), `.tower-save-${randomUUID()}`].filter(Boolean).join('/');
        const temporaryPath = await checkedPath(root, temporaryLocal, true);
        temporaryHandle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporary = temporaryPath;
        await checkHandle(temporaryHandle, root, temporaryLocal);
        // Stage the complete replacement beside the target. Failed writes or syncs
        // never touch the original, and rename publishes all bytes atomically.
        await temporaryHandle.writeFile(bytes);
        await temporaryHandle.chmod(mode);
        await temporaryHandle.sync();
        await checkHandle(temporaryHandle, root, temporaryLocal);
        await checkedPath(root, local, creating);
        if (handle) {
          await checkHandle(handle, root, local);
          if (revision(await readText(handle)) !== body.revision) throw failure('File changed on disk. Reload before saving to avoid overwriting changes.', 409);
          await checkHandle(handle, root, local);
          await rename(temporary, target);
          temporary = undefined;
        } else {
          // link is an atomic exclusive publish: never replace a file that
          // appeared while its new contents were being written.
          await link(temporary, target);
        }
        return { path: local, content: body.content as string, revision: revision(bytes) };
      } finally {
        try { await Promise.all([temporaryHandle?.close(), handle?.close()]); }
        finally { if (temporary) await unlink(temporary).catch(() => {}); }
      }
    });
  } catch (error) { return fsFailure(error); }
}

export async function createWorkspaceDirectory(body: Record<string, unknown>, snapshot: Snapshot) {
  try {
    if (Object.keys(body).some(key => key !== 'cwd' && key !== 'path')) throw failure('Unexpected directory request fields.');
    const root = await assertWorkspace(body.cwd, snapshot);
    const local = subpath(body.path);
    const target = await checkedPath(root, local, true);
    await mkdir(target);
    await checkedPath(root, local);
    return { path: local };
  } catch (error) { return fsFailure(error); }
}
