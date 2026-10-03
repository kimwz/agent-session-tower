import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { TestContext } from 'node:test';

/**
 * Makes moving `path` aside fail for root and non-root alike: the clock is held, and the name the file would move to
 * is a folder with something in it. `path` itself stays writable. Call `release()` once the store has started.
 */
export async function blockQuarantine(t: TestContext, path: string): Promise<{ aside: string; release: () => void }> {
  const now = Date.now();
  const aside = `${path}.unreadable-${now}`;
  await mkdir(aside);
  await writeFile(`${aside}/occupied`, '');
  const clock = t.mock.method(Date, 'now', () => now);
  return { aside, release: () => clock.mock.restore() };
}

/**
 * Records `console.error` calls during a test, each with whether `path` still existed when it was logged, so a test
 * can tell a line logged before the move from one logged after it.
 */
export function captureErrors(t: TestContext, path: string): Array<{ args: unknown[]; present: boolean }> {
  const calls: Array<{ args: unknown[]; present: boolean }> = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { calls.push({ args, present: existsSync(path) }); });
  return calls;
}

/** The names `path` was moved aside to, beside it. */
export async function asideNames(path: string): Promise<string[]> {
  const prefix = `${basename(path)}.unreadable-`;
  return (await readdir(dirname(path))).filter(name => name.startsWith(prefix));
}
