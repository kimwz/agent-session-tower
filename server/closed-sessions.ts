import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from '../shared/types.js';

/** Monitor display state only. Native processes and conversation files are untouched. */
export class ClosedSessionStore {
  private readonly path: string;
  private ids = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly stateDir: string) { this.path = join(stateDir, 'closed-sessions.json'); }

  async start(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
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

  apply(session: Session): Session {
    const { closed: _, ...native } = session;
    return this.ids.has(session.id) ? { ...native, closed: true } : native;
  }

  set(session: Session, closed: boolean): Promise<Session> {
    const write = this.writes.then(async () => {
      if (this.ids.has(session.id) === closed) return this.apply(session);
      const next = new Set(this.ids);
      if (closed) next.add(session.id); else next.delete(session.id);
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(`${JSON.stringify([...next])}\n`); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw Object.assign(new Error(`세션 표시 상태를 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 503 });
      }
      this.ids = next;
      return this.apply(session);
    });
    this.writes = write.then(() => {}, () => {});
    return write;
  }

  async flush(): Promise<void> { await this.writes; }
}
