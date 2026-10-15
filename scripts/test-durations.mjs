import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

/**
 * A node:test reporter that writes one JSON line per finished test: its file, nesting, name, duration and result. CI
 * lanes run it beside the TAP reporter (scripts/ci-run.mjs) and report the tests that took a second or more.
 */
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data;
    yield `${JSON.stringify({ file: data.file, nesting: data.nesting, name: data.name, ms: data.details?.duration_ms,
      ok: event.type === 'test:pass', kind: data.details?.type })}\n`;
  }
}

/** Tests (not suites or files) of a reporter output that took at least `thresholdMs`, slowest first, files relative to `root`. */
export function slowTests(path, root = process.cwd(), thresholdMs = 1000) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const slow = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.kind !== 'test' || !Number.isFinite(row.ms) || row.ms < thresholdMs) continue;
    slow.push({ file: row.file ? relative(root, row.file).split('\\').join('/') : undefined, name: row.name, ms: Math.round(row.ms), ok: row.ok });
  }
  return slow.sort((a, b) => b.ms - a.ms);
}
