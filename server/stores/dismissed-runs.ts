import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Run } from '../../shared/types.js';

/** Display preferences only: raw run history remains available for lifecycle projection. */
export class DismissedRunStore {
  private readonly path: string;
  private ids = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly stateDir: string) {
    this.path = join(stateDir, 'dismissed-runs.json');
  }

  async start(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 12_000_000) throw new Error('Saved dismissed tasks are invalid or too large.');
      const saved: unknown = JSON.parse(await file.readFile('utf8'));
      if (!Array.isArray(saved) || saved.some(id => typeof id !== 'string' || !id)) throw new Error('Saved dismissed tasks are invalid.');
      await file.chmod(0o600);
      this.ids = new Set(saved);
    } finally { await file.close(); }
  }

  visible(runs: readonly Run[]): Run[] {
    return runs.filter(run => !this.ids.has(run.id));
  }

  dismiss(id: string, run: Run | undefined): Promise<void> {
    const write = this.writes.then(async () => {
      // Retain idempotency even after the bounded raw history has aged out this run.
      if (this.ids.has(id)) return;
      if (!run) throw Object.assign(new Error('작업을 찾을 수 없습니다.'), { statusCode: 404 });
      if (run.status !== 'error') throw Object.assign(new Error('실패한 작업만 지울 수 있습니다.'), { statusCode: 409 });
      const next = new Set(this.ids).add(id);
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(`${JSON.stringify([...next])}\n`);
          await file.sync();
        } finally { await file.close(); }
        await rename(temporary, this.path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw Object.assign(new Error(`실패 기록을 지우지 못했습니다: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 503 });
      }
      this.ids = next;
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async flush(): Promise<void> { await this.writes; }
}
