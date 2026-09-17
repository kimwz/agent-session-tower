import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from '../../shared/types.js';
import { defaultStateDir } from '../state-dir.js';

export function normalizeSessionTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length > 120) {
    throw Object.assign(new Error('제목은 120자 이하의 문자열이어야 합니다.'), { statusCode: 400 });
  }
  return value.trim();
}

/** Monitor-owned labels. The state-directory lock keeps other monitor processes out. */
export class SessionTitleStore {
  private readonly path: string;
  private titles = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly stateDir = defaultStateDir()) {
    this.path = join(stateDir, 'session-titles.json');
  }

  async start(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 12_000_000) throw new Error('Saved session titles are invalid or too large.');
      const saved: unknown = JSON.parse(await file.readFile('utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Saved session titles are invalid.');
      const titles = new Map<string, string>();
      for (const [id, value] of Object.entries(saved)) {
        if (typeof value !== 'string' || value.trim().length > 120) throw new Error('Saved session titles are invalid.');
        titles.set(id, value.trim());
      }
      await file.chmod(0o600);
      this.titles = titles;
    } finally { await file.close(); }
  }

  apply(session: Session): Session {
    const { customTitle: initialTitle, ...native } = session;
    // A name supplied at creation belongs to the atomic creation registry. An
    // explicit empty override restores the native title without a second
    // cross-file transaction or resurrecting that initial name after restart.
    const customTitle = this.titles.get(session.id) ?? initialTitle;
    return customTitle ? { ...native, customTitle } : native;
  }

  set(session: Session, value: unknown): Promise<Session> {
    const title = normalizeSessionTitle(value);
    const write = this.writes.then(async () => {
      // Build each new document after preceding writes commit, avoiding lost updates.
      const next = new Map(this.titles);
      if (title || session.customTitle) next.set(session.id, title);
      else next.delete(session.id);
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(`${JSON.stringify(Object.fromEntries(next))}\n`);
          await file.sync();
        } finally { await file.close(); }
        await rename(temporary, this.path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw Object.assign(new Error(`제목을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 503 });
      }
      this.titles = next;
      return this.apply(session);
    });
    // Failed writes are reported to their caller but do not block subsequent saves.
    this.writes = write.then(() => {}, () => {});
    return write;
  }

  async flush(): Promise<void> { await this.writes; }
}
