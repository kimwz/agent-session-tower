import { constants } from 'node:fs';
import { open, lstat, readdir, rm, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { join, relative, resolve, sep } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../../stores/private-json.js';
import { privateDirectory, validateOperationId } from './store.js';
import type { RetentionCandidate, RetentionRecord } from './policy.js';
import type { RetentionManifest, RetentionSourceFile, RetentionJournalEntry } from './types.js';

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 100;
async function existingSafePath(path: string): Promise<void> {
  const absolute = resolve(path); let current = '/';
  for (const part of absolute.split('/').filter(Boolean)) {
    current = join(current, part); const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Retention refuses symlink paths.');
  }
}
function contains(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path)); return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep);
}
function validateManifest(value: unknown): RetentionManifest {
  const manifest = value as RetentionManifest;
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.sessions) || manifest.files.length > MAX_FILES) throw new Error('Invalid cold manifest.');
  validateOperationId(manifest.id);
  const names = new Set<string>();
  for (const file of manifest.files) {
    if (!/^file-[0-9]+\.gz$/.test(file.name) || names.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES || !['claude', 'codex'].includes(file.provider) || !contains(file.root, file.originalPath)) throw new Error('Invalid cold file manifest.');
    names.add(file.name);
  }
  return manifest;
}
async function verifiedHash(path: string, maxBytes: number, consume?: (chunk: Buffer) => void): Promise<{ sha256: string; bytes: number }> {
  await existingSafePath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = file.createReadStream({ autoClose: false });
  try {
    if (!(await file.stat()).isFile()) throw new Error('Invalid cold payload.');
    let bytes = 0; const hash = createHash('sha256');
    await pipeline(stream, createGunzip(), new Writable({ write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) { callback(new Error('Cold payload exceeds declared size.')); return; }
      hash.update(chunk); consume?.(chunk); callback();
    } }));
    return { sha256: hash.digest('hex'), bytes };
  } finally { stream.destroy(); await file.close(); }
}
function damagedBackup(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR' || error instanceof SyntaxError
    || (error instanceof Error && /^(Invalid cold |Cold bundle verification failed|Cold payload exceeds declared size)/.test(error.message));
}
async function readExternalJson(path: string): Promise<unknown> {
  await existingSafePath(path); const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat(); if (!info.isFile() || info.size > 4_000_000) throw new Error('Invalid cold import metadata.'); return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }

export class RetentionArchive {
  constructor(readonly root: string, readonly scanRoots: readonly string[]) {}
  async start(): Promise<void> {
    await privateDirectory(this.root);
    for (const scanRoot of this.scanRoots) if (resolve(scanRoot) === resolve(this.root) || contains(scanRoot, this.root)) throw new Error('Cold storage must be outside native scan roots.');
  }
  private directory(id: string): string { validateOperationId(id); return join(this.root, id); }
  async exists(id: string): Promise<boolean> {
    try { await existingSafePath(this.directory(id)); const info = await lstat(this.directory(id)); if (!info.isDirectory()) throw new Error('Invalid cold bundle directory.'); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async manifest(id: string): Promise<RetentionManifest> {
    await existingSafePath(this.directory(id));
    const manifest = validateManifest(await readPrivateJson(join(this.directory(id), 'manifest.json'), 4_000_000));
    if (manifest.id !== id) throw new Error('Cold bundle identity mismatch.');
    return manifest;
  }
  async verify(id: string): Promise<RetentionManifest> {
    const manifest = await this.manifest(id);
    for (const file of manifest.files) {
      const actual = await verifiedHash(join(this.directory(id), file.name), file.bytes);
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('Cold bundle verification failed.');
    }
    return manifest;
  }
  async create(id: string, candidate: RetentionCandidate, records: RetentionRecord[], files: RetentionSourceFile[]): Promise<RetentionManifest> {
    validateOperationId(id);
    try { return await this.verify(id); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!files.length || files.length > MAX_FILES) throw new Error('Cold bundle file budget exceeded.');
    let total = 0;
    for (const source of files) {
      if (!contains(source.root, source.path) || !this.scanRoots.some(root => resolve(root) === resolve(source.root))) throw new Error('Source outside approved native root.');
      await existingSafePath(source.path); const stat = await lstat(source.path);
      if (!stat.isFile()) throw new Error('Retention source is not a regular file.');
      total += stat.size;
      if (stat.size > MAX_FILE_BYTES || total > MAX_FILE_BYTES) throw new Error('oversize-budget');
    }
    const temporary = this.directory(`${id}-writing`);
    // Only this operation's abandoned scratch directory can be replaced, never a verified bundle.
    try { await existingSafePath(temporary); await rm(temporary, { recursive: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await privateDirectory(temporary);
    const manifest: RetentionManifest = {
      version: 1, id, createdAt: new Date().toISOString(), reason: candidate.reason,
      sessions: records.map(record => ({ id: record.session.id, nativeId: record.session.nativeId, provider: record.session.provider, parentId: record.session.parentId, title: record.session.customTitle || record.session.title, endedAt: record.latestTaskEndedAt })), files: [],
    };
    try {
      for (const [index, source] of files.entries()) {
        const input = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const output = await open(join(temporary, `file-${index}.gz`), 'wx', 0o600);
        const inputStream = input.createReadStream({ autoClose: false }); const outputStream = output.createWriteStream({ autoClose: false });
        try {
          const before = await input.stat(); let bytes = 0; const hash = createHash('sha256');
          if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error('Unsafe or oversized retention source.');
          await pipeline(inputStream, new Transform({ transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length; if (bytes > MAX_FILE_BYTES) { callback(new Error('oversize-budget')); return; } hash.update(chunk); callback(null, chunk);
          } }), createGzip(), outputStream);
          await output.sync(); const after = await input.stat(); const named = await lstat(source.path);
          if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== named.ino || before.dev !== named.dev || named.isSymbolicLink()) throw new Error('Retention source changed during backup.');
          manifest.files.push({ name: `file-${index}.gz`, originalPath: source.path, root: source.root, nativeId: source.nativeId, provider: source.provider, bytes, sha256: hash.digest('hex') });
        } finally { inputStream.destroy(); outputStream.destroy(); await input.close(); await output.close(); }
      }
      await writePrivateJson(join(temporary, 'manifest.json'), JSON.stringify(manifest), { syncDirectory: true });
      for (const file of manifest.files) {
        const actual = await verifiedHash(join(temporary, file.name), file.bytes);
        if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error('Backup integrity failure.');
      }
      await rename(temporary, this.directory(id)); await syncDirectory(this.root);
      return manifest;
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
  async read(id: string, name: string, limitBytes = 65_536): Promise<{ file: RetentionManifest['files'][number]; text: string; truncated: boolean }> {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > 1_048_576) throw new Error('Invalid cold read limit.');
    const manifest = await this.manifest(id); const file = manifest.files.find(file => file.name === name);
    if (!file) throw new Error('Unknown cold payload.');
    const chunks: Buffer[] = []; let captured = 0;
    const actual = await verifiedHash(join(this.directory(id), file.name), file.bytes, chunk => {
      const count = Math.min(chunk.length, limitBytes - captured); if (count > 0) { chunks.push(Buffer.from(chunk.subarray(0, count))); captured += count; }
    });
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error('Cold read verification failed.');
    return { file, text: Buffer.concat(chunks).toString('utf8'), truncated: file.bytes > limitBytes };
  }
  async diskBytes(): Promise<number> {
    const walk = async (path: string): Promise<number> => {
      await existingSafePath(path); let bytes = 0;
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Unsafe cold disk entry.');
        const item = join(path, entry.name);
        if (entry.isDirectory()) bytes += await walk(item); else if (entry.isFile()) bytes += (await lstat(item)).size;
      }
      return bytes;
    };
    return walk(this.root);
  }
  async list(): Promise<RetentionManifest[]> {
    const manifests: RetentionManifest[] = [];
    for (const item of await readdir(this.root, { withFileTypes: true })) {
      if (!item.isDirectory() || (item.name.endsWith('-writing') || item.name.endsWith('-importing') || /-quarantine-[a-f0-9]{8}$/.test(item.name))) continue;
      validateOperationId(item.name); manifests.push(await this.manifest(item.name));
    }
    return manifests;
  }
  /** A separate, versioned directory export: never implicitly included in ordinary Tower state export. */
  async export(id: string, target: string, journal: RetentionJournalEntry): Promise<void> {
    const manifest = await this.verify(id);
    try {
      await existingSafePath(target); const info = await lstat(target);
      if (!info.isDirectory() || (await readdir(target)).length) throw new Error('Cold export destination must be empty.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await privateDirectory(target);
    await this.copyBundle(this.directory(id), target, manifest);
    await writePrivateJson(join(target, 'export.json'), JSON.stringify({ version: 1, journal }), { syncDirectory: true });
  }
  async import(source: string): Promise<RetentionJournalEntry> {
    await existingSafePath(source);
    const manifest = validateManifest(await readExternalJson(join(source, 'manifest.json')));
    const metadata = await readExternalJson(join(source, 'export.json')) as { version: number; journal: RetentionJournalEntry };
    if (metadata.version !== 1 || metadata.journal?.id !== manifest.id || !Array.isArray(metadata.journal.candidate?.ids)) throw new Error('Invalid cold export metadata.');
    // Imported original paths are descriptive only; the provider must authorize explicit restoration.
    for (const file of manifest.files) {
      const actual = await verifiedHash(join(source, file.name), file.bytes);
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error('Cold import verification failed.');
    }
    let existing: RetentionManifest | undefined;
    if (await this.exists(manifest.id)) {
      try { existing = await this.manifest(manifest.id); }
      catch (error) { if (!damagedBackup(error)) throw error; /* Damaged private metadata is preserved in quarantine below. */ }
      if (existing && !isDeepStrictEqual(existing, manifest)) throw new Error('Cold import identity conflicts with another bundle.');
      try { await this.verify(manifest.id); return metadata.journal; }
      catch (error) { if (!damagedBackup(error)) throw error; /* A verified source can repair this exact private bundle; the old copy is preserved. */ }
    }
    const temporary = this.directory(`${manifest.id}-importing`);
    await this.prepareImportScratch(temporary, manifest);
    try {
      await this.copyBundle(source, temporary, manifest);
      if (await this.exists(manifest.id)) {
        const quarantine = join(this.root, `${manifest.id}-quarantine-${randomUUID().slice(0, 8)}`);
        await rename(this.directory(manifest.id), quarantine); await syncDirectory(this.root);
      }
      await rename(temporary, this.directory(manifest.id)); await syncDirectory(this.root);
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
    return metadata.journal;
  }
  private async prepareImportScratch(path: string, manifest: RetentionManifest): Promise<void> {
    try {
      await existingSafePath(path); const info = await lstat(path);
      if (!info.isDirectory() || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('Unsafe cold import scratch.');
      const expected = new Set(['manifest.json', 'import.json', ...manifest.files.map(file => file.name)]);
      for (const item of await readdir(path, { withFileTypes: true })) if (!expected.has(item.name) || !item.isFile()) throw new Error('Unrecognized cold import scratch.');
      try {
        const marker = await readExternalJson(join(path, 'import.json'));
        if (!isDeepStrictEqual(marker, manifest)) throw new Error('Cold import scratch belongs to another manifest.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { if (!isDeepStrictEqual(await readExternalJson(join(path, 'manifest.json')), manifest)) throw new Error('Cold import scratch belongs to another manifest.'); }
        catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError; }
      }
      // Reserved, private scratch contains only copies; the complete external source was verified first.
      await rm(path, { recursive: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await privateDirectory(path);
    await writePrivateJson(join(path, 'import.json'), JSON.stringify(manifest), { syncDirectory: true });
  }
  private async copyBundle(source: string, target: string, manifest: RetentionManifest): Promise<void> {
    for (const file of manifest.files) {
      await existingSafePath(join(source, file.name));
      const input = await open(join(source, file.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const output = await open(join(target, file.name), 'wx', 0o600);
      const inputStream = input.createReadStream({ autoClose: false }); const outputStream = output.createWriteStream({ autoClose: false });
      try { await pipeline(inputStream, outputStream); await output.sync(); }
      finally { inputStream.destroy(); outputStream.destroy(); await input.close(); await output.close(); }
      const actual = await verifiedHash(join(target, file.name), file.bytes);
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error('Cold copy verification failed.');
    }
    await writePrivateJson(join(target, 'manifest.json'), JSON.stringify(manifest), { syncDirectory: true });
  }
}
