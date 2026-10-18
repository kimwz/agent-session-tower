import { UPLOAD_CHUNK_BYTES } from '../../../../shared/attachments';
import { TODO_FILE_MAX_BYTES, type TodoChanges, type TodoFile } from '../../../../shared/todo/types';
import { isWorkspaceMediaType } from '../../../../shared/workspace-media';

/**
 * Sending one attachment: start an upload, send its bytes in pieces from where the server says it is, then complete
 * it. The server's answer to a piece sent at the wrong place is where it really is (409 with `offset`), so a lost
 * answer, a retry or a reload goes on from there instead of starting again. The transport is passed in (`UploadIO`),
 * which keeps this testable without a network.
 */

export const MIN_CHUNK_BYTES = 64 * 1024;
/** A piece should take about this long; a slow phone uplink gets smaller pieces so each request finishes. */
const CHUNK_TARGET_MS = 20_000;

/** Why a file cannot be sent at all, before anything is sent. */
export function fileProblem(size: number): 'too-large' | undefined {
  return size > TODO_FILE_MAX_BYTES ? 'too-large' : undefined;
}

/** The next piece to send from `offset`, or null when everything is there. */
export function nextChunk(offset: number, size: number, chunkBytes: number): { start: number; end: number } | null {
  return offset >= size ? null : { start: offset, end: Math.min(size, offset + chunkBytes) };
}

/** The piece size after one took `elapsedMs` (or failed): smaller when slow, never above the server's limit. */
export function nextChunkBytes(current: number, elapsedMs: number | 'failed'): number {
  if (elapsedMs === 'failed') return Math.max(MIN_CHUNK_BYTES, Math.floor(current / 2));
  if (elapsedMs > CHUNK_TARGET_MS) return Math.max(MIN_CHUNK_BYTES, Math.floor(current * CHUNK_TARGET_MS / elapsedMs));
  return Math.min(UPLOAD_CHUNK_BYTES, current);
}

/** A piece's answer: where the server now is, or where it is instead (a piece at the wrong place). */
export type AppendResult = { offset: number } | { conflict: number };

export interface UploadIO {
  start(input: { taskId: string; commentId?: string; name: string; mimeType: string; size: number }, signal: AbortSignal): Promise<{ id: string; offset: number }>;
  offset(id: string, signal: AbortSignal): Promise<number>;
  append(id: string, offset: number, piece: Blob, signal: AbortSignal): Promise<AppendResult>;
  /** The file and what it changed, or where the bytes really end when they are not all there. */
  complete(id: string, signal: AbortSignal): Promise<{ file: TodoFile; changes: TodoChanges } | { conflict: number }>;
  cancel(id: string): Promise<void>;
}

/** `finishing`: the server is making the attachment, which a cancel could no longer take back. */
export type UploadStatus = 'waiting' | 'uploading' | 'finishing' | 'failed' | 'done';

export interface UploadJob {
  key: string;
  taskId: string;
  commentId: string | null;
  file: Blob;
  name: string;
  mimeType: string;
  size: number;
  status: UploadStatus;
  /** Bytes the server has. */
  offset: number;
  /** The server's upload, once started: a retry goes on with it. */
  uploadId?: string;
  chunkBytes: number;
  error?: string;
  /** Asked to complete once: the server may have made the file even when its answer was lost. */
  completing?: boolean;
}

export function newJob(key: string, file: Blob & { name?: string }, target: { taskId: string; commentId?: string | null }): UploadJob {
  return { key, taskId: target.taskId, commentId: target.commentId ?? null, file, name: (file.name || 'file').slice(0, 255), mimeType: file.type || 'application/octet-stream',
    size: file.size, status: 'uploading', offset: 0, chunkBytes: UPLOAD_CHUNK_BYTES };
}

/** Where a server's offset may be: within the file, and never behind what it already confirmed unless it says so. */
function checkedOffset(value: number, size: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > size) throw new Error('업로드 위치가 올바르지 않습니다.');
  return value;
}

/**
 * Sends a job to the end, reporting each change of it. A job with an `uploadId` asks the server where it is first.
 * Rejects with the abort reason when `signal` aborts; the job's last report says how far it got.
 */
export async function runUpload(job: UploadJob, io: UploadIO, signal: AbortSignal, report: (job: UploadJob) => void,
  now: () => number = () => Date.now()): Promise<{ file: TodoFile; changes: TodoChanges }> {
  let current: UploadJob = { ...job, status: 'uploading', error: undefined };
  const update = (patch: Partial<UploadJob>) => { current = { ...current, ...patch }; report(current); };
  update({});
  if (!current.uploadId) {
    const started = await io.start({ taskId: current.taskId, ...(current.commentId ? { commentId: current.commentId } : {}), name: current.name, mimeType: current.mimeType, size: current.size }, signal);
    update({ uploadId: started.id, offset: checkedOffset(started.offset, current.size) });
  } else {
    update({ offset: checkedOffset(await io.offset(current.uploadId, signal), current.size) });
  }
  const id = current.uploadId!;
  for (;;) {
    for (let piece = nextChunk(current.offset, current.size, current.chunkBytes); piece; piece = nextChunk(current.offset, current.size, current.chunkBytes)) {
      const began = now();
      let answer: AppendResult;
      try { answer = await io.append(id, piece.start, current.file.slice(piece.start, piece.end), signal); }
      catch (error) {
        // A failed piece is sent smaller next time.
        update({ chunkBytes: nextChunkBytes(current.chunkBytes, 'failed') });
        throw error;
      }
      if ('conflict' in answer) { update({ offset: checkedOffset(answer.conflict, current.size) }); continue; }
      if (answer.offset <= piece.start) throw new Error('업로드 위치가 올바르지 않습니다.');
      update({ offset: checkedOffset(answer.offset, current.size), chunkBytes: nextChunkBytes(current.chunkBytes, now() - began) });
    }
    update({ status: 'finishing', completing: true });
    const done = await io.complete(id, signal);
    if ('conflict' in done) { update({ status: 'uploading', offset: checkedOffset(done.conflict, current.size) }); continue; }
    update({ status: 'done', offset: current.size });
    return done;
  }
}

const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
/** Shown as a thumbnail: an image type the server can send inline (it checks the bytes too). */
export const isPreviewable = (file: Pick<TodoFile, 'mimeType' | 'missing'>) => !file.missing && IMAGE.test(file.mimeType);
/** Played in the page: video or audio of a type the server sends inline (as the workspace plays them). */
export const playable = (file: Pick<TodoFile, 'mimeType' | 'missing'>): 'video' | 'audio' | undefined =>
  file.missing || !isWorkspaceMediaType(file.mimeType) ? undefined : file.mimeType.startsWith('video/') ? 'video' : file.mimeType.startsWith('audio/') ? 'audio' : undefined;

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
