import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createZstdDecompress, zstdDecompress } from 'node:zlib';

/**
 * How a native transcript's bytes are read. Codex's rollout compression worker replaces a rollout it has not touched for
 * a while with `<name>.jsonl.zst` (zstd, same modification time), and writes `<name>.jsonl` again when the conversation
 * goes on. A compressed transcript reads as its decompressed content: sizes and positions are those of the JSONL.
 */
export const COMPRESSED_SUFFIX = '.jsonl.zst';
export const compressedTranscript = (path: string): boolean => path.endsWith(COMPRESSED_SUFFIX);

export interface TranscriptFile {
  /** Bytes of the JSONL content. */
  readonly size: number;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  /** The content from `start` to the end. */
  stream(start: number): Readable;
  close(): Promise<void>;
}

/** A decompressed transcript larger than this is used once and not kept. */
const CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CONTENT = 1024 * 1024 * 1024;
const decompress = promisify(zstdDecompress);

/** Decompressed transcripts by file identity, least recently used first, within CACHE_BYTES in total. */
const cache = new Map<string, Buffer>();
let cached = 0;
const decompressing = new Map<string, Promise<Buffer>>();

function remember(key: string, content: Buffer): void {
  if (content.length > CACHE_BYTES) return;
  cache.set(key, content); cached += content.length;
  for (const [old, value] of cache) {
    if (cached <= CACHE_BYTES) break;
    cache.delete(old); cached -= value.length;
  }
}

const CHUNK = 128 * 1024;

/**
 * The content from `from` to `end` (or to the end), in chunks, for one pass from start to end: a compressed transcript
 * is decompressed as it is read and never held whole, so the scan of hundreds of them stays small.
 */
export async function* transcriptChunks(path: string, from = 0, end?: number): AsyncGenerator<Buffer> {
  if (compressedTranscript(path)) {
    let position = 0;
    const input = createReadStream(path), output = input.pipe(createZstdDecompress());
    input.on('error', error => output.destroy(error));
    try {
      for await (const chunk of output as AsyncIterable<Buffer>) {
        const data = chunk.subarray(Math.max(0, from - position), end === undefined ? chunk.length : Math.max(0, end - position));
        position += chunk.length;
        if (data.length) yield data;
        if (end !== undefined && position >= end) break;
        if (position > MAX_CONTENT) throw new Error('Compressed transcript exceeds the content limit.');
      }
    } finally { input.destroy(); output.destroy(); }
    return;
  }
  const file = await open(path, 'r');
  try {
    const last = end ?? (await file.stat()).size;
    for (let position = from; position < last;) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, last - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) return;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally { await file.close(); }
}

/** `keep: false` reads a compressed transcript without keeping it: a pass over many of them would push out the rest. */
export async function openTranscript(path: string, options: { keep?: boolean } = {}): Promise<TranscriptFile> {
  const handle = await open(path, 'r');
  if (!compressedTranscript(path)) {
    try {
      const { size } = await handle.stat();
      return { size, read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        stream: start => start < size ? createReadStream(path, { start, end: size - 1 }) : Readable.from([]), close: () => handle.close() };
    } catch (error) { await handle.close(); throw error; }
  }
  let content: Buffer;
  try {
    const info = await handle.stat();
    const key = `${path}\0${info.ino}\0${info.size}\0${info.mtimeMs}`;
    const known = cache.get(key);
    if (known) { cache.delete(key); cache.set(key, known); content = known; }
    else {
      let pending = decompressing.get(key);
      if (!pending) {
        pending = handle.readFile().then(data => decompress(data, { maxOutputLength: MAX_CONTENT }));
        decompressing.set(key, pending);
        // best-effort: only forgets the shared decompression; its error reaches every caller awaiting `pending`.
        void pending.finally(() => decompressing.delete(key)).catch(() => {});
      }
      content = await pending;
      if (options.keep !== false && !cache.has(key)) remember(key, content);
    }
  } finally { await handle.close(); }
  return {
    size: content.length,
    read: async (buffer, offset, length, position) => ({ bytesRead: position >= content.length ? 0 : content.copy(buffer, offset, position, Math.min(content.length, position + length)) }),
    stream: start => Readable.from(start < content.length ? [content.subarray(start)] : [], { objectMode: false }),
    close: async () => {},
  };
}

/** The first `limit` bytes of compressed content, and whether there is more: for a preview of a stored copy. */
export async function decompressedPrefix(compressed: Buffer, limit: number): Promise<{ data: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = []; let bytes = 0;
  const output = Readable.from([compressed], { objectMode: false }).pipe(createZstdDecompress());
  try {
    for await (const chunk of output as AsyncIterable<Buffer>) {
      chunks.push(chunk); bytes += chunk.length;
      if (bytes > limit) break;
    }
  } finally { output.destroy(); }
  const data = Buffer.concat(chunks, bytes);
  return { data: data.subarray(0, limit), truncated: data.length > limit };
}
