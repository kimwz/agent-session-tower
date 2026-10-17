import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, statfs, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { UPLOAD_CHUNK_BYTES, normalizeAttachmentMimeType } from '../../shared/attachments.js';
import { TowerError } from '../../shared/errors.js';
import { TODO_FILE_MAX_BYTES, type TodoChanges, type TodoFile } from '../../shared/todo/types.js';
import { rasterMime } from '../stores/attachments.js';
import type { TodoStore } from './store.js';

/**
 * Attachment contents and their uploads. Contents are stored once per content, as `<state>/todo-files/<sha256>`
 * (owner-only, never through a symlink); the rows that name them are the store's. An upload arrives in pieces into
 * `<state>/todo-uploads/<id>/` and can be resumed; completing it moves the contents into place and adds the row, and
 * can be repeated after a failure at any point (the row's id is fixed when the upload begins).
 */

const SHA256 = /^[0-9a-f]{64}$/;

/** Where contents named by `sha256` are; only an exact content hash names a path, so no row reaches outside the folder. */
export function todoFilePath(stateDir: string, sha256: string): string {
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw new TowerError('invalid', '첨부 파일 해시가 올바르지 않습니다.');
  return join(stateDir, 'todo-files', sha256);
}
const UPLOAD_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
/** An upload left this long is removed, and so are contents being brought back that long ago. */
export const TODO_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const INCOMING = '.incoming-';

export interface TodoUploadStart { taskId: string; commentId?: string | null; name: string; mimeType: string; size: number }
export interface TodoAttached { file: TodoFile; changes: TodoChanges }
/** An attachment opened to send. `image` is its image type when asked for one and its bytes are one. */
export interface OpenTodoFile { file: TodoFile; handle: FileHandle; image?: string }

interface Manifest {
  id: string; fileId: string; taskId: string; commentId: string | null; name: string; mimeType: string; size: number; touched: number;
  /** Set once every piece arrived and was hashed; no piece is taken after. */
  sha256?: string;
  /** The answer of the completion, given again to a repeated one. */
  receipt?: TodoAttached;
}

const missing = () => new TowerError('not-found', '업로드를 찾을 수 없습니다. 파일을 다시 첨부하세요.');
const invalid = (message: string) => new TowerError('invalid', message);
const absent = (error: unknown) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; };

/** A name shown and offered for download: no control characters or path separators, at most 255 characters. */
function fileName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || value === '.' || value === '..' || /[\x00-\x1f\x7f/\\]/.test(value)) throw invalid('첨부 파일 이름이 올바르지 않습니다.');
  try { encodeURIComponent(value); } catch { throw invalid('첨부 파일 이름이 올바르지 않습니다.'); }
  return value;
}

function mimeType(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 127) throw invalid('첨부 파일 형식이 올바르지 않습니다.');
  const mime = normalizeAttachmentMimeType(value, name);
  if (!MIME.test(mime)) throw invalid('첨부 파일 형식이 올바르지 않습니다.');
  return mime;
}

/** Throws unless a file row (from a backup) is one an upload could have made. */
export function checkTodoFileRow(row: Record<string, unknown>): void {
  const wrong = () => new TowerError('invalid', '할 일 백업의 첨부 파일 기록이 올바르지 않습니다.');
  if (typeof row.id !== 'string' || !ID.test(row.id) || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)
    || !Number.isSafeInteger(row.size) || (row.size as number) < 0 || (row.size as number) > TODO_FILE_MAX_BYTES) throw wrong();
  try { if (mimeType(row.mime, fileName(row.name)) !== row.mime) throw wrong(); } catch { throw wrong(); }
}

export class TodoFiles {
  readonly contents: string;
  readonly uploads: string;
  private ready = false;
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Moving contents into place, adding rows that name them, and removing contents no row names take turns. */
  private contentTurn: Promise<unknown> = Promise.resolve();

  constructor(private readonly stateDir: string, private readonly store: TodoStore, private readonly options: { now?: () => number } = {}) {
    this.contents = join(stateDir, 'todo-files');
    this.uploads = join(stateDir, 'todo-uploads');
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** Makes both folders owner-only. Attachments stay unavailable when either is not a plain folder. */
  async start(): Promise<void> {
    for (const directory of [this.contents, this.uploads]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await this.checkDirectory(directory);
      const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.chmod(0o700); } finally { await handle.close(); }
    }
    this.ready = true;
  }

  private usable(): void {
    if (!this.ready) throw new TowerError('unavailable', '첨부 파일 저장소를 사용할 수 없습니다.');
  }

  // ---- Uploads -------------------------------------------------------------------------------------

  async startUpload(input: TodoUploadStart): Promise<{ id: string; offset: number }> {
    this.usable();
    const commentId = input.commentId ?? null;
    if (typeof input.taskId !== 'string' || !ID.test(input.taskId) || (commentId !== null && (typeof commentId !== 'string' || !ID.test(commentId)))) throw invalid('첨부할 작업이 올바르지 않습니다.');
    const name = fileName(input.name);
    const mime = mimeType(input.mimeType, name);
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw invalid('파일 크기가 올바르지 않습니다.');
    if (input.size > TODO_FILE_MAX_BYTES) throw new TowerError('too-large', '파일 하나는 100MB 이하여야 합니다.');
    this.store.attachable(input.taskId, commentId);
    await this.checkDirectory(this.uploads);
    const space = await statfs(this.uploads, { bigint: true });
    if (BigInt(input.size) > space.bavail * space.bsize) throw new TowerError('storage-full', '파일을 저장할 디스크 여유 공간이 부족합니다.');
    const id = randomUUID();
    const manifest: Manifest = { id, fileId: randomUUID(), taskId: input.taskId, commentId, name, mimeType: mime, size: input.size, touched: this.now() };
    return this.lock(id, async () => {
      const directory = join(this.uploads, id);
      try {
        await mkdir(directory, { mode: 0o700 });
        await (await open(join(directory, 'content'), 'wx', 0o600)).close();
        await this.save(manifest);
        return { id, offset: 0 };
      } catch (error) { await rm(directory, { recursive: true, force: true }); throw storageError(error); }
    });
  }

  /** How much of an upload has arrived, to resume it. */
  uploadOffset(id: string): Promise<number> {
    return this.lock(id, async () => this.offset(await this.load(id)));
  }

  /** Writes one piece at `offset`, which must be where the upload stands; a piece that fails is taken back whole. */
  appendUpload(id: string, offset: number, chunks: AsyncIterable<Buffer>): Promise<{ offset: number }> {
    return this.lock(id, async () => {
      const manifest = await this.load(id);
      if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('업로드 위치가 올바르지 않습니다.');
      const expected = await this.offset(manifest);
      if (expected !== offset || manifest.sha256) throw Object.assign(new TowerError('conflict', `업로드 위치가 일치하지 않습니다. 현재 위치: ${expected}`), { offset: expected });
      const file = await this.content(manifest);
      let written = 0;
      try {
        for await (const chunk of chunks) {
          if (!Buffer.isBuffer(chunk)) throw invalid('업로드 데이터가 올바르지 않습니다.');
          if (written + chunk.length > UPLOAD_CHUNK_BYTES) throw new TowerError('too-large', '업로드 조각은 4 MiB 이하여야 합니다.');
          if (offset + written + chunk.length > manifest.size) throw invalid('선언한 파일 크기를 초과했습니다.');
          let done = 0;
          while (done < chunk.length) {
            const result = await file.write(chunk, done, chunk.length - done, offset + written + done);
            if (!result.bytesWritten) throw new Error('Unable to write an attachment piece');
            done += result.bytesWritten;
          }
          written += chunk.length;
        }
        await file.sync();
        manifest.touched = this.now();
        await this.save(manifest);
        return { offset: offset + written };
      } catch (error) {
        await file.truncate(offset); await file.sync();
        throw storageError(error);
      } finally { await file.close(); }
    });
  }

  /**
   * Hashes the arrived file, moves it into place (or keeps the copy already there), and adds its row after checking
   * again that its task and comment are there. Stopped anywhere, completing again finishes it with the same row.
   */
  completeUpload(id: string): Promise<TodoAttached> {
    return this.lock(id, async () => {
      const manifest = await this.load(id);
      if (manifest.receipt) return manifest.receipt;
      const staged = join(this.uploads, id, 'content');
      if (!manifest.sha256) {
        const file = await this.content(manifest);
        try {
          const size = (await file.stat()).size;
          if (size !== manifest.size) throw Object.assign(new TowerError('conflict', `파일 업로드가 완료되지 않았습니다. 현재 위치: ${size}`), { offset: size });
          const hash = createHash('sha256');
          for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk as Buffer);
          manifest.sha256 = hash.digest('hex');
        } finally { await file.close(); }
        manifest.touched = this.now();
        await this.save(manifest);
      }
      const sha256 = manifest.sha256;
      const receipt = await this.contentTurnOf(async () => {
        await this.place(staged, sha256, manifest.size);
        return this.store.attach({ id: manifest.fileId, taskId: manifest.taskId, commentId: manifest.commentId, name: manifest.name, mimeType: manifest.mimeType, size: manifest.size, sha256 });
      });
      manifest.receipt = receipt; manifest.touched = this.now();
      await this.save(manifest);
      return receipt;
    }).catch(error => { throw storageError(error); });
  }

  cancelUpload(id: string): Promise<void> {
    return this.lock(id, async () => {
      await this.load(id);
      await rm(join(this.uploads, id), { recursive: true, force: true });
    });
  }

  /** Puts arrived contents in place as `sha256`, unless a whole copy is there already. */
  private async place(staged: string, sha256: string, size: number): Promise<void> {
    const target = todoFilePath(this.stateDir, sha256);
    await this.checkDirectory(this.contents);
    const [content, existing] = await Promise.all([lstat(staged).catch(absent), lstat(target).catch(absent)]);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new TowerError('unavailable', '첨부 파일 저장소가 올바르지 않습니다.');
    if (content) {
      if (!content.isFile() || content.isSymbolicLink()) throw missing();
      // A copy of another size under the same name is damaged; the new one replaces it.
      if (existing?.size === size) await rm(staged, { force: true });
      else await rename(staged, target);
    } else if (existing?.size !== size) throw missing();
  }

  // ---- Serving ---------------------------------------------------------------------------------------

  /** Opens an attachment that shows. With `image`, its bytes are checked for a PNG, JPEG, GIF or WebP signature. */
  async openFile(id: string, image = false): Promise<OpenTodoFile> {
    this.usable();
    const notFound = () => new TowerError('not-found', '첨부 파일을 찾을 수 없습니다.');
    const file = ID.test(id) ? this.store.visibleFile(id) : undefined;
    if (!file) throw notFound();
    const handle = await this.openContent(file.sha256, file.size);
    try {
      if (!image) return { file, handle };
      const head = Buffer.alloc(32);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const type = rasterMime(head.subarray(0, bytesRead));
      return { file, handle, ...(type ? { image: type } : {}) };
    } catch (error) { await handle.close(); throw error; }
  }

  /**
   * Opens stored contents to read: a plain file of the expected size with no other link to it (one elsewhere could
   * change it behind the store's back).
   */
  async openContent(sha256: string, size: number): Promise<FileHandle> {
    const gone = () => new TowerError('not-found', '이 첨부 파일의 내용이 이 컴퓨터에 없습니다(백업에서 찾지 못함).');
    const handle = await open(todoFilePath(this.stateDir, sha256), constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
      if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw gone();
      throw error;
    });
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== size) throw gone();
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  // ---- Contents brought back by a restore --------------------------------------------------------------

  hasContent(sha256: string, size: number): Promise<boolean> {
    return lstat(todoFilePath(this.stateDir, sha256)).then(info => info.isFile() && !info.isSymbolicLink() && info.size === size, error => absent(error) ?? false);
  }

  /** Writes contents from elsewhere, keeping them only when they are exactly `sha256`. */
  async importContent(sha256: string, size: number, chunks: AsyncIterable<Buffer>): Promise<void> {
    this.usable();
    if (!SHA256.test(sha256)) throw invalid('첨부 파일 해시가 올바르지 않습니다.');
    await this.checkDirectory(this.contents);
    const temporary = join(this.contents, `${INCOMING}${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      const hash = createHash('sha256');
      let written = 0;
      try {
        for await (const chunk of chunks) {
          hash.update(chunk);
          let done = 0;
          while (done < chunk.length) done += (await file.write(chunk, done, chunk.length - done, written + done)).bytesWritten;
          written += chunk.length;
          if (written > size) throw invalid('첨부 파일 크기가 맞지 않습니다.');
        }
        await file.sync();
      } finally { await file.close(); }
      if (written !== size || hash.digest('hex') !== sha256) throw invalid('첨부 파일 내용이 기록과 맞지 않습니다.');
      await this.contentTurnOf(() => rename(temporary, todoFilePath(this.stateDir, sha256)));
    } catch (error) { await rm(temporary, { force: true }); throw storageError(error); }
  }

  /** Runs `work` while no contents are moved into place or removed (a restore replacing the rows that name them). */
  contentTurnOf<T>(work: () => T | Promise<T>): Promise<T> {
    // best-effort: the turn before already gave its failure to its own caller.
    const result = this.contentTurn.catch(() => undefined).then(work);
    this.contentTurn = result;
    return result;
  }

  // ---- Cleaning up -------------------------------------------------------------------------------------

  /**
   * Removes uploads left for a day, then contents no row names and no unfinished upload is about to name. Skipped
   * while the store says contents must stay (see TodoStore.fileContents).
   */
  async purge(): Promise<void> {
    if (!this.ready) return;
    const now = this.now();
    await this.checkDirectory(this.uploads);
    for (const id of await readdir(this.uploads)) {
      if (!UPLOAD_ID.test(id) || this.locks.has(id)) continue;
      await this.lock(id, async () => {
        const directory = join(this.uploads, id);
        const info = await lstat(directory).catch(absent);
        if (!info?.isDirectory() || info.isSymbolicLink()) return;
        // best-effort: an unreadable record is judged by when its files were last written.
        const manifest = await this.loadManifest(id).catch(() => undefined);
        const content = await lstat(join(directory, 'content')).catch(absent);
        if (Math.max(info.mtimeMs, content?.mtimeMs ?? 0, manifest?.touched ?? 0) <= now - TODO_UPLOAD_TTL_MS) await rm(directory, { recursive: true, force: true });
      });
    }
    await this.contentTurnOf(async () => {
      const named = this.store.fileContents();
      if (!named) return;
      // Read in this turn: contents move into place only in a turn, after their upload's record names them, so an
      // upload that moved its contents and has yet to add its row is seen here, however it ran while the cleanup began.
      const pending = new Set<string>();
      for (const id of await readdir(this.uploads)) {
        // best-effort: a record not readable now names no contents.
        const manifest = UPLOAD_ID.test(id) ? await this.loadManifest(id).catch(() => undefined) : undefined;
        if (manifest?.sha256) pending.add(manifest.sha256);
      }
      await this.checkDirectory(this.contents);
      for (const name of await readdir(this.contents)) {
        const path = join(this.contents, name);
        if (SHA256.test(name) && !named.has(name) && !pending.has(name)) await rm(path, { force: true });
        else if (name.startsWith(INCOMING)) {
          const info = await lstat(path).catch(absent);
          if (info && info.mtimeMs <= now - TODO_UPLOAD_TTL_MS) await rm(path, { force: true });
        }
      }
    });
  }

  // ---- Upload records ----------------------------------------------------------------------------------

  private async offset(manifest: Manifest): Promise<number> {
    if (manifest.sha256) return manifest.size;
    const file = await this.content(manifest);
    try {
      const size = (await file.stat()).size;
      if (!Number.isSafeInteger(size) || size > manifest.size) throw missing();
      return size;
    } finally { await file.close(); }
  }

  private async load(id: string): Promise<Manifest> {
    this.usable();
    const manifest = await this.loadManifest(id);
    if (manifest.touched <= this.now() - TODO_UPLOAD_TTL_MS && !manifest.receipt) throw missing();
    return manifest;
  }

  private async loadManifest(id: string): Promise<Manifest> {
    if (!UPLOAD_ID.test(id)) throw missing();
    try {
      await this.checkDirectory(this.uploads); await this.checkDirectory(join(this.uploads, id));
      const file = await open(join(this.uploads, id, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: Manifest;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 64 * 1024) throw missing();
        value = JSON.parse((await file.readFile()).toString('utf8')) as Manifest;
      } finally { await file.close(); }
      if (!value || value.id !== id || !UPLOAD_ID.test(value.fileId) || !ID.test(value.taskId) || (value.commentId !== null && !ID.test(value.commentId))
        || fileName(value.name) !== value.name || mimeType(value.mimeType, value.name) !== value.mimeType || !Number.isSafeInteger(value.size) || value.size < 0
        || value.size > TODO_FILE_MAX_BYTES || !Number.isSafeInteger(value.touched) || (value.sha256 !== undefined && !SHA256.test(value.sha256))) throw missing();
      return value;
    } catch (error) {
      if (error instanceof TowerError || error instanceof SyntaxError || ['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw missing();
      throw error;
    }
  }

  private async content(manifest: Manifest): Promise<FileHandle> {
    await this.checkDirectory(join(this.uploads, manifest.id));
    const file = await open(join(this.uploads, manifest.id, 'content'), constants.O_RDWR | constants.O_NOFOLLOW).catch(error => { throw absent(error) ?? missing(); });
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw missing();
      return file;
    } catch (error) { await file.close(); throw error; }
  }

  private async save(manifest: Manifest): Promise<void> {
    const directory = join(this.uploads, manifest.id);
    const temporary = join(directory, `.manifest-${randomUUID()}.json`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(manifest)); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, join(directory, 'manifest.json')); }
    finally { await rm(temporary, { force: true }); }
  }

  private async checkDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TowerError('unavailable', '첨부 파일 저장 폴더가 올바르지 않습니다.');
  }

  /** One operation at a time per upload. */
  private async lock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (typeof id !== 'string' || !UPLOAD_ID.test(id)) throw missing();
    const previous = this.locks.get(id) ?? Promise.resolve();
    // best-effort: the previous operation's failure already reached its caller; it must not stop this one.
    const result = previous.catch(() => undefined).then(operation);
    this.locks.set(id, result);
    try { return await result; }
    finally { if (this.locks.get(id) === result) this.locks.delete(id); }
  }
}

function storageError(error: unknown): unknown {
  return ['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '') ? new TowerError('storage-full', '파일을 저장할 디스크 여유 공간이 부족합니다.', { cause: error }) : error;
}
