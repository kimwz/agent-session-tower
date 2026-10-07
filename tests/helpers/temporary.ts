import assert from 'node:assert/strict';
import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerDirectoryForCanonicalState } from '../../server/runs/runner-protocol.js';

const fixtures = new Map<string, { canonical: string; released: boolean }>();
/** The fixture owns its root and all state directories it makes beneath it; no production path is admitted. */
export async function temporaryFixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const canonical = await realpath(root);
  const record = { canonical, released: false }; fixtures.set(root, record); fixtures.set(canonical, record);
  return root;
}
/** Call only after fixture clients, hosts, streams and endpoint keepers have settled. Never calls a creating path lookup. */
export async function removeTemporaryFixture(root: string): Promise<void> {
  const record = fixtures.get(root);
  if (!record) throw new Error('Temporary fixture ownership is not registered.');
  const { canonical } = record;
  if (record.released) { await assert.rejects(lstat(canonical), { code: 'ENOENT' }, 'a released fixture path must not be reused'); return; }
  const directories = new Set([canonical]);
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) { const child = join(path, entry.name); directories.add(child); await walk(child); }
  };
  try { await walk(canonical); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const siblings = [...directories].map(runnerDirectoryForCanonicalState);
  for (const sibling of siblings) await rm(sibling, { recursive: true, force: true });
  await rm(canonical, { recursive: true, force: true });
  for (const path of [canonical, ...siblings]) await assert.rejects(lstat(path), { code: 'ENOENT' }, 'fixture teardown leaves no state or runner sibling');
  record.released = true;
}
