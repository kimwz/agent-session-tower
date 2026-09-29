import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

const VERSION = 1;
const MOST = 50_000;
const MAX_BYTES = 16_000_000;
/** Saves stay well under what loading accepts, so a saved file is never refused as too large. */
const SAVE_BYTES = 12_000_000;
const RETRY_MS = 60_000;
const ID = /^(?:claude|codex):\S{1,200}$/;

/**
 * Which agent session started which non-interactive run, as the live process tree showed it. The proof can only be taken
 * while the run's process is alive, and every release starts a new execution worker, so it is kept on disk: a run that
 * finished before the worker was replaced would otherwise come back as the owner's own session.
 * Each run keeps every session its launching process held, as observed; which of them launched it is decided when linking.
 */
export class LaunchProofFile {
  private writes: Promise<void> = Promise.resolve();
  private retryAt = 0;
  private closed = false;
  /** The latest write failed; the proofs on disk are behind the ones in memory. */
  failed = false;

  constructor(private readonly path: string) {}

  /** A missing, unreadable or invalid file starts empty: the proofs only ever hide sessions, never stop the worker. */
  async load(): Promise<Map<string, string[]>> {
    const proofs = new Map<string, string[]>();
    let saved: unknown;
    try { saved = await readPrivateJson(this.path, MAX_BYTES); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Agent launch proofs were not loaded: ${error instanceof Error ? error.message : String(error)}`);
      return proofs;
    }
    const launches = saved && typeof saved === 'object' && (saved as { version?: unknown }).version === VERSION ? (saved as { launches?: unknown }).launches : undefined;
    if (!launches || typeof launches !== 'object' || Array.isArray(launches)) return proofs;
    for (const [id, launchers] of Object.entries(launches)) {
      if (proofs.size >= MOST) break;
      if (!ID.test(id) || !Array.isArray(launchers) || !launchers.length || launchers.some(launcher => typeof launcher !== 'string' || !ID.test(launcher))) continue;
      proofs.set(id, [...launchers]);
    }
    return proofs;
  }

  /**
   * Queues a write of these proofs, oldest dropped first when they outgrow the file. A failed write is retried at most once a
   * minute unless `now`; answers whether this one was queued.
   */
  save(proofs: ReadonlyMap<string, readonly string[]>, now = false): boolean {
    if (this.closed || (!now && Date.now() < this.retryAt)) return false;
    let entries = [...proofs].slice(-MOST);
    let data = document(entries);
    while (Buffer.byteLength(data) > SAVE_BYTES && entries.length) { entries = entries.slice(Math.ceil(entries.length / 10)); data = document(entries); }
    this.writes = this.writes.then(() => writePrivateJson(this.path, data)).then(() => { this.failed = false; }, error => {
      this.failed = true;
      this.retryAt = Date.now() + RETRY_MS;
      console.error(`Agent launch proofs were not saved: ${error instanceof Error ? error.message : String(error)}`);
    });
    return true;
  }

  /** Resolves once every queued write has finished. */
  flush(): Promise<void> { return this.writes; }

  /** No write is queued after this; one already queued still completes. */
  close(): void { this.closed = true; }
}

function document(entries: ReadonlyArray<readonly [string, readonly string[]]>): string {
  return `${JSON.stringify({ version: VERSION, launches: Object.fromEntries(entries) })}\n`;
}
