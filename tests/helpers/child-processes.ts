import type { ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { TestContext } from 'node:test';

type Owned = { child: ChildProcess; closed: Promise<unknown>; stop: () => void };
const scopes = new WeakMap<TestContext, { children: Owned[]; directories: string[] }>();

/**
 * The test's one cleanup, registered once: every child it owns that still runs is asked to end, every child is awaited
 * until it has closed, and only then do its directories go. A single hook, so no wait on a child can come before the
 * step that ends it, whichever barrier the test failed at.
 */
function scope(t: TestContext) {
  let owned = scopes.get(t);
  if (!owned) {
    const own = { children: [] as Owned[], directories: [] as string[] };
    scopes.set(t, owned = own);
    t.after(async () => {
      for (const { child, stop } of own.children) if (child.exitCode === null && child.signalCode === null) stop();
      await Promise.allSettled(own.children.map(({ closed }) => closed));
      await Promise.all(own.directories.map(directory => rm(directory, { recursive: true, force: true })));
    });
  }
  return owned;
}

/** A directory the test made, removed once every child it owns has closed. */
export function ownDirectory(t: TestContext, directory: string): void { scope(t).directories.push(directory); }

/**
 * A child the test spawned; `closed` settles on its `close`. At the test's end a child still running is asked to end by
 * `stop` (by default: its input ended, then SIGTERM) and awaited before the test's directories go.
 */
export function ownChild(t: TestContext, child: ChildProcess, closed: Promise<unknown>, stop = () => { child.stdin?.end(); child.kill(); }): void {
  scope(t).children.push({ child, closed, stop });
}

/** Feeds `onLine` each complete line (without its newline) of the text it is given, however chunks split or merge lines. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let rest = '';
  return chunk => {
    rest += chunk;
    for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
      const line = rest.slice(0, end);
      rest = rest.slice(end + 1);
      onLine(line);
    }
  };
}

/** Calls `onLine` with each complete line of `stream` (UTF-8), however its chunks fall. */
export function readLines(stream: Readable, onLine: (line: string) => void): void {
  stream.setEncoding('utf8');
  stream.on('data', lineSplitter(onLine));
}
