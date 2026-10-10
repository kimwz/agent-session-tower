import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { writePrivateJson } from './private-json.js';
import { join } from 'node:path';
import type { Session } from '../../shared/types.js';
import { TowerError } from '../../shared/errors.js';

/** Which conversations the owner closed. Native processes and conversation files are untouched; the worktrees a closed conversation made are removed by the worker. */
export class ClosedSessionStore {
  private readonly path: string;
  private ids = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly stateDir: string) { this.path = join(stateDir, 'closed-sessions.json'); }

  start(): Promise<void> {
    const load = this.writes.then(async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      await this.reload();
    });
    // best-effort: reset only the queue tail so reload can retry; start returns the original rejecting load.
    this.writes = load.then(() => {}, () => {});
    return load;
  }

  private async reload(): Promise<void> {
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 12_000_000) throw new Error('Saved closed sessions are invalid or too large.');
      const saved: unknown = JSON.parse(await file.readFile('utf8'));
      if (!Array.isArray(saved) || saved.some(id => typeof id !== 'string' || !id)) throw new Error('Saved closed sessions are invalid.');
      await file.chmod(0o600);
      this.ids = new Set(saved);
    } finally { await file.close(); }
  }

  closedIds(): ReadonlySet<string> { return new Set(this.ids); }

  apply(session: Session): Session {
    const { closed: _, ...native } = session;
    return this.ids.has(session.id) ? { ...native, closed: true } : native;
  }

  set(session: Session, closed: boolean): Promise<Session> {
    const write = this.writes.then(async () => {
      // An upgrading web may finish its legacy write after this worker loaded the store.
      // Reload within this writer's serial queue so its next write preserves that projection.
      try { await this.reload(); }
      catch (error) { throw new TowerError('unavailable', `세션 표시 상태를 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`); }
      if (this.ids.has(session.id) === closed) return this.apply(session);
      const next = new Set(this.ids);
      if (closed) next.add(session.id); else next.delete(session.id);
      try { await writePrivateJson(this.path, `${JSON.stringify([...next])}\n`); }
      catch (error) {
        throw new TowerError('unavailable', `세션 표시 상태를 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.ids = next;
      return this.apply(session);
    });
    this.writes = write.then(() => {}, () => {});
    return write;
  }

  async flush(): Promise<void> { await this.writes; }
}
