import { constants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Attachment, MessageAttachments } from '../../shared/types.js';
import { isImageAttachment, normalizeAttachmentMimeType, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from '../../shared/attachments.js';

const ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const invalid = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export interface StoredAttachment { metadata: Attachment; path: string; content: Buffer }
interface Manifest extends Attachment { sessionId: string; sha256: string }
export interface PreparedAttachments { attachments: Attachment[]; createdIds: string[] }

function validName(name: unknown): name is string {
  if (typeof name !== 'string' || !name.trim().length || name === '.' || name === '..'
    || Buffer.byteLength(name) > 240 || /[\x00-\x1f\x7f/\\]/.test(name)) return false;
  try { encodeURIComponent(name); return true; } catch { return false; }
}

export function attachmentMetadata(value: unknown): Attachment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<Attachment>;
  if (typeof item.id !== 'string' || !ID.test(item.id) || !validName(item.name)
    || typeof item.mimeType !== 'string' || item.mimeType.length > 127 || !MIME.test(item.mimeType)
    || !Number.isSafeInteger(item.size) || item.size! < 0 || item.size! > MAX_ATTACHMENT_BYTES) return undefined;
  return { id: item.id, name: item.name, mimeType: item.mimeType, size: item.size! };
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
  constructor(stateDir: string) { this.directory = join(stateDir, 'attachments'); }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid('첨부 파일 저장 폴더가 올바르지 않습니다.', 503);
    const dir = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await dir.chmod(0o700); } finally { await dir.close(); }
  }

  async prepare(sessionId: string, request: MessageAttachments = {}): Promise<PreparedAttachments> {
    const uploads = request.attachments === undefined ? [] : request.attachments;
    const ids = request.attachmentIds === undefined ? [] : request.attachmentIds;
    if (!Array.isArray(uploads) || !Array.isArray(ids)) throw invalid('첨부 파일 목록 형식이 올바르지 않습니다.');
    if (uploads.length + ids.length > MAX_ATTACHMENTS) throw invalid(`첨부 파일은 최대 ${MAX_ATTACHMENTS}개까지 보낼 수 있습니다.`, 413);
    if (new Set(ids).size !== ids.length) throw invalid('같은 첨부 파일을 중복으로 보낼 수 없습니다.');
    const existing: Attachment[] = [];
    let total = 0;
    for (const id of ids) {
      const saved = await this.read(id, sessionId);
      existing.push(saved.metadata); total += saved.metadata.size;
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw invalid('첨부 파일의 전체 크기는 20 MB 이하여야 합니다.', 413);
    }
    const fresh = uploads.map(input => {
      if (!input || typeof input !== 'object' || !validName(input.name) || typeof input.mimeType !== 'string'
        || typeof input.data !== 'string') throw invalid('첨부 파일 이름 또는 형식이 올바르지 않습니다.');
      const suppliedMime = normalizeAttachmentMimeType(input.mimeType, input.name);
      if (suppliedMime.length > 127 || !MIME.test(suppliedMime)) throw invalid('첨부 파일 형식이 올바르지 않습니다.');
      if (input.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw invalid('파일 하나의 크기는 10 MB 이하여야 합니다.', 413);
      if (input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw invalid('첨부 파일 데이터가 올바른 Base64 형식이 아닙니다.');
      const content = Buffer.from(input.data, 'base64');
      if (content.toString('base64') !== input.data) throw invalid('첨부 파일 데이터가 올바른 Base64 형식이 아닙니다.');
      if (content.length > MAX_ATTACHMENT_BYTES) throw invalid('파일 하나의 크기는 10 MB 이하여야 합니다.', 413);
      const detected = rasterMime(content);
      if (isImageAttachment(suppliedMime) && suppliedMime !== detected) throw invalid('이미지 내용과 파일 형식이 일치하지 않습니다.');
      const mimeType = detected || suppliedMime;
      if (isImageAttachment(mimeType) && content.length > MAX_IMAGE_ATTACHMENT_BYTES) throw invalid('이미지 하나의 크기는 5 MB 이하여야 합니다.', 413);
      total += content.length;
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw invalid('첨부 파일의 전체 크기는 20 MB 이하여야 합니다.', 413);
      return { metadata: { id: randomUUID(), name: input.name, mimeType, size: content.length }, content };
    });
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw invalid('첨부 파일의 전체 크기는 20 MB 이하여야 합니다.', 413);
    const createdIds: string[] = [];
    try {
      for (const { metadata, content } of fresh) {
        const directory = join(this.directory, metadata.id);
        await mkdir(directory, { mode: 0o700 });
        createdIds.push(metadata.id);
        await mkdir(join(directory, 'content'), { mode: 0o700 });
        await this.write(join(directory, 'content', metadata.name), content);
        await this.write(join(directory, '.metadata.json'), Buffer.from(JSON.stringify({ ...metadata, sessionId, sha256: digest(content) })));
      }
      return { attachments: [...existing, ...fresh.map(value => value.metadata)], createdIds };
    } catch (error) { await this.rollback(createdIds); throw error; }
  }

  async rollback(ids: readonly string[]): Promise<void> {
    for (const id of ids) if (ID.test(id)) await rm(join(this.directory, id), { recursive: true, force: true });
  }

  async read(id: string, sessionId?: string): Promise<StoredAttachment> {
    if (typeof id !== 'string' || !ID.test(id)) throw invalid('첨부 파일을 찾을 수 없습니다.', 404);
    try {
      const rootInfo = await lstat(this.directory);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error();
      const directory = join(this.directory, id);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      const manifest = JSON.parse((await this.readFile(join(directory, '.metadata.json'), 4096)).toString('utf8')) as Manifest;
      const metadata = attachmentMetadata(manifest);
      if (!metadata || metadata.id !== id || typeof manifest.sessionId !== 'string' || !/^[a-f\d]{64}$/.test(manifest.sha256)
        || (sessionId !== undefined && manifest.sessionId !== sessionId)) throw new Error();
      const contentInfo = await lstat(join(directory, 'content'));
      if (!contentInfo.isDirectory() || contentInfo.isSymbolicLink()) throw new Error();
      const path = join(directory, 'content', metadata.name);
      const content = await this.readFile(path, MAX_ATTACHMENT_BYTES);
      if (content.length !== metadata.size || digest(content) !== manifest.sha256
        || (isImageAttachment(metadata.mimeType) && (rasterMime(content) !== metadata.mimeType || content.length > MAX_IMAGE_ATTACHMENT_BYTES))) throw new Error();
      return { metadata, path, content };
    } catch { throw invalid('첨부 파일을 찾을 수 없거나 내용이 변경되었습니다. 파일을 다시 첨부하세요.', 404); }
  }

  async resolve(sessionId: string, attachments: readonly Attachment[] = []): Promise<StoredAttachment[]> {
    if (attachments.length > MAX_ATTACHMENTS) throw invalid('첨부 파일 개수가 너무 많습니다.');
    const result: StoredAttachment[] = [];
    let total = 0;
    for (const attachment of attachments) {
      const value = await this.read(attachment.id, sessionId);
      total += value.metadata.size;
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw invalid('첨부 파일의 전체 크기는 20 MB 이하여야 합니다.', 413);
      result.push(value);
    }
    return result;
  }

  private async readFile(path: string, maximum: number): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximum || info.nlink !== 1) throw new Error();
      const content = await file.readFile();
      if (content.length > maximum) throw new Error();
      return content;
    } finally { await file.close(); }
  }

  private async write(path: string, data: Buffer): Promise<void> {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  }
}

export function attachmentPrompt(prompt: string, attachments: readonly StoredAttachment[]): string {
  if (!attachments.length) return prompt;
  const instruction = prompt || '첨부한 파일을 확인하고 내용을 설명해 주세요.';
  return `${instruction}\n\n첨부 파일 (사용자가 이번 메시지에 첨부한 로컬 파일):\n${attachments.map(({ metadata, path }) => `- ${JSON.stringify(metadata.name)} (${metadata.mimeType}, ${metadata.size} bytes): ${JSON.stringify(path)}`).join('\n')}`;
}
