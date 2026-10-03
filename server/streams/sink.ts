import type { Writable } from 'node:stream';
import type { ErrorKind } from '../../shared/errors.js';

/**
 * Where a stream the domain writes (voice audio, a terminal's events) goes, without the domain speaking HTTP. The edge
 * makes one around its response (server/http/sinks.ts) and decides the heads; the domain writes the body.
 */
export interface StreamSink {
  /** The response itself: `write`, `end`, `destroy`, `destroyed`, `writableEnded`, and `drain`/`finish`/`close`/`error`. */
  readonly body: Writable;
  /** Whether `open` wrote the head. */
  readonly opened: boolean;
  /** Writes the success head, once; a length makes it a finite file. */
  open(info?: { length?: number | string }): void;
  /** Answers with no body and ends cleanly; only before `open`. */
  refuse(kind: Extract<ErrorKind, 'not-found' | 'upstream'>): void;
  /** Ends the connection rather than the response, so what is queued still leaves and the reader sees it cut short; destroyed after `graceMs`. */
  cutOff(graceMs: number): void;
}
