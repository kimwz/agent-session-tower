import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, statfs, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Attachment } from '../../shared/types.js';
import { UPLOAD_CHUNK_BYTES, type AttachmentUploadTarget, type AttachmentUploadStarted, type AttachmentUploadStatus } from '../../shared/attachments.js';
import { TowerError } from '../../shared/errors.js';
import { ATTACHMENT_ID, ATTACHMENT_TTL_MS, AttachmentStore, attachmentMetadata, isIncompleteAttachmentMetadata, validatedAttachmentMime } from './attachments.js';

interface UploadManifest {
  id: string; attachmentId: string; target: AttachmentUploadTarget; owner: string;
  name: string; mimeType: string; size: number; touched: number; receipt?: Attachment;
}
export interface AttachmentUploadsOptions {
  chat: AttachmentStore; auto: AttachmentStore;
  publishedGC?: boolean;
  protectedChat?: () => ReadonlySet<string>; protectedAuto?: () => ReadonlySet<string>;
}
const missing = () => new TowerError('not-found', '업로드를 찾을 수 없습니다. 파일을 다시 첨부하세요.');
const invalid = (message: string) => new TowerError('invalid', message);

/** Resumable originals stay in this domain; transports carry only an owner and target. */
export class AttachmentUploads {
  readonly directory: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(stateDir: string, private readonly options: AttachmentUploadsOptions) { this.directory = join(stateDir, 'attachment-uploads'); }

  async start(): Promise<void>;
  async start(target: AttachmentUploadTarget, name: string, mimeType: string, size: number, owner: string): Promise<AttachmentUploadStarted>;
  async start(target?: AttachmentUploadTarget, name?: string, mimeType?: string, size?: number, owner?: string): Promise<void | AttachmentUploadStarted> {
    if (target === undefined) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.checkDirectory(this.directory);
      const root = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await root.chmod(0o700); } finally { await root.close(); }
      await this.sweep().catch(error => console.error('Attachment upload startup cleanup failed:', error));
      if (!this.timer) { this.timer = setInterval(() => { void this.sweep().catch(error => console.error('Attachment upload cleanup failed:', error)); }, 60_000); this.timer.unref(); }
      return;
    }
    if ((target.kind !== 'chat' && target.kind !== 'auto') || typeof target.sessionId !== 'string' || !target.sessionId
      || typeof owner !== 'string' || !owner || !Number.isSafeInteger(size) || size! < 0) throw invalid('업로드 대상 또는 크기가 올바르지 않습니다.');
    const normalized = validatedAttachmentMime(name!, mimeType!);
    await this.checkDirectory(this.directory);
    const space = await statfs(this.directory, { bigint: true });
    // Completion publishes a verified copy while the resumable original is still present.
    if (BigInt(size!) * 2n > space.bavail * space.bsize) throw new TowerError('storage-full', '파일을 저장할 디스크 여유 공간이 부족합니다.');
    const id = randomUUID();
    const manifest: UploadManifest = { id, attachmentId: randomUUID(), target: { ...target }, owner, name: name!, mimeType: normalized, size: size!, touched: Date.now() };
    const directory = join(this.directory, id);
    return this.lock(id, async () => {
      try {
        await mkdir(directory, { mode: 0o700 });
        const file = await open(join(directory, 'content'), 'wx', 0o600);
        await file.close();
        await this.save(manifest);
        return { id, offset: 0 };
      } catch (error) { await rm(directory, { recursive: true, force: true }); throw this.storageError(error); }
    });
  }

  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async status(id: string, owner: string): Promise<AttachmentUploadStatus> {
    return this.lock(id, async () => {
      const manifest = await this.load(id, owner);
      const offset = await this.offset(manifest);
      return { offset, target: { ...manifest.target } };
    });
  }

  async append(id: string, owner: string, offset: number, chunks: AsyncIterable<Buffer>): Promise<{ offset: number }> {
    return this.lock(id, async () => {
      const manifest = await this.load(id, owner);
      const expected = await this.offset(manifest);
      if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('업로드 위치가 올바르지 않습니다.');
      if (expected !== offset || manifest.receipt) throw Object.assign(new TowerError('conflict', `업로드 위치가 일치하지 않습니다. 현재 위치: ${expected}`), { offset: expected });
      const file = await this.content(manifest);
      let written = 0;
      try {
        for await (const chunk of chunks) {
          if (!Buffer.isBuffer(chunk)) throw invalid('업로드 데이터가 올바르지 않습니다.');
          if (written + chunk.length > UPLOAD_CHUNK_BYTES) throw new TowerError('too-large', '업로드 조각은 4 MiB 이하여야 합니다.');
          if (offset + written + chunk.length > manifest.size) throw invalid('선언한 파일 크기를 초과했습니다.');
          let progress = 0;
          while (progress < chunk.length) {
            const result = await file.write(chunk, progress, chunk.length - progress, offset + written + progress);
            if (!result.bytesWritten) throw new Error('Unable to write attachment chunk');
            progress += result.bytesWritten;
          }
          written += chunk.length;
        }
        await file.sync();
        manifest.touched = Date.now();
        await this.save(manifest);
        return { offset: offset + written };
      } catch (error) {
        await file.truncate(offset); await file.sync();
        throw this.storageError(error);
      } finally { await file.close(); }
    });
  }

  async complete(id: string, owner: string): Promise<Attachment> {
    return this.lock(id, async () => {
      const manifest = await this.load(id, owner);
      const store = this.store(manifest.target);
      if (manifest.receipt) { await this.verifyReceipt(manifest); return manifest.receipt; }
      const offset = await this.offset(manifest);
      if (offset !== manifest.size) throw Object.assign(new TowerError('conflict', `파일 업로드가 완료되지 않았습니다. 현재 위치: ${offset}`), { offset });
      // If publication finished before the receipt was written, the predetermined ID recovers it.
      let recovered: Attachment | undefined;
      try {
        const saved = await store.openVerified(manifest.attachmentId, manifest.target.sessionId, owner);
        try {
          if (saved.metadata.name !== manifest.name || saved.metadata.size !== manifest.size) throw invalid('업로드 원본 정보가 일치하지 않습니다.');
          recovered = saved.metadata;
        } finally { await saved.file.close(); }
      } catch (error) { if (!(error instanceof TowerError) || error.kind !== 'not-found') throw error; }
      if (!recovered) {
        const file = await this.content(manifest);
        try { recovered = await store.upload(manifest.target.sessionId, manifest.name, manifest.mimeType, file.createReadStream({ start: 0, autoClose: false }), { pending: true, id: manifest.attachmentId, owner }); }
        finally { await file.close(); }
      }
      manifest.receipt = recovered; manifest.touched = Date.now();
      await this.save(manifest);
      await rm(join(this.directory, id, 'content'), { force: true });
      return recovered;
    }).catch(error => { throw this.storageError(error); });
  }

  async cancel(id: string, owner: string): Promise<void> {
    await this.lock(id, async () => {
      await this.load(id, owner);
      // Completed originals may already be referenced by a durable run and belong to its store.
      await rm(join(this.directory, id), { recursive: true, force: true });
    });
  }

  async sweep(): Promise<void> {
    await this.checkDirectory(this.directory);
    const now = Date.now();
    for (const id of await readdir(this.directory)) {
      if (!ATTACHMENT_ID.test(id) || this.locks.has(id)) continue;
      await this.lock(id, async () => {
        const directory = join(this.directory, id);
        const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (!info || !info.isDirectory() || info.isSymbolicLink()) return;
        let manifest: UploadManifest | undefined;
        try { manifest = await this.loadManifest(id); }
        catch (error) { if (!isIncompleteAttachmentMetadata(error)) throw error; }
        const content = await lstat(join(directory, 'content')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        const lastWrite = Math.max(info.mtimeMs, content?.mtimeMs ?? 0, manifest?.touched ?? 0);
        if (lastWrite <= now - ATTACHMENT_TTL_MS) await rm(directory, { recursive: true, force: true });
      });
    }
    await this.options.chat.sweepPending(this.options.protectedChat?.() ?? new Set(), new Set(), { published: this.options.publishedGC ?? false });
    await this.options.auto.sweepPending(new Set(), this.options.protectedAuto?.() ?? new Set(), { published: this.options.publishedGC ?? false });
  }

  private store(target: AttachmentUploadTarget): AttachmentStore { return target.kind === 'chat' ? this.options.chat : this.options.auto; }

  private async verifyReceipt(manifest: UploadManifest): Promise<void> {
    const file = await this.store(manifest.target).openVerified(manifest.attachmentId, manifest.target.sessionId, manifest.owner);
    try { if (JSON.stringify(file.metadata) !== JSON.stringify(manifest.receipt)) throw missing(); }
    finally { await file.file.close(); }
  }
  private async offset(manifest: UploadManifest): Promise<number> {
    if (manifest.receipt) { await this.verifyReceipt(manifest); return manifest.size; }
    const file = await this.content(manifest);
    try { const size = (await file.stat()).size; if (!Number.isSafeInteger(size) || size > manifest.size) throw missing(); return size; }
    finally { await file.close(); }
  }

  private async load(id: string, owner: string): Promise<UploadManifest> {
    const manifest = await this.loadManifest(id);
    if (typeof owner !== 'string' || manifest.owner !== owner) throw missing();
    if (manifest.touched <= Date.now() - ATTACHMENT_TTL_MS) {
      // A crashed in-flight chunk can have a more recent prefix than its last manifest write.
      const content = await lstat(join(this.directory, id, 'content')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!content || content.mtimeMs <= Date.now() - ATTACHMENT_TTL_MS) throw missing();
      manifest.touched = Math.floor(content.mtimeMs); await this.save(manifest);
    }
    return manifest;
  }

  private async loadManifest(id: string): Promise<UploadManifest> {
    if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) throw missing();
    try {
      await this.checkDirectory(this.directory); await this.checkDirectory(join(this.directory, id));
      const file = await open(join(this.directory, id, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let manifest: UploadManifest;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 8192) throw missing();
        manifest = JSON.parse((await file.readFile()).toString('utf8'));
      } finally { await file.close(); }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw missing();
      if (manifest.id !== id || !ATTACHMENT_ID.test(manifest.attachmentId) || typeof manifest.owner !== 'string' || !manifest.owner
        || !manifest.target || !['chat', 'auto'].includes(manifest.target.kind) || typeof manifest.target.sessionId !== 'string' || !manifest.target.sessionId
        || typeof manifest.name !== 'string' || validatedAttachmentMime(manifest.name, manifest.mimeType) !== manifest.mimeType
        || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || !Number.isSafeInteger(manifest.touched) || manifest.touched < 0
        || (manifest.receipt !== undefined && (!attachmentMetadata(manifest.receipt) || manifest.receipt.id !== manifest.attachmentId || manifest.receipt.name !== manifest.name || manifest.receipt.size !== manifest.size))) throw missing();
      return manifest;
    } catch (error) {
      if (!isIncompleteAttachmentMetadata(error)) throw error;
      throw missing();
    }
  }

  private async content(manifest: UploadManifest): Promise<FileHandle> {
    await this.checkDirectory(this.directory); await this.checkDirectory(join(this.directory, manifest.id));
    const file = await open(join(this.directory, manifest.id, 'content'), constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw missing();
      return file;
    } catch (error) { await file.close(); throw error; }
  }
  private async checkDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TowerError('unavailable', '업로드 저장 폴더가 올바르지 않습니다.');
  }
  private async save(manifest: UploadManifest): Promise<void> {
    const directory = join(this.directory, manifest.id);
    const temporary = join(directory, `.manifest-${randomUUID()}.json`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(manifest)); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, join(directory, 'manifest.json')); }
    finally { await rm(temporary, { force: true }); }
  }
  private storageError(error: unknown): unknown {
    return ['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '') ? new TowerError('storage-full', '파일을 저장할 디스크 여유 공간이 부족합니다.', { cause: error }) : error;
  }
  private async lock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) throw missing();
    const previous = this.locks.get(id) ?? Promise.resolve();
    // best-effort: the previous operation's rejection already reached its caller; it must not poison this ID's queue.
    const result = previous.catch(() => undefined).then(operation);
    this.locks.set(id, result);
    try { return await result; }
    finally { if (this.locks.get(id) === result) this.locks.delete(id); }
  }
}
