import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TODO_MASTER_TASK_ID } from '../../shared/master.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { issueDataDir } from './paths.js';

/** An issue master's follow file is cleared away this long after its session was closed (or went away). */
export const KEEP_CLOSED_MS = 30 * 24 * 60 * 60_000;

/** What the issue masters' follow files say, read without the master host (the web reads them too, never writes). */
interface SavedFollow { version?: unknown; closedAt?: unknown; followed?: unknown }

async function eachIssueFile(masterData: string, visit: (taskId: string, folder: string, saved: SavedFollow | undefined) => Promise<boolean | void>): Promise<boolean> {
  const root = issueDataDir(masterData);
  for (const taskId of await readdir(root).catch(() => [] as string[])) {
    if (!TODO_MASTER_TASK_ID.test(taskId)) continue;
    const folder = join(root, taskId);
    // best-effort: a file that cannot be read is judged by its folder alone.
    const saved = await readPrivateJson(join(folder, 'follow.json')).catch(() => undefined) as SavedFollow | undefined;
    if (await visit(taskId, folder, saved && typeof saved === 'object' ? saved : undefined)) return true;
  }
  return false;
}

/**
 * Whether an issue master needs the host: its session was open when the host last looked (the host marks a file
 * `closedAt` when the session is closed or gone). A closed one's undelivered reports do not count: a closed session
 * is never reported to, so they could not go anyway.
 */
export function issueMastersPending(masterData: string): Promise<boolean> {
  return eachIssueFile(masterData, async (_taskId, _folder, saved) => saved?.version === 1 && typeof saved.closedAt !== 'string');
}

/** Whether an issue master's data is due to be cleared away: closed long enough, or nothing readable left as long. */
async function expired(folder: string, saved: SavedFollow | undefined): Promise<boolean> {
  const closedAt = typeof saved?.closedAt === 'string' ? Date.parse(saved.closedAt) : NaN;
  if (Number.isFinite(closedAt)) return Date.now() - closedAt >= KEEP_CLOSED_MS;
  if (saved?.version === 1) return false;
  const changed = await stat(folder).then(info => info.mtimeMs, () => Date.now());
  return Date.now() - changed >= KEEP_CLOSED_MS;
}

/**
 * Takes away the guides Tower wrote into an issue master's folder (CLAUDE.md, AGENTS.md), and the folder if nothing
 * else is left in it. Anything else there (a file the master made) stays, with its folder.
 */
async function removeGuides(folder: string): Promise<void> {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) await rm(join(folder, name), { force: true });
  await rmdir(folder).catch((error: NodeJS.ErrnoException) => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error; });
}

/** Whether some issue master's data is due to be cleared away, so the web brings the host to do it. */
export function issueFilesExpired(masterData: string): Promise<boolean> {
  return eachIssueFile(masterData, (_taskId, folder, saved) => expired(folder, saved));
}

/**
 * Clears away issue masters' data due to go. Only the host does this, between its looks at Tower, so no issue master
 * is opened meanwhile; it leaves alone the todos it follows (`following`), and marks a file still open whose session
 * is gone (`markOpen`), which is then cleared away 30 days on.
 */
export async function clearClosedIssueFiles(masterData: string, options: { following: (taskId: string) => boolean; markOpen?: boolean; guides?: (taskId: string) => string }): Promise<void> {
  await eachIssueFile(masterData, async (taskId, folder, saved) => {
    if (options.following(taskId)) return;
    if (await expired(folder, saved)) {
      await rm(folder, { recursive: true, force: true });
      if (options.guides) await removeGuides(options.guides(taskId));
    }
    else if (options.markOpen && saved?.version === 1 && typeof saved.closedAt !== 'string') {
      await writePrivateJson(join(folder, 'follow.json'), JSON.stringify({ ...saved, closedAt: new Date().toISOString() }));
    }
  });
}
