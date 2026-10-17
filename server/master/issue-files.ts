import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TODO_MASTER_TASK_ID } from '../../shared/master.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { issueDataDir } from './paths.js';

/** An issue master's follow file is cleared away this long after its session was closed (or went away). */
export const KEEP_CLOSED_MS = 30 * 24 * 60 * 60_000;

/** What the issue masters' follow files say, read without the master host (the web reads them too). */
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

/**
 * Clears away issue masters' data closed for long enough, and a folder with nothing readable left untouched as long.
 * The web runs it as well as the host, so nothing waits for a host that no longer starts. `following` names the todos
 * the host follows now, whose files it leaves alone; `markOpen` marks a file still open whose session is gone.
 */
export async function clearClosedIssueFiles(masterData: string, options: { following?: (taskId: string) => boolean; markOpen?: boolean } = {}): Promise<void> {
  await eachIssueFile(masterData, async (taskId, folder, saved) => {
    if (options.following?.(taskId)) return;
    const closedAt = typeof saved?.closedAt === 'string' ? Date.parse(saved.closedAt) : NaN;
    if (Number.isFinite(closedAt)) {
      if (Date.now() - closedAt >= KEEP_CLOSED_MS) await rm(folder, { recursive: true, force: true });
    } else if (saved?.version === 1) {
      if (options.markOpen) await writePrivateJson(join(folder, 'follow.json'), JSON.stringify({ ...saved, closedAt: new Date().toISOString() }));
    } else {
      const changed = await stat(folder).then(info => info.mtimeMs, () => Date.now());
      if (Date.now() - changed >= KEEP_CLOSED_MS) await rm(folder, { recursive: true, force: true });
    }
  });
}
