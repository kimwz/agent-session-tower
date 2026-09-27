import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { MasterCallState, MasterTaskState, MasterViewContext } from '../../shared/master.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/** A message from the owner, or news of finished work, waiting for or given to a turn. */
export interface InboxItem {
  id: string;
  kind: 'owner' | 'event';
  clientMessageId?: string;
  /** The text as the model may see it: secrets already replaced by references. */
  text: string;
  /** Typed on this computer itself, as Tower's server judged the request that carried it. */
  local: boolean;
  viewContext?: MasterViewContext;
  at: string;
  state: 'queued' | 'processing' | 'answered' | 'failed' | 'cancelled';
  turnId?: string;
  retries: number;
  /** For events: the task it reports, so one ending is reported once. */
  taskId?: string;
}

/** A change the master sent to Tower. Saved before it is sent, so a restart can tell sent from unsent. */
export interface CallRecord {
  id: string;
  turnId: string;
  inputIds: string[];
  method: string;
  path: string;
  node?: string;
  fingerprint: string;
  state: MasterCallState;
  at: string;
  entryId: string;
  summary?: string;
}

/** Work the master started (a session, a message, an Auto Prompt) that it reports on when it ends. */
export interface TaskRecord {
  id: string;
  entryId: string;
  node?: string;
  sessionId?: string;
  runId?: string;
  jobId?: string;
  title: string;
  /** The request as sent, to find its answer in the session's history. */
  prompt?: string;
  state: MasterTaskState;
  createdAt: string;
  /** When the end was handed to the inbox; set before the event is queued, so it is never queued twice. */
  reportedAt?: string;
}

const KEEP_INBOX = 300;
const KEEP_CALLS = 500;
const KEEP_TASKS = 300;

export const fingerprint = (method: string, path: string, body: unknown) => createHash('sha256').update(JSON.stringify([method, path, body ?? null])).digest('hex');

/**
 * The master's own records, each an owner-only JSON file written whole and in order: the inbox, the calls it made and
 * the work it watches. They are small and bounded.
 */
export class MasterJournal {
  inbox: InboxItem[] = [];
  calls: CallRecord[] = [];
  tasks: TaskRecord[] = [];
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async start(): Promise<void> {
    this.inbox = await load<InboxItem>(join(this.directory, 'inbox.json'));
    this.calls = await load<CallRecord>(join(this.directory, 'calls.json'));
    this.tasks = await load<TaskRecord>(join(this.directory, 'tasks.json'));
  }

  /** Waits until the named records are on disk. A call record must be saved before its request is sent. */
  save(...names: Array<'inbox' | 'calls' | 'tasks'>): Promise<void> {
    const write = async () => {
      for (const name of new Set(names)) {
        const keep = name === 'inbox' ? KEEP_INBOX : name === 'calls' ? KEEP_CALLS : KEEP_TASKS;
        const list = this[name] as Array<{ state?: string }>;
        // Old finished records go first; nothing that still waits or runs is ever dropped.
        while (list.length > keep) {
          const index = list.findIndex(item => !['queued', 'processing', 'sending', 'running'].includes(item.state ?? ''));
          if (index < 0) break;
          list.splice(index, 1);
        }
        await writePrivateJson(join(this.directory, `${name}.json`), JSON.stringify({ items: list }));
      }
    };
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => {});
    return next;
  }
  flush(): Promise<void> { return this.writes; }
}

async function load<T>(path: string): Promise<T[]> {
  try {
    const saved = await readPrivateJson(path) as { items?: unknown };
    return Array.isArray(saved?.items) ? saved.items.filter(item => item && typeof item === 'object') as T[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.error(`Master records in ${path} were unreadable and start empty: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
