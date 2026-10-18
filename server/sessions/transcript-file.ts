import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';

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

/** `cache: false` reads without keeping the content: the scan reads every compressed transcript once. */
export async function openTranscript(path: string, options: { cache?: boolean } = {}): Promise<TranscriptFile> {
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
        void pending.finally(() => decompressing.delete(key)).catch(() => {});
      }
      content = await pending;
      if (options.cache !== false && !cache.has(key)) remember(key, content);
    }
  } finally { await handle.close(); }
  return {
    size: content.length,
    read: async (buffer, offset, length, position) => ({ bytesRead: position >= content.length ? 0 : content.copy(buffer, offset, position, Math.min(content.length, position + length)) }),
    stream: start => Readable.from(start < content.length ? [content.subarray(start)] : [], { objectMode: false }),
    close: async () => {},
  };
}
