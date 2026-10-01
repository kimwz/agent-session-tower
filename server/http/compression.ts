import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, brotliCompressSync, constants, createBrotliCompress, createGzip, gzip, gzipSync, type BrotliCompress, type Gzip } from 'node:zlib';
import type { SseResponse } from './sse-client.js';

/**
 * How the web server shrinks what it sends: the snapshot alone is several megabytes, and through the public
 * tunnel every byte is slow. Clients that accept nothing (joined computers' links) get the bytes as they are.
 */
export type Encoding = 'br' | 'gzip';

/** Below this a compressed body saves nothing worth the work. */
const MIN_BYTES = 1024;
/** Dynamic bodies are compressed on every request, so quality stays low; static files are compressed once. */
const DYNAMIC_BROTLI = 4;
const STATIC_BROTLI = 9;
const GZIP_LEVEL = 6;
const STATIC_GZIP = 9;
/**
 * A 256 KiB window instead of brotli's 4 MiB default: an event stream keeps its compressor for the whole
 * connection, and after a 3.8 MB snapshot the default holds about 14 MB per open page, this about 1 MB,
 * for output still smaller than gzip's.
 */
const STREAM_WINDOW = 18;
/** Only text is worth compressing; images and audio are compressed already, and media players expect them as they are. */
const TEXT_FILES = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt', '.webmanifest']);

/** Brotli first, then gzip; a q=0 token refuses that encoding. */
export function acceptedEncoding(header: string | string[] | undefined): Encoding | undefined {
  const accepted = new Set<string>();
  for (const part of (Array.isArray(header) ? header.join(',') : header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map(param => param.trim()).find(param => param.startsWith('q='));
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name);
  }
  return accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : undefined;
}

const brotliOptions = (quality: number, size: number) => ({ params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: size } });

function compressSync(bytes: Buffer, encoding: Encoding): Buffer {
  return encoding === 'br' ? brotliCompressSync(bytes, brotliOptions(DYNAMIC_BROTLI, bytes.length)) : gzipSync(bytes, { level: GZIP_LEVEL });
}

/** Writes `body` compressed when the client accepts it and it is large enough; headers must not be sent yet. */
export function sendBody(res: ServerResponse, body: string | Buffer): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  res.setHeader('Vary', 'Accept-Encoding');
  const encoding = bytes.length >= MIN_BYTES ? acceptedEncoding(res.req.headers['accept-encoding']) : undefined;
  if (encoding) res.setHeader('Content-Encoding', encoding);
  res.end(encoding ? compressSync(bytes, encoding) : bytes);
}

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Build-hashed files: their names change with their contents, so browsers may keep them for good. */
export function isBuildAsset(name: string): boolean {
  return name.startsWith('assets/');
}

/**
 * Web files for one build, compressed once per process and off the event loop. The cache is keyed by
 * contents, not by URL (one file has many URLs, letter case included on case-insensitive disks), so it holds
 * at most that build's text files.
 */
export class StaticCompression {
  private readonly cache = new Map<string, Promise<Buffer>>();

  async body(name: string, content: Buffer, encoding: Encoding | undefined): Promise<{ body: Buffer; encoding?: Encoding }> {
    if (!encoding || content.length < MIN_BYTES || !TEXT_FILES.has(extname(name).toLowerCase())) return { body: content };
    const key = `${encoding}:${createHash('sha256').update(content).digest('base64url')}`;
    let compressed = this.cache.get(key);
    if (!compressed) {
      compressed = encoding === 'br' ? brotliAsync(content, brotliOptions(STATIC_BROTLI, content.length)) : gzipAsync(content, { level: STATIC_GZIP });
      this.cache.set(key, compressed);
      compressed.catch(() => this.cache.delete(key));
    }
    return { body: await compressed, encoding };
  }
}

/**
 * An event stream whose frames pass through one compressor for the whole connection, flushed after every
 * frame so each one reaches the browser at once. Backpressure follows the compressor, which stops taking
 * input while the socket behind it is full. Content-Encoding must be set before the headers are written.
 */
export function compressedEventStream(res: ServerResponse, encoding: Encoding): SseResponse {
  const compressor: BrotliCompress | Gzip = encoding === 'br'
    ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: DYNAMIC_BROTLI, [constants.BROTLI_PARAM_LGWIN]: STREAM_WINDOW, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT } })
    : createGzip({ level: GZIP_LEVEL });
  compressor.pipe(res);
  // A broken socket ends the stream through the response's 'close'; the compressor has nothing left to report.
  compressor.on('error', () => res.destroy());
  res.once('close', () => compressor.destroy());
  const flush = () => encoding === 'br' ? (compressor as BrotliCompress).flush(constants.BROTLI_OPERATION_FLUSH) : (compressor as Gzip).flush(constants.Z_SYNC_FLUSH);
  return {
    write(data) { const ok = compressor.write(data); flush(); return ok; },
    on(event, listener) { (event === 'drain' ? compressor : res).on(event, listener); return this; },
    off(event, listener) { (event === 'drain' ? compressor : res).off(event, listener); return this; },
    end() { compressor.end(); },
    get destroyed() { return res.destroyed || compressor.destroyed; },
    get writableEnded() { return res.writableEnded || compressor.writableEnded; },
  };
}
