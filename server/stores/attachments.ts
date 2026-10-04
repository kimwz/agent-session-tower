import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Attachment, MessageAttachments } from '../../shared/types.js';
import { isImageAttachment, normalizeAttachmentMimeType, selectInlineImages, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from '../../shared/attachments.js';
import { TowerError, type ErrorKind } from '../../shared/errors.js';

export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const invalid = (message: string, kind: ErrorKind = 'invalid') => new TowerError(kind, message);
class InvalidAttachmentManifest extends Error {}
/** Only malformed or absent publications are eligible for crash recovery; I/O failures are not. */
export function isIncompleteAttachmentMetadata(error: unknown): boolean {
  return error instanceof InvalidAttachmentManifest || error instanceof SyntaxError
    || (error instanceof TowerError && (error.kind === 'not-found' || error.kind === 'invalid'))
    || ['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

/** `sessionId` is the conversation the file was attached in. Large files contain only an excerpt. */
export interface StoredAttachment { metadata: Attachment; path: string; content: Buffer; sessionId: string }
export interface VerifiedAttachment { metadata: Attachment; path: string; file: FileHandle; sessionId: string }
interface ContentFingerprint { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface Manifest extends Attachment { sessionId: string; sha256: string; pendingUntil?: number; owner?: string; fingerprint?: ContentFingerprint }
export interface PreparedAttachments { attachments: Attachment[]; createdIds: string[] }
export interface AttachmentUploadOptions { pending?: boolean; owner?: string; /** Internal transaction identity, never caller-supplied HTTP data. */ id?: string }

export function validAttachmentName(name: unknown): name is string {
  if (typeof name !== 'string' || !name.trim().length || name === '.' || name === '..'
    || Buffer.byteLength(name) > 240 || /[\x00-\x1f\x7f/\\]/.test(name)) return false;
  try { encodeURIComponent(name); return true; } catch { return false; }
}

export function attachmentMetadata(value: unknown): Attachment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<Attachment>;
  if (typeof item.id !== 'string' || !ATTACHMENT_ID.test(item.id) || !validAttachmentName(item.name)
    || typeof item.mimeType !== 'string' || item.mimeType.length > 127 || !MIME.test(item.mimeType)
    || !Number.isSafeInteger(item.size) || item.size! < 0) return undefined;
  return { id: item.id, name: item.name, mimeType: item.mimeType, size: item.size! };
}

export function validatedAttachmentMime(name: string, supplied: string): string {
  if (!validAttachmentName(name) || typeof supplied !== 'string') throw invalid('첨부 파일 이름 또는 형식이 올바르지 않습니다.');
  const mime = normalizeAttachmentMimeType(supplied, name);
  if (mime.length > 127 || !MIME.test(mime)) throw invalid('첨부 파일 형식이 올바르지 않습니다.');
  return mime;
}

/** Magic bytes decide the image type; a declared MIME type is only a claim. */
export function rasterMime(content: Buffer): string | undefined {
  if (content.length >= 24 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && content.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (content.length >= 4 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  if (content.length >= 13 && ['GIF87a', 'GIF89a'].includes(content.toString('ascii', 0, 6))) return 'image/gif';
  if (content.length >= 20 && content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/** Attachment IDs resolve exclusively inside this private, monitor-owned store. */
export class AttachmentStore {
  readonly directory: string;
  private readonly active = new Set<string>();
  private readonly pendingDeletions = new Map<string, Promise<void>>();
  private readonly verified = new Map<string, { sha256: string; size: number; fingerprint: ContentFingerprint }>();
  constructor(stateDir: string) { this.directory = join(stateDir, 'attachments'); }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory(this.directory);
    const dir = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await dir.chmod(0o700); } finally { await dir.close(); }
  }

  async upload(sessionId: string, name: string, suppliedMime: string, chunks: AsyncIterable<Buffer>, options: AttachmentUploadOptions = {}): Promise<Attachment> {
    const mime = validatedAttachmentMime(name, suppliedMime);
    if (typeof sessionId !== 'string' || !sessionId || (options.id !== undefined && !ATTACHMENT_ID.test(options.id))
      || (options.owner !== undefined && (typeof options.owner !== 'string' || !options.owner))) throw invalid('첨부 파일 대상이 올바르지 않습니다.');
    const id = options.id ?? randomUUID();
    if (this.active.has(id)) throw invalid('첨부 파일 저장이 진행 중입니다.', 'conflict');
    this.active.add(id);
    const temporary = join(this.directory, `.upload-${id}`);
    const destination = join(this.directory, id);
    try {
      await this.checkDirectory(this.directory);
      // A completed transaction must never be replaced, even on a retried completion.
      try { await lstat(destination); throw invalid('첨부 파일이 이미 저장되어 있습니다.', 'conflict'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // The caller owns a fixed ID lock. An interrupted attempt can be rebuilt from staging.
      await rm(temporary, { recursive: true, force: true });
      await mkdir(temporary, { mode: 0o700 });
      await mkdir(join(temporary, 'content'), { mode: 0o700 });
      const file = await open(join(temporary, 'content', name), 'wx', 0o600);
      let size = 0; let prefix = Buffer.alloc(0);
      let fingerprint: ContentFingerprint;
      const hash = createHash('sha256');
      try {
        for await (const chunk of chunks) {
          if (!Buffer.isBuffer(chunk) || !Number.isSafeInteger(size + chunk.length)) throw invalid('첨부 파일 데이터가 올바르지 않습니다.');
          size += chunk.length;
          if (prefix.length < 24) prefix = Buffer.concat([prefix, chunk.subarray(0, 24 - prefix.length)]);
          hash.update(chunk);
          await file.writeFile(chunk);
        }
        await file.sync();
        const info = await file.stat();
        fingerprint = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
      } finally { await file.close(); }
      const detected = rasterMime(prefix);
      if (isImageAttachment(mime) && detected !== mime) throw invalid('이미지 내용과 파일 형식이 일치하지 않습니다.');
      const metadata: Attachment = { id, name, mimeType: detected || mime, size };
      const manifest: Manifest = { ...metadata, sessionId, sha256: hash.digest('hex'), fingerprint, ...(options.pending ? { pendingUntil: Date.now() + ATTACHMENT_TTL_MS } : {}), ...(options.owner ? { owner: options.owner } : {}) };
      await this.write(join(temporary, '.metadata.json'), Buffer.from(JSON.stringify(manifest)));
      await rename(temporary, destination);
      return metadata;
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
    finally { this.active.delete(id); }
  }

  async prepare(sessionId: string, request: MessageAttachments = {}, owner?: string): Promise<PreparedAttachments> {
    const uploads = request.attachments === undefined ? [] : request.attachments;
    const ids = request.attachmentIds === undefined ? [] : request.attachmentIds;
    if (!Array.isArray(uploads) || !Array.isArray(ids)) throw invalid('첨부 파일 목록 형식이 올바르지 않습니다.');
    if (uploads.length + ids.length > MAX_ATTACHMENTS) throw invalid(`첨부 파일은 최대 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다.`, 'too-large');
    if (new Set(ids).size !== ids.length) throw invalid('같은 첨부 파일을 중복으로 보낼 수 없습니다.');
    const existing: Attachment[] = [];
    for (const id of ids) {
      const saved = await this.openVerified(id, sessionId, owner);
      try { existing.push(saved.metadata); } finally { await saved.file.close(); }
    }
    let total = 0;
    const fresh = uploads.map(input => {
      if (!input || typeof input !== 'object' || !validAttachmentName(input.name) || typeof input.mimeType !== 'string'
        || typeof input.data !== 'string') throw invalid('첨부 파일 이름 또는 형식이 올바르지 않습니다.');
      const suppliedMime = validatedAttachmentMime(input.name, input.mimeType);
      if (input.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw invalid('파일 하나의 크기는 10 MB 이하여야 합니다.', 'too-large');
      if (input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw invalid('첨부 파일 데이터가 올바른 Base64 형식이 아닙니다.');
      const content = Buffer.from(input.data, 'base64');
      if (content.toString('base64') !== input.data) throw invalid('첨부 파일 데이터가 올바른 Base64 형식이 아닙니다.');
      if (content.length > MAX_ATTACHMENT_BYTES) throw invalid('파일 하나의 크기는 10 MB 이하여야 합니다.', 'too-large');
      const detected = rasterMime(content);
      if (isImageAttachment(suppliedMime) && suppliedMime !== detected) throw invalid('이미지 내용과 파일 형식이 일치하지 않습니다.');
      const mimeType = detected || suppliedMime;
      if (isImageAttachment(mimeType) && content.length > MAX_IMAGE_ATTACHMENT_BYTES) throw invalid('이미지 하나의 크기는 5 MB 이하여야 합니다.', 'too-large');
      total += content.length;
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw invalid('첨부 파일의 전체 크기는 20 MB 이하여야 합니다.', 'too-large');
      return { name: input.name, mimeType, content };
    });
    const createdIds: string[] = []; const saved: Attachment[] = [];
    try {
      for (const item of fresh) {
        async function* chunks() { yield item.content; }
        const metadata = await this.upload(sessionId, item.name, item.mimeType, chunks(), { pending: true });
        createdIds.push(metadata.id); saved.push(metadata);
      }
      return { attachments: [...existing, ...saved], createdIds };
    } catch (error) { await this.rollback(createdIds); throw error; }
  }

  async import(sessionId: string, source: AttachmentStore, sourceScope: string, ids: readonly string[]): Promise<PreparedAttachments> {
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) throw invalid('첨부 파일 목록 형식이 올바르지 않습니다.');
    const attachments: Attachment[] = []; const createdIds: string[] = [];
    try {
      for (const id of ids) {
        const opened = await source.openVerified(id, sourceScope);
        try {
          const metadata = await this.upload(sessionId, opened.metadata.name, opened.metadata.mimeType, opened.file.createReadStream({ start: 0, autoClose: false }), { pending: true });
          attachments.push(metadata); createdIds.push(metadata.id);
        } finally { await opened.file.close(); }
      }
      return { attachments, createdIds };
    } catch (error) { await this.rollback(createdIds); throw error; }
  }

  async rollback(ids: readonly string[]): Promise<void> {
    for (const id of ids) if (ATTACHMENT_ID.test(id)) {
      await rm(join(this.directory, id), { recursive: true, force: true });
      this.verified.delete(id);
    }
  }

  async openVerified(id: string, sessionId?: string, owner?: string): Promise<VerifiedAttachment> {
    if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) throw invalid('첨부 파일을 찾을 수 없습니다.', 'not-found');
    // GC registers deletion before yielding, so a later admission must observe its result.
    await this.pendingDeletions.get(id);
    let file: FileHandle | undefined;
    try {
      await this.checkDirectory(this.directory);
      const directory = join(this.directory, id);
      const manifest = await this.manifest(id);
      if (sessionId !== undefined && manifest.sessionId !== sessionId) throw new Error();
      if (owner !== undefined && manifest.owner !== undefined && manifest.owner !== owner) throw new Error();
      await this.checkDirectory(join(directory, 'content'));
      const path = join(directory, 'content', manifest.name);
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== manifest.size) throw new Error();
      let prefix: Buffer;
      const cached = this.verified.get(id);
      const previous = cached ? (cached.sha256 === manifest.sha256 && cached.size === manifest.size ? cached.fingerprint : undefined) : manifest.fingerprint;
      const sameFingerprint = previous && previous.dev === info.dev && previous.ino === info.ino && previous.size === info.size
        && previous.mtimeMs === info.mtimeMs && previous.ctimeMs === info.ctimeMs;
      if (sameFingerprint) {
        // Immutable originals were hashed before publication. The same inode's unchanged timestamps
        // avoid re-reading gigabytes when a reference crosses the worker's bounded RPC deadline.
        prefix = Buffer.alloc(Math.min(24, manifest.size));
        await file.read(prefix, 0, prefix.length, 0);
      } else {
        const hash = createHash('sha256'); prefix = Buffer.alloc(0); let size = 0;
        for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
          hash.update(chunk); size += chunk.length;
          if (prefix.length < 24) prefix = Buffer.concat([prefix, chunk.subarray(0, 24 - prefix.length)]);
        }
        if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error();
        const after = await file.stat();
        if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
          || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error();
      }
      if (isImageAttachment(manifest.mimeType) && rasterMime(prefix) !== manifest.mimeType) throw new Error();
      this.verified.set(id, { sha256: manifest.sha256, size: manifest.size, fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs } });
      return { metadata: attachmentMetadata(manifest)!, path, file, sessionId: manifest.sessionId };
    } catch (error) {
      if (file) await file.close();
      if ((error as NodeJS.ErrnoException)?.code && !isIncompleteAttachmentMetadata(error)) throw error;
      throw invalid('첨부 파일을 찾을 수 없거나 내용이 변경되었습니다. 파일을 다시 첨부하세요.', 'not-found');
    }
  }

  async read(id: string, sessionId?: string): Promise<StoredAttachment> {
    const opened = await this.openVerified(id, sessionId);
    try {
      const length = opened.metadata.size <= MAX_IMAGE_ATTACHMENT_BYTES ? opened.metadata.size : Math.min(4000, opened.metadata.size);
      const content = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await opened.file.read(content, offset, length - offset, offset);
        if (!bytesRead) throw invalid('첨부 파일 내용이 변경되었습니다.', 'not-found');
        offset += bytesRead;
      }
      return { metadata: opened.metadata, path: opened.path, content, sessionId: opened.sessionId };
    } finally { await opened.file.close(); }
  }

  async resolve(sessionId: string, attachments: readonly Attachment[] = []): Promise<StoredAttachment[]> {
    if (attachments.length > MAX_ATTACHMENTS) throw invalid('첨부 파일 개수가 너무 많습니다.');
    const result: StoredAttachment[] = [];
    for (const attachment of attachments) result.push(await this.read(attachment.id, sessionId));
    return result;
  }

  async retain(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (!ATTACHMENT_ID.test(id)) throw invalid('첨부 파일을 찾을 수 없습니다.', 'not-found');
      const manifest = await this.manifest(id);
      if (manifest.pendingUntil === undefined) continue;
      delete manifest.pendingUntil;
      const directory = join(this.directory, id);
      const temporary = join(directory, `.metadata-${randomUUID()}.json`);
      try { await this.write(temporary, Buffer.from(JSON.stringify(manifest))); await rename(temporary, join(directory, '.metadata.json')); }
      finally { await rm(temporary, { force: true }); }
    }
  }

  async sweepPending(protectedIDs: ReadonlySet<string> = new Set(), protectedScopes: ReadonlySet<string> = new Set(), options: { published?: boolean; isProtected?: (id: string, scope: string) => boolean } = {}): Promise<void> {
    await this.checkDirectory(this.directory);
    const now = Date.now();
    for (const name of await readdir(this.directory)) {
      const temporary = name.startsWith('.upload-');
      const id = temporary ? name.slice(8) : name;
      if (!ATTACHMENT_ID.test(id) || this.active.has(id) || protectedIDs.has(id)) {
        if (options.published !== false && !temporary && ATTACHMENT_ID.test(id) && protectedIDs.has(id) && !this.active.has(id)) {
          let manifest: Manifest | undefined;
          try { manifest = await this.manifest(id); }
          catch (error) { if (!isIncompleteAttachmentMetadata(error)) throw error; }
          if (manifest) {
            try { await this.retain([id]); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        }
        continue;
      }
      const path = join(this.directory, name);
      const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
      if (!temporary) {
        let manifest: Manifest | undefined;
        try { manifest = await this.manifest(id); }
        catch (error) { if (!isIncompleteAttachmentMetadata(error)) throw error; }
        if (manifest) {
          if (options.published === false || protectedScopes.has(manifest.sessionId)) continue;
          if (manifest.pendingUntil === undefined || manifest.pendingUntil > now) continue;
          if (options.isProtected?.(id, manifest.sessionId)) continue;
          const previousDeletion = this.pendingDeletions.get(id);
          if (previousDeletion) { await previousDeletion; continue; }
          // No await between the final protection check, registration and starting removal.
          let resolve!: () => void; let reject!: (error: unknown) => void;
          const deletion = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
          this.pendingDeletions.set(id, deletion);
          void rm(path, { recursive: true, force: true }).then(resolve, reject);
          try { await deletion; }
          finally { this.pendingDeletions.delete(id); this.verified.delete(id); }
          continue;
        }
      }
      if (await this.latestWrite(path) <= now - ATTACHMENT_TTL_MS) await rm(path, { recursive: true, force: true });
    }
  }

  private async latestWrite(directory: string): Promise<number> {
    try {
      const info = await lstat(directory);
      let latest = info.mtimeMs;
      for (const name of await readdir(directory)) {
        const entry = join(directory, name); const child = await lstat(entry);
        latest = Math.max(latest, child.mtimeMs);
        if (name === 'content' && child.isDirectory() && !child.isSymbolicLink()) {
          for (const filename of await readdir(entry)) latest = Math.max(latest, (await lstat(join(entry, filename))).mtimeMs);
        }
      }
      return latest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return Infinity;
    }
  }

  private async manifest(id: string): Promise<Manifest> {
    const directory = join(this.directory, id);
    await this.checkDirectory(directory);
    const manifest = JSON.parse((await this.readFile(join(directory, '.metadata.json'), 4096)).toString('utf8')) as Manifest;
    if (!attachmentMetadata(manifest) || manifest.id !== id || typeof manifest.sessionId !== 'string' || !manifest.sessionId
      || !/^[a-f\d]{64}$/.test(manifest.sha256) || (manifest.owner !== undefined && (typeof manifest.owner !== 'string' || !manifest.owner))
      || (manifest.fingerprint !== undefined && (!manifest.fingerprint || typeof manifest.fingerprint !== 'object'
        || !Number.isSafeInteger(manifest.fingerprint.dev) || !Number.isSafeInteger(manifest.fingerprint.ino)
        || manifest.fingerprint.size !== manifest.size || !Number.isFinite(manifest.fingerprint.mtimeMs) || !Number.isFinite(manifest.fingerprint.ctimeMs)))
      || (manifest.pendingUntil !== undefined && (!Number.isSafeInteger(manifest.pendingUntil) || manifest.pendingUntil < 0))) throw new InvalidAttachmentManifest('Invalid attachment metadata');
    return manifest;
  }

  private async checkDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid('첨부 파일 저장 폴더가 올바르지 않습니다.', 'unavailable');
  }
  private async readFile(path: string, maximum: number): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximum || info.nlink !== 1) throw new InvalidAttachmentManifest('Invalid attachment metadata file');
      const content = await file.readFile();
      if (content.length > maximum) throw new InvalidAttachmentManifest('Invalid attachment metadata size');
      return content;
    } finally { await file.close(); }
  }
  private async write(path: string, data: Buffer): Promise<void> {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  }
}

const ATTACHMENT_ONLY_PROMPT = '첨부한 파일을 확인하고 내용을 설명해 주세요.';
export function attachmentPrompt(prompt: string, attachments: readonly StoredAttachment[]): string {
  if (!attachments.length) return prompt;
  const instruction = prompt || ATTACHMENT_ONLY_PROMPT;
  return `${instruction}\n\n첨부 파일 (사용자가 이번 메시지에 첨부한 로컬 파일):\n${attachments.map(({ metadata, path }) => `- ${JSON.stringify(metadata.name)} (${metadata.mimeType}, ${metadata.size} bytes): ${JSON.stringify(path)}`).join('\n')}`;
}
export function imagePaths(attachments: readonly StoredAttachment[]): string[] {
  const selected = new Set(selectInlineImages(attachments.map(item => item.metadata)).map(item => item.id));
  return attachments.filter(item => selected.has(item.metadata.id)).map(item => item.path);
}
export function claudeImageBlocks(attachments: readonly StoredAttachment[]) {
  const selected = new Set(selectInlineImages(attachments.map(item => item.metadata)).map(item => item.id));
  return attachments.filter(item => selected.has(item.metadata.id)).map(item => ({
    type: 'image', source: { type: 'base64', media_type: item.metadata.mimeType, data: item.content.toString('base64') },
  }));
}
