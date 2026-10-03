import { existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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

/**
 * Makes opening exactly `path` fail with EACCES in this test process, for readers that open through
 * `node:fs/promises` (readPrivateJson and readPrivateBytes do). Other paths open as usual. `hits` counts the
 * refused opens, so a test can show the reader was the one refused; the original is back after the test.
 */
export function failOpen(t: TestContext, path: string): { hits: () => number } {
  let hits = 0;
  const original = fsPromises.open;
  fsPromises.open = (async (target: Parameters<typeof original>[0], ...rest: unknown[]) => {
    if (String(target) === path) { hits++; throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES', errno: -13, syscall: 'open', path }); }
    return (original as (...args: unknown[]) => ReturnType<typeof original>)(target, ...rest);
  }) as typeof original;
  syncBuiltinESMExports();
  t.after(() => { fsPromises.open = original; syncBuiltinESMExports(); });
  return { hits: () => hits };
}
