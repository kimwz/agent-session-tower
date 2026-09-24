import { EventEmitter } from 'node:events';
import http2, { type ClientHttp2Stream } from 'node:http2';
import { StringDecoder } from 'node:string_decoder';
import { applySnapshotPatch, type SnapshotPatch } from '../../shared/snapshot-patch.js';
import type { Snapshot } from '../../shared/types.js';
import type { ControllerLinks } from './controller.js';

/** The shape the rest of this Tower relies on; another computer's frames are checked before they are used. */
function plausible(value: unknown): value is Snapshot {
  const snapshot = value as Partial<Snapshot> | null;
  const list = (item: unknown) => item === undefined || Array.isArray(item);
  return !!snapshot && typeof snapshot === 'object' && Array.isArray(snapshot.sessions) && Array.isArray(snapshot.runs) && Array.isArray(snapshot.providers)
    && list(snapshot.groups) && list(snapshot.autoPrompts) && list(snapshot.repositories) && typeof snapshot.hostname === 'string'
    && snapshot.sessions.every(item => item && typeof item.id === 'string' && typeof item.cwd === 'string')
    && snapshot.runs.every(item => item && typeof item.id === 'string' && typeof item.sessionId === 'string')
    && (snapshot.groups ?? []).every(item => item && typeof item.cwd === 'string');
}

/** A complete snapshot of a busy computer can be large; anything beyond this is not a frame. */
const MAX_FRAME_CHARS = 32 * 1024 * 1024;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** The other computer sends a heartbeat every 15 seconds. */
const SILENCE_MS = 45_000;

interface Mirror {
  snapshot?: Snapshot;
  sequence?: number;
  stream?: ClientHttp2Stream;
  retry?: ReturnType<typeof setTimeout>;
  silence?: ReturnType<typeof setTimeout>;
  failures: number;
  /** Receiving frames right now. When false, `snapshot` is the last state seen and may be out of date. */
  live: boolean;
}

/**
 * What each joined computer shows: its shared snapshot, followed over the link. The last state stays in memory
 * while a computer is unreachable, so its sessions are shown as out of date rather than gone.
 */
export class NodeMirrors extends EventEmitter {
  private readonly mirrors = new Map<string, Mirror>();
  private closed = false;

  constructor(private readonly links: ControllerLinks) {
    super();
    links.on('connected', this.connected);
    links.on('disconnected', this.disconnected);
    links.on('change', this.forget);
    for (const node of links.list()) if (links.session(node.id)) this.connected(node.id);
  }

  /** Computers with a known state, in the order they were first seen. */
  ids(): string[] { return [...this.mirrors].filter(([, mirror]) => mirror.snapshot).map(([id]) => id); }
  snapshot(id: string): Snapshot | undefined { return this.mirrors.get(id)?.snapshot; }
  live(id: string): boolean { return Boolean(this.mirrors.get(id)?.live); }

  close(): void {
    this.closed = true;
    this.links.off('connected', this.connected);
    this.links.off('disconnected', this.disconnected);
    this.links.off('change', this.forget);
    for (const mirror of this.mirrors.values()) this.stop(mirror);
    this.mirrors.clear();
  }

  private readonly connected = (id: string): void => {
    if (this.closed) return;
    const mirror = this.mirrors.get(id) ?? { failures: 0, live: false };
    this.mirrors.set(id, mirror);
    this.stop(mirror);
    mirror.failures = 0;
    this.open(id, mirror);
  };

  private readonly disconnected = (id: string): void => {
    const mirror = this.mirrors.get(id);
    if (!mirror) return;
    this.stop(mirror);
    if (mirror.live) { mirror.live = false; this.emit('change', id); }
  };

  /** A computer removed from this Tower leaves nothing behind. */
  private readonly forget = (): void => {
    const known = new Set(this.links.list().map(node => node.id));
    for (const [id, mirror] of [...this.mirrors]) {
      if (known.has(id)) continue;
      this.stop(mirror);
      this.mirrors.delete(id);
      this.emit('removed', id);
    }
  };

  private stop(mirror: Mirror): void {
    if (mirror.retry) clearTimeout(mirror.retry);
    if (mirror.silence) clearTimeout(mirror.silence);
    mirror.retry = mirror.silence = undefined;
    const stream = mirror.stream;
    mirror.stream = undefined;
    if (stream && !stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL);
  }

  private open(id: string, mirror: Mirror): void {
    const session = this.links.session(id);
    if (!session || this.closed) return;
    let stream: ClientHttp2Stream;
    try { stream = session.request({ ':method': 'GET', ':path': '/api/events?patch=1', accept: 'text/event-stream' }); }
    catch { this.again(id, mirror); return; }
    mirror.stream = stream;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let status = 0;
    const quiet = () => {
      if (mirror.silence) clearTimeout(mirror.silence);
      mirror.silence = setTimeout(() => { if (mirror.stream === stream) stream.close(http2.constants.NGHTTP2_CANCEL); }, SILENCE_MS);
    };
    quiet();
    const read = () => {
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!this.frame(id, mirror, frame)) { stream.close(http2.constants.NGHTTP2_CANCEL); return; }
      }
    };
    // The first frames can arrive before the answer's status is known; they wait for it rather than being lost.
    stream.on('response', headers => {
      status = Number(headers[':status']);
      if (status !== 200) { stream.close(http2.constants.NGHTTP2_CANCEL); return; }
      if (mirror.stream === stream) read();
    });
    stream.on('data', (chunk: Buffer) => {
      if (mirror.stream !== stream) return;
      quiet();
      if (status && status !== 200) return;
      buffer += decoder.write(chunk);
      if (buffer.length > MAX_FRAME_CHARS) { stream.close(http2.constants.NGHTTP2_CANCEL); return; }
      if (status === 200) read();
    });
    stream.on('error', () => {});
    stream.on('close', () => {
      if (mirror.stream !== stream) return;
      mirror.stream = undefined;
      if (mirror.silence) clearTimeout(mirror.silence);
      // The link itself may still be up: the other computer ended this stream (for example after its sharing
      // list changed) or a frame did not apply. Follow it again from a complete snapshot.
      if (mirror.live) { mirror.live = false; this.emit('change', id); }
      this.again(id, mirror);
    });
  }

  private again(id: string, mirror: Mirror): void {
    if (this.closed || !this.links.session(id) || mirror.retry) return;
    const wait = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(mirror.failures++, 5));
    mirror.retry = setTimeout(() => { mirror.retry = undefined; if (!mirror.stream) this.open(id, mirror); }, wait);
  }

  /** False when the frame cannot continue the mirror; the stream then starts over. */
  private frame(id: string, mirror: Mirror, text: string): boolean {
    let event = 'message';
    let data = '';
    let eventId: string | undefined;
    for (const line of text.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + (line[colon + 1] === ' ' ? 2 : 1));
      if (field === 'event') event = value;
      else if (field === 'data') data += data ? `\n${value}` : value;
      else if (field === 'id') eventId = value;
    }
    if (event !== 'snapshot' && event !== 'patch') return true;
    const sequence = Number(eventId);
    if (!Number.isSafeInteger(sequence)) return false;
    let next: Snapshot;
    try {
      if (event === 'snapshot') next = JSON.parse(data) as Snapshot;
      else {
        const patch = JSON.parse(data) as SnapshotPatch;
        if (!mirror.snapshot || !patch || patch.base !== mirror.sequence) return false;
        next = applySnapshotPatch(mirror.snapshot, patch);
      }
    } catch { return false; }
    if (!plausible(next)) return false;
    const previous = { snapshot: mirror.snapshot, sequence: mirror.sequence };
    mirror.snapshot = next;
    mirror.sequence = sequence;
    mirror.live = true;
    try { this.emit('change', id); }
    catch {
      // Whatever this state broke on this side, it stays with this computer: back to the last good state, and a fresh start.
      mirror.snapshot = previous.snapshot;
      mirror.sequence = previous.sequence;
      return false;
    }
    // Only a frame this Tower could use shows the stream is healthy; one it refuses keeps the retry waits growing.
    mirror.failures = 0;
    return true;
  }
}
