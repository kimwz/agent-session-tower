import type { ServerResponse } from 'node:http';
import { STATUS } from '../../shared/errors.js';
import type { StreamSink } from '../streams/sink.js';

function sink(res: ServerResponse, head: (length?: number | string) => Record<string, string | number>): StreamSink {
  let opened = false;
  return {
    body: res,
    get opened() { return opened; },
    open(info = {}) { opened = true; res.writeHead(200, head(info.length)); },
    refuse(kind) { res.writeHead(STATUS[kind]).end(); },
    cutOff(graceMs) {
      const socket = res.socket;
      if (!socket || socket.destroyed) { res.destroy(); return; }
      const timer = setTimeout(() => res.destroy(), graceMs);
      socket.once('close', () => clearTimeout(timer));
      socket.end();
    },
  };
}

/** An event stream: never cached, never buffered by a proxy. */
export const sseSink = (res: ServerResponse): StreamSink => sink(res, () => ({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }));

/** Audio read aloud: mp3, never cached; with a length it is a finite file a player can seek in. */
export const audioSink = (res: ServerResponse): StreamSink => sink(res, length => ({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', ...(length !== undefined ? { 'Content-Length': length } : {}) }));
